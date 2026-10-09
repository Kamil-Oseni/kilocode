import { afterAll, beforeAll, expect, test } from "bun:test"
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { materialize } from "../../src/second-brain/managed/materialize"
import { review } from "../../src/second-brain/managed/upgrade-review"
import { publish } from "../../src/second-brain/managed/upgrade-publish"
import { descriptor, paired, selection, type Descriptor } from "../../src/second-brain/managed/descriptor"
import { current, retrieval } from "../../src/second-brain/managed/catalog"
import { images, fingerprint } from "../../src/second-brain/managed/reuse-catalog"
import { release, bridge } from "../../src/second-brain/control/catalog-capture"
import { fingerprint as digest } from "../../src/second-brain/failed-repair"
import { protect } from "../../src/second-brain/control/protection"
import { protection } from "../../src/second-brain/managed/protection"
import { command } from "../../src/second-brain/control/command"
import { image, powershell, environment } from "../../src/second-brain/control/identity"
import { parse, type Setup } from "../../src/second-brain/settings"

const base = "D:/Raya/Services/Packaging/Python/3.12.14"
let outer: string
let cfg: Descriptor
let setup: Setup

beforeAll(async () => {
  outer = await mkdtemp(path.join(os.tmpdir(), "raya-memory-control-materialize-"))
  await protect(outer)
  const root = path.join(outer, "raya-memory-managed-materialize")
  await mkdir(root)
  const acl = `$ErrorActionPreference='Stop';$acl=Get-Acl -LiteralPath '${outer.replace(/'/g, "''")}';Set-Acl -LiteralPath '${root.replace(/'/g, "''")}' -AclObject $acl`
  await command(
    powershell(),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(acl, "utf16le").toString("base64")],
    { windowsHide: true, env: environment() },
  )
  const sid = await protection(root)
  await Promise.all(
    [
      "python",
      "source/memory",
      "source/retrieval",
      "deps",
      "home",
      "cache",
      "tokens",
      "memory/Runs",
      "memory/Requests",
      "retrieval/Runs",
      "retrieval/Requests",
    ].map((name) => mkdir(path.join(root, name), { recursive: true })),
  )
  await Promise.all(
    ["python.exe", "python3.dll", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll"].map((name) =>
      copyFile(path.join(base, name), path.join(root, "python", name)),
    ),
  )
  await Promise.all(
    ["Lib", "DLLs"].map((name) =>
      cp(path.join(base, name), path.join(root, "python", name), {
        recursive: true,
        filter: (file) => !file.includes("site-packages") && !file.includes("__pycache__"),
      }),
    ),
  )
  await Promise.all(
    Object.keys(release).map((name) =>
      copyFile(path.resolve("script/memory/service", name), path.join(root, "source/memory", name)),
    ),
  )
  await Promise.all(
    Object.keys(retrieval).map((name) =>
      copyFile(path.resolve("script/memory/retrieval", name), path.join(root, "source/retrieval", name)),
    ),
  )
  await copyFile(path.resolve("script/memory/supervise.py"), path.join(root, "source/supervise.py"))
  await writeFile(path.join(root, "deps", "admitted.txt"), "synthetic nonmodel dependency")
  await writeFile(path.join(root, "protection.json"), JSON.stringify({ passed: true, root }))
  const body = `import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);sid=sys.argv[2];pins=json.loads(sys.argv[3]);retrieval=json.loads(sys.argv[4])
def ref(file):
 raw=file.read_bytes();return {'path':str(file),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
def image(file):
 info=file.lstat();return {**ref(file),'identity':[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink]}
def generations(folder):
 result={}
 for name in ('root','Runs','Requests'):
  info=(folder if name=='root' else folder/name).lstat();result[name]=[info.st_dev,info.st_ino,info.st_birthtime_ns]
 return result
spaces={kind:{'root':str(root/kind),'sid':sid,'generations':generations(root/kind)} for kind in ('memory','retrieval')}
files=[image(root/'source'/'memory'/name) for name in pins]+[image(root/'source'/'retrieval'/name) for name in retrieval]+[image(root/'python'/'python.exe'),image(root/'source'/'supervise.py'),image(root/'deps'/'admitted.txt')]
directories=[]
for folder in [root,root/'source',root/'source'/'memory',root/'source'/'retrieval',root/'deps']:
 info=folder.lstat();directories.append({'path':str(folder),'identity':[info.st_dev,info.st_ino,info.st_ctime_ns]})
common={'format':'raya.memory.managed.supervisor','version':1,'execution_admitted':True,'root':str(root),'files':files,'directories':directories,'python_sha256':ref(root/'python'/'python.exe')['sha256'],'dependencies':str(root/'deps'),'protection':{'path':str(root/'protection.json'),'sha256':ref(root/'protection.json')['sha256']}}
private={'HOME':str(root/'home'),'USERPROFILE':str(root/'home'),'TEMP':str(root/'cache'),'TMP':str(root/'cache'),'HF_HOME':str(root/'cache'),'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','PYTHONDONTWRITEBYTECODE':'1'}
namespace={'RAYA_RETRIEVAL_RECEIPT_ROOT':spaces['retrieval']['root'],'RAYA_RETRIEVAL_RECEIPT_SID':sid,'RAYA_RETRIEVAL_RECEIPT_GENERATIONS':json.dumps(spaces['retrieval']['generations'],separators=(',',':'))}
memory={**common,'kind':'memory','source':str(root/'source'/'memory'),'source_sha256':pins,'port':58741,'retrieval_selection':namespace,'env':{**private,'RAYA_MEMORY_ROOT':str(root),'RAYA_MEMORY_PORT':'58741','RAYA_RETRIEVAL_PORT':'58742','RAYA_MEMORY_TOKEN_FILE':str(root/'tokens'/'memory.token'),'RAYA_MEMORY_RETRIEVAL_TOKEN_FILE':str(root/'tokens'/'retrieval.token'),'RAYA_MEMORY_OPERATION_ROOT':spaces['memory']['root'],'RAYA_MEMORY_OPERATION_SID':sid,'RAYA_MEMORY_OPERATION_GENERATIONS':json.dumps(spaces['memory']['generations'],separators=(',',':'))}}
other={**common,'kind':'retrieval','source':str(root/'source'/'retrieval'),'source_sha256':retrieval,'port':58742,'env':{**private,**namespace,'RAYA_RETRIEVAL_PORT':'58742','RAYA_RETRIEVAL_TOKEN_FILE':str(root/'tokens'/'retrieval.token')}}
for name,plan in (('memory-plan.json',memory),('retrieval-plan.json',other)): (root/name).write_text(json.dumps(plan,separators=(',',':')),encoding='utf-8')
for space in spaces.values(): space['generations']={name:[str(value) for value in row] for name,row in space['generations'].items()}
cfg={'format':'raya.memory.managed.launch','version':2,'root':str(root),'python':ref(root/'python'/'python.exe'),'supervisor':ref(root/'source'/'supervise.py'),'plan':ref(root/'memory-plan.json'),'retrieval':ref(root/'retrieval-plan.json'),'namespaces':spaces}
print(json.dumps(cfg,separators=(',',':')))`
  const output = await command(
    path.join(root, "python/python.exe"),
    ["-I", "-S", "-B", "-c", body, root, sid, JSON.stringify(release), JSON.stringify(retrieval)],
    { windowsHide: true },
  )
  cfg = descriptor(JSON.parse(output.stdout))
  setup = parse({
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    origin: "http://127.0.0.1:58741",
    root,
    source_sha256: release,
  })
}, 30000)

afterAll(async () => {
  if (!outer) return
  expect(path.dirname(outer)).toBe(os.tmpdir())
  expect(path.basename(outer).startsWith("raya-memory-control-materialize-")).toBe(true)
  await rm(outer, { recursive: true })
})

test("materialize retains old native images and creates qualified independent plans/namespaces with no models", async () => {
  const original = await selection(cfg, setup)
  const next = await materialize(cfg, setup, path.resolve("."), "a".repeat(32))
  const result = await selection(next.next.managed, next.next.setup)
  expect(next.source).toBe(path.join(cfg.root, "raya-memory-source-upgrade-" + "a".repeat(32)))
  expect(next.next.managed.supervisor.sha256).toBe(current)
  expect(next.next.managed.namespaces).not.toEqual(cfg.namespaces)
  expect(next.next.setup.source_sha256).toEqual(release)
  expect(result.plan.source).toBe(next.source)
  expect(result.plan.files).toEqual(result.retrieval!.files)
  expect(result.plan.directories).toEqual(result.retrieval!.directories)
  expect(result.retrieval!.source).toBe(original.retrieval!.source)
  expect(result.retrieval!.source_sha256).toEqual(original.retrieval!.source_sha256)
  const after = await selection(cfg, setup)
  expect(after.files.map((item) => item.tuple)).toEqual(original.files.map((item) => item.tuple))
  expect(after.files.map((item) => item.digest)).toEqual(original.files.map((item) => item.digest))
  expect(next.producer).toMatchObject({
    code: 0,
    stdoutEOF: true,
    stderrEOF: true,
    originalJoined: true,
    readersJoined: true,
    forced: false,
    observationExpired: false,
  })
  expect(next.requestSettlement).toBe(false)
  expect(next.replay).toBe(false)
  expect(next.indexConfirmed).toBe(false)
  expect((await image(next.receipt.path)).digest).toBe(next.receipt.sha256)
  const reviewed = await review(next.receipt, { setup, managed: cfg })
  expect(reviewed.next).toEqual(next.next)
  expect(reviewed.producer).toMatchObject({ code: 0, originalJoined: true, readersJoined: true, forced: false })
  await expect(review({ ...next.receipt, sha256: "f".repeat(64) }, { setup, managed: cfg })).rejects.toThrow(
    "Prepared upgrade receipt changed",
  )
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('actual_upgrade_supervisor',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for file,digest in json.loads(sys.argv[2]): module.load(file,digest,True)
assert not any(name in sys.modules for name in ('torch','transformers','scipy','sklearn'))
print('two-native-plans-qualified-without-models')`
  const observed = await command(
    cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      script,
      next.next.managed.supervisor.path,
      JSON.stringify([next.next.managed.plan, next.next.managed.retrieval!].map((item) => [item.path, item.sha256])),
    ],
    { windowsHide: true },
  )
  expect(observed.stdout.trim()).toBe("two-native-plans-qualified-without-models")
  await expect(materialize(cfg, setup, path.resolve("."), "a".repeat(32))).rejects.toThrow()
  const collision = path.join(cfg.root, "raya-memory-source-upgrade-" + "b".repeat(32))
  await mkdir(collision)
  await writeFile(path.join(collision, "retain.txt"), "original collision")
  await expect(materialize(cfg, setup, path.resolve("."), "b".repeat(32))).rejects.toThrow()
  expect(await readFile(path.join(collision, "retain.txt"), "utf8")).toBe("original collision")
  expect(
    await stat(path.join(cfg.root, "raya-memory-fresh-" + "b".repeat(32))).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  for (const source of [
    path.join(cfg.root, "foreign"),
    path.join(cfg.root, "raya-memory-source-upgrade-" + "f".repeat(32)),
  ])
    expect(() => paired(next.next.managed, { ...result.plan, source }, result.retrieval!)).toThrow()
  const altered = await materialize(cfg, setup, path.resolve("."), "d".repeat(32))
  const plan = altered.next.managed.plan
  const raw = (await readFile(plan.path, "utf8")).replace(
    '"HOME":' + JSON.stringify(path.join(cfg.root, "home")),
    '"HOME":' + JSON.stringify(path.join(cfg.root, "foreign-home")),
  )
  await writeFile(plan.path, raw)
  const changed = await image(plan.path, 16777216)
  const value = JSON.parse(await readFile(altered.receipt.path, "utf8")) as Omit<typeof altered, "receipt">
  await writeFile(
    altered.receipt.path,
    JSON.stringify({
      ...value,
      next: {
        ...value.next,
        managed: {
          ...value.next.managed,
          plan: { path: plan.path, bytes: changed.raw.length, sha256: changed.digest },
        },
      },
    }),
  )
  const metadata = await image(altered.receipt.path)
  await expect(
    review(
      { path: altered.receipt.path, bytes: metadata.raw.length, sha256: metadata.digest },
      { setup, managed: cfg },
    ),
  ).rejects.toThrow("Derived upgrade plan changed unrelated original bytes")
}, 30000)

test("reusable v2 upgrade retains its independent release and external notes witness", async () => {
  const notes = path.join(outer, "external-notes")
  await mkdir(path.join(notes, "System"), { recursive: true })
  await writeFile(path.join(notes, "README.md"), "# Retained synthetic external note\n")
  for (const name of Object.keys(images)) {
    const file = path.join(cfg.root, "source", name)
    await mkdir(path.dirname(file), { recursive: true })
    if (name.startsWith("retrieval_reuse/")) await copyFile(path.join("script/memory", name), file)
  }
  const script = `import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);notes=pathlib.Path(sys.argv[2]);pins=json.loads(sys.argv[3]);release=sys.argv[4]
memory=json.loads((root/'memory-plan.json').read_bytes());other=json.loads((root/'retrieval-plan.json').read_bytes());files=list(memory['files']);directories=list(memory['directories'])
for name,digest in pins.items():
 file=root/'source'/name
 if name.startswith('retrieval_reuse/'):
  raw=file.read_bytes();info=file.lstat();assert hashlib.sha256(raw).hexdigest()==digest
  files.append({'path':str(file),'bytes':len(raw),'sha256':digest,'identity':[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink]})
folder=root/'source'/'retrieval_reuse';info=folder.lstat();directories.append({'path':str(folder),'identity':[info.st_dev,info.st_ino,info.st_ctime_ns]})
generations={}
for name,file in (('root',notes),('system',notes/'System')):
 info=file.lstat();generations[name]=[info.st_dev,info.st_ino,info.st_birthtime_ns]
memory.update(files=files,directories=directories,notes_selection={'root':str(notes),'system':str(notes/'System'),'generations':{name:[str(value) for value in row] for name,row in generations.items()}})
memory['env'].update(RAYA_MEMORY_ROOT=str(notes),RAYA_MEMORY_NOTE_GENERATIONS=json.dumps(generations,separators=(',',':')),RAYA_MEMORY_RETRIEVAL_PROTOCOL='raya.retrieval.request.settlement.v2',RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256=release)
other.update(files=files,directories=directories,source=str(root/'source'),source_sha256=pins,retrieval_protocol='raya.retrieval.request.settlement.v2')
other['env']['RAYA_RETRIEVAL_RELEASE_SHA256']=release
result={}
for name,value in (('memory-v2-plan.json',memory),('retrieval-v2-plan.json',other)):
 file=root/name;raw=json.dumps(value,separators=(',',':')).encode();file.write_bytes(raw);result[name]={'path':str(file),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
result['notes']=memory['notes_selection'];print(json.dumps(result,separators=(',',':')))`
  const output = await command(
    cfg.python.path,
    ["-I", "-S", "-B", "-c", script, cfg.root, notes, JSON.stringify(images), fingerprint],
    { windowsHide: true },
  )
  const refs = JSON.parse(output.stdout) as Record<string, unknown>
  const managed = descriptor({
    ...cfg,
    plan: refs["memory-v2-plan.json"],
    retrieval: refs["retrieval-v2-plan.json"],
    notes: refs.notes,
  })
  const selected = parse({ ...setup, protocol: "raya.memory.operation.v2", root: notes })
  const before = await readFile(path.join(notes, "README.md"))
  const next = await materialize(managed, selected, path.resolve("."), "e".repeat(32))
  const cold = await review(next.receipt, { setup: selected, managed })
  expect(cold.next.managed.notes).toEqual(managed.notes)
  expect(cold.next.setup.root).toBe(notes)
  const plans = await selection(cold.next.managed, cold.next.setup)
  expect(plans.retrieval!.source_sha256).toEqual(images)
  expect((plans.plan.env as Record<string, unknown>).RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256).toBe(fingerprint)
  const check = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('actual_v2_upgrade',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for file,digest in json.loads(sys.argv[2]): module.load(file,digest,True)
assert not any(name in sys.modules for name in ('torch','transformers','scipy','sklearn'))
print('reusable-v2-external-notes-qualified')`
  const result = await command(
    cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      check,
      cold.next.managed.supervisor.path,
      JSON.stringify([cold.next.managed.plan, cold.next.managed.retrieval!].map((item) => [item.path, item.sha256])),
    ],
    { windowsHide: true },
  )
  expect(result.stdout.trim()).toBe("reusable-v2-external-notes-qualified")
  expect(await readFile(path.join(notes, "README.md"))).toEqual(before)
}, 30000)

test("runtime publication survives every physical save acknowledgement loss and a cold applied retry", async () => {
  const prepared = await materialize(cfg, setup, path.resolve("."), "f".repeat(32))
  const key = "raya.secondBrain.setup"
  const pending = "raya.secondBrain.committedCaptureRecovery.pending"
  const ledger = "raya.secondBrain.personalCapture.turns"
  const original = {
    setup,
    managed: cfg,
    credential: "raya.secondBrain.key." + "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12),
  }
  const rows = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      project: outer,
      sessionID: "session",
      messageID: "message",
      source_sha256: "a".repeat(64),
      root: setup.root,
      release: "b".repeat(64),
      phase: "uncertain",
    },
  ]
  const open = async (file: string, fail = 0) => {
    const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    let count = 0
    return {
      get<T>(key: string): T | undefined {
        return structuredClone(state[key]) as T | undefined
      },
      async update(key: string, value: unknown) {
        if (value === undefined) delete state[key]
        if (value !== undefined) state[key] = value
        await writeFile(file, JSON.stringify(state))
        // Read the actual JSON persistence back, including absent slots, before simulating lost acknowledgement.
        const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
        for (const name of Object.keys(state)) delete state[name]
        Object.assign(state, persisted)
        if (++count === fail) throw new Error("physical save acknowledgement lost")
      },
    }
  }
  // Absent catalog/consent are intentionally persisted: JSON must never turn them into null-valued selections.
  for (const failure of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const file = path.join(outer, `publication-${failure}.json`)
    const consent =
      failure === 11
        ? {
            version: 1,
            enabled: true,
            root: setup.root,
            release: digest(setup.source_sha256),
            zone: "America/Toronto",
            model: "pinned-local-model",
            authorization: { source: "Original human authorization", sha256: "c".repeat(64) },
          }
        : undefined
    const catalog = consent
      ? {
          format: "raya.memory.control.catalog",
          version: 2,
          python: cfg.python.path,
          source: path.join(cfg.root, "source/memory"),
          bridge: path.join(outer, "retained-bridge.py"),
          python_sha256: cfg.python.sha256,
          bridge_sha256: bridge,
          source_sha256: setup.source_sha256,
        }
      : undefined
    await writeFile(
      file,
      JSON.stringify({
        [key]: original,
        [ledger]: rows,
        "raya.secondBrain.personalCapture": consent,
        "raya.secondBrain.control.catalog": catalog,
      }),
    )
    await expect(publish(await open(file, failure === 11 ? 10 : failure), prepared.receipt)).rejects.toThrow(
      "physical save acknowledgement lost",
    )
    const recovered = await publish(await open(file), prepared.receipt)
    expect(recovered.publication.phase).toBe("applied")
    const cold = await open(file)
    expect(cold.get(pending)).toBeUndefined()
    expect(cold.get(ledger)).toEqual(rows)
    expect(cold.get(key)).toEqual({
      setup: prepared.next.setup,
      managed: prepared.next.managed,
      credential: original.credential,
    })
    expect(cold.get("raya.secondBrain.control.catalog")).toEqual(
      catalog ? { ...catalog, source: prepared.source, source_sha256: prepared.next.setup.source_sha256 } : undefined,
    )
    expect(cold.get("raya.secondBrain.personalCapture")).toEqual(
      consent ? { ...consent, release: digest(prepared.next.setup.source_sha256) } : undefined,
    )
    expect((await publish(cold, prepared.receipt)).publication).toEqual(recovered.publication)
  }
}, 180000)

test("materialize refuses a changed original file before creating replacement code", async () => {
  await writeFile(path.join(cfg.root, "source/memory/server.py"), "# changed synthetic original")
  await expect(materialize(cfg, setup, path.resolve("."), "c".repeat(32))).rejects.toThrow()
  expect(
    await stat(path.join(cfg.root, "raya-memory-source-upgrade-" + "c".repeat(32))).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
}, 30000)
