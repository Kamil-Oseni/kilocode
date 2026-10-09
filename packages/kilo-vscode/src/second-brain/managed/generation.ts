import path from "node:path"
import { mkdir, open } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { check, child, document, sha } from "../control/frames"
import { directory, environment, image, normalize, powershell } from "../control/identity"
import { command } from "../control/command"
import { descriptor, type Descriptor } from "./descriptor"
import type { Launch } from "./restart"
import { release } from "../control/catalog-v2"

type Space = Descriptor["namespaces"]["memory"]

function location(cfg: Descriptor, launch: Launch) {
  check(
    normalize(launch.root).startsWith(normalize(cfg.root) + "/") &&
      /^[a-f0-9]{32}$/.test(path.basename(launch.root)) &&
      path.basename(path.dirname(launch.root)) === "Runs",
    "Selected launch generation location required",
  )
}

/** Create one new protected namespace; callers retain its exact selected root and owner. */
export async function space(root: string, sid: string) {
  check(path.isAbsolute(root) && /^S-1-\d+(?:-\d+)+$/.test(sid), "Exact namespace root and Windows owner required")
  await mkdir(root)
  await directory(root)
  const script = `$ErrorActionPreference='Stop';$dir=Get-Item -LiteralPath '${root.replace(/'/g, "''")}';if(@(Get-ChildItem -LiteralPath $dir.FullName -Force).Count){throw 'New empty namespace required'};$node=$dir;while($node){if($node -isnot [IO.DirectoryInfo] -or ($node.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Ordinary namespace required'};$node=$node.Parent};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;if($sid.Value -cne '${sid}'){throw 'Selected namespace owner differs'};$flags=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetGroup($sid);$acl.SetAccessRuleProtection($true,$false);foreach($value in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($value),[Security.AccessControl.FileSystemRights]::FullControl,$flags,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))};Set-Acl -LiteralPath $dir.FullName -AclObject $acl;$actual=Get-Acl -LiteralPath $dir.FullName;$rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value -or $rules.Count -ne 3 -or @($rules.IdentityReference.Value|Select-Object -Unique).Count -ne 3){throw 'Namespace protection differs'};foreach($rule in $rules){if($rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544') -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $flags -or $rule.PropagationFlags -ne 'None' -or $rule.IsInherited){throw 'Namespace rights differ'}}`
  await command(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, env: environment() },
  )
  await mkdir(path.join(root, "Runs"))
  await mkdir(path.join(root, "Requests"))
  return { root, sid }
}

function text(space: Space) {
  return (
    "{" +
    Object.entries(space.generations)
      .map(([name, tuple]) => JSON.stringify(name) + ":[" + tuple.join(",") + "]")
      .join(",") +
    "}"
  )
}

function environmentFor(space: Space, prefix: string) {
  return {
    [prefix + "_ROOT"]: space.root,
    [prefix + "_SID"]: space.sid,
    [prefix + "_GENERATIONS"]: text(space),
  }
}

/** Replace only selected namespace metadata, retaining every other original JSON integer token. */
export function project(raw: Buffer, kind: "memory" | "retrieval", namespaces: Descriptor["namespaces"], dirs: string) {
  const parsed = document(raw, 16777216, 1000000)
  const value = parsed.value as Record<string, unknown>
  check(value.kind === kind, "Selected plan kind differs")
  const env = value.env as Record<string, unknown>
  const next = {
    ...env,
    ...environmentFor(namespaces[kind], kind === "memory" ? "RAYA_MEMORY_OPERATION" : "RAYA_RETRIEVAL_RECEIPT"),
  }
  const nodes = [
    { node: child(parsed.tree, "env"), text: JSON.stringify(next) },
    { node: child(parsed.tree, "directories"), text: dirs },
    ...(kind === "memory"
      ? [
          {
            node: child(parsed.tree, "retrieval_selection"),
            text: JSON.stringify(environmentFor(namespaces.retrieval, "RAYA_RETRIEVAL_RECEIPT")),
          },
        ]
      : []),
  ].sort((a, b) => b.node.offset - a.node.offset)
  let result = parsed.text
  for (const item of nodes)
    result = result.slice(0, item.node.offset) + item.text + result.slice(item.node.offset + item.node.length)
  return Buffer.from(result)
}

async function save(file: string, raw: Buffer) {
  check(raw.length <= 16777216, "Derived launch plan exceeds bound")
  const held = await open(file, "wx", 0o600)
  try {
    await held.writeFile(raw)
    await held.sync()
  } finally {
    await held.close()
  }
  const result = await image(file, 16777216)
  check(result.digest === sha(raw) && result.raw.equals(raw), "Derived plan readback differs")
  return Object.freeze({ path: file, bytes: raw.length, sha256: result.digest })
}

async function observe(cfg: Descriptor, launch: Launch, roots: Record<string, { root: string; sid: string }>) {
  const source = path.join(cfg.root, "source", "memory", "namespace.py")
  const pinned = await image(source, 65536)
  check(pinned.digest === release["namespace.py"], "Reviewed namespace observer required")
  const script = `import hashlib,json,pathlib,sys
source=pathlib.Path(sys.argv[1]);raw=source.read_bytes()
if hashlib.sha256(raw).hexdigest()!=sys.argv[2]: raise ValueError('selected_namespace_changed')
module={'__name__':'selected_namespace','__file__':str(source)}
exec(compile(raw,str(source),'exec'),module)
roots=json.loads(sys.argv[3]);namespaces={};directories=[]
paths=[pathlib.Path(sys.argv[4])]
for kind,value in roots.items():
 root=pathlib.Path(value['root']);generations={name:module['generation'](root if name=='root' else root/name) for name in ('root','Runs','Requests')}
 module['Namespace'](root,value['sid'],generations)
 namespaces[kind]={**value,'generations':{name:[str(x) for x in row] for name,row in generations.items()}}
 paths.extend((root,root/'Runs',root/'Requests'))
for path in paths:
 info=path.lstat();directories.append({'path':str(path),'identity':[str(info.st_dev),str(info.st_ino),str(info.st_ctime_ns)]})
print(json.dumps({'namespaces':namespaces,'directories':directories},separators=(',',':')))`
  const result = await command(
    cfg.python.path,
    ["-I", "-S", "-B", "-c", script, source, pinned.digest, JSON.stringify(roots), launch.root],
    { windowsHide: true, env: { ...environment(), TEMP: launch.root, TMP: launch.root } },
  )
  const value = document(Buffer.from(result.stdout.trim()), 65536).value as unknown as {
    namespaces: Descriptor["namespaces"]
    directories: { path: string; identity: string[] }[]
  }
  check(
    value.directories.length === 7 &&
      value.directories.every(
        (item) =>
          item.identity.length === 3 &&
          item.identity.every((entry) => /^(0|[1-9]\d{0,19})$/.test(entry) && BigInt(entry) <= 0xffffffffffffffffn),
      ),
    "Native generation strings required",
  )
  return value
}

/** Read-only reconstruction proves a successor changed only its reviewed native request namespaces. */
export async function review(cfg: Descriptor, launch: Launch, current: Descriptor, files: readonly { raw: Buffer }[]) {
  location(cfg, launch)
  check(
    isDeepStrictEqual({ ...current, plan: cfg.plan, retrieval: cfg.retrieval, namespaces: cfg.namespaces }, cfg),
    "Successor changed immutable runtime selection",
  )
  for (const kind of ["memory", "retrieval"] as const)
    check(
      current.namespaces[kind].root === path.join(launch.root, kind) &&
        current.namespaces[kind].sid === cfg.namespaces[kind].sid,
      "Successor native namespace location differs",
    )
  check(
    current.plan.path === path.join(launch.root, "memory-plan.json") &&
      current.retrieval?.path === path.join(launch.root, "retrieval-plan.json"),
    "Successor plan location differs",
  )
  const observed = await observe(cfg, launch, current.namespaces)
  check(
    isDeepStrictEqual(JSON.parse(JSON.stringify(observed.namespaces)), current.namespaces),
    "Successor native namespace witnesses differ",
  )
  const dirs = directories(files[2].raw, observed.directories)
  for (const [index, kind] of ["memory", "retrieval"].entries()) {
    const ref = kind === "memory" ? current.plan : current.retrieval!
    const selected = await image(ref.path, 16777216)
    check(
      selected.digest === ref.sha256 &&
        selected.raw.length === ref.bytes &&
        project(files[index + 2].raw, kind as "memory" | "retrieval", current.namespaces, dirs).equals(selected.raw),
      "Successor changed unrelated original plan bytes",
    )
  }
  return Object.freeze({ namespaces: current.namespaces, directories: observed.directories })
}

function directories(raw: Buffer, additions: { path: string; identity: string[] }[]) {
  const parsed = document(raw, 16777216, 1000000)
  const node = child(parsed.tree, "directories")
  check(node.type === "array", "Original directory inventory required")
  const values = additions.map(
    (item) => '{"path":' + JSON.stringify(item.path) + ',"identity":[' + item.identity.join(",") + "]}",
  )
  const original = parsed.text.slice(node.offset, node.offset + node.length)
  return original.slice(0, -1) + (node.children?.length ? "," : "") + values.join(",") + "]"
}

/** Creation is never resumed or replayed: any partial generation remains an exclusive sticky collision. */
export async function generation(cfg: Descriptor, launch: Launch, files: readonly { raw: Buffer }[]) {
  location(cfg, launch)
  return create(cfg, launch, files)
}

/** Explicit administrative fresh-start metadata must remain outside every historical request namespace. */
export async function fresh(cfg: Descriptor, root: string, files: readonly { raw: Buffer }[]) {
  check(
    normalize(path.dirname(root)) === normalize(cfg.root) &&
      /^raya-memory-fresh-[a-f0-9]{32}$/.test(path.basename(root)),
    "Explicit fresh generation location required",
  )
  for (const prior of Object.values(cfg.namespaces))
    check(
      !normalize(root).startsWith(normalize(prior.root) + "/") && normalize(root) !== normalize(prior.root),
      "Fresh generation cannot adopt a historical namespace",
    )
  return create(cfg, { root }, files)
}

async function create(cfg: Descriptor, launch: Launch, files: readonly { raw: Buffer }[]) {
  await directory(path.dirname(launch.root))
  await mkdir(launch.root)
  await directory(launch.root)
  const roots = {
    memory: await space(path.join(launch.root, "memory"), cfg.namespaces.memory.sid),
    retrieval: await space(path.join(launch.root, "retrieval"), cfg.namespaces.retrieval.sid),
  }
  const observed = await observe(cfg, launch, roots)
  const namespaces = observed.namespaces
  const dirs = directories(files[2].raw, observed.directories)
  const plan = await save(path.join(launch.root, "memory-plan.json"), project(files[2].raw, "memory", namespaces, dirs))
  const retrieval = await save(
    path.join(launch.root, "retrieval-plan.json"),
    project(files[3].raw, "retrieval", namespaces, dirs),
  )
  return descriptor({ ...cfg, plan, retrieval, namespaces })
}
