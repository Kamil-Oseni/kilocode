import path from "node:path"
import { copyFile, cp, mkdir, writeFile } from "node:fs/promises"
import { descriptor } from "../../../src/second-brain/managed/descriptor"
import { retrieval } from "../../../src/second-brain/managed/catalog"
import { images, fingerprint } from "../../../src/second-brain/managed/reuse-catalog"
import { release } from "../../../src/second-brain/control/catalog-capture"
import { protect } from "../../../src/second-brain/control/protection"
import { protection } from "../../../src/second-brain/managed/protection"
import { command } from "../../../src/second-brain/control/command"
import { powershell, environment } from "../../../src/second-brain/control/identity"
import { parse } from "../../../src/second-brain/settings"
const base = "D:/Raya/Services/Packaging/Python/3.12.14"
export async function runtime(
  outer: string,
  source: { path: string; pins: Readonly<Record<string, string>> } = {
    path: path.resolve("script/memory/service"),
    pins: release,
  },
  notes?: string,
) {
  if (notes) await protection(outer)
  if (!notes) await protect(outer)
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
    Object.keys(source.pins).map((name) =>
      copyFile(path.join(source.path, name), path.join(root, "source/memory", name)),
    ),
  )
  await Promise.all(
    Object.keys(retrieval).map((name) =>
      copyFile(path.resolve("script/memory/retrieval", name), path.join(root, "source/retrieval", name)),
    ),
  )
  await copyFile(path.resolve("script/memory/supervise.py"), path.join(root, "source/supervise.py"))
  if (notes) {
    await mkdir(path.join(root, "source/retrieval_reuse"))
    await Promise.all(
      Object.keys(images)
        .filter((name) => name.startsWith("retrieval_reuse/"))
        .map((name) => copyFile(path.resolve("script/memory", name), path.join(root, "source", name))),
    )
  }
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
for folder in [root/'source',root/'source'/'memory',root/'source'/'retrieval',root/'deps']:
 info=folder.lstat();directories.append({'path':str(folder),'identity':[info.st_dev,info.st_ino,info.st_ctime_ns]})
common={'format':'raya.memory.managed.supervisor','version':1,'execution_admitted':True,'root':str(root),'files':files,'directories':directories,'python_sha256':ref(root/'python'/'python.exe')['sha256'],'dependencies':str(root/'deps'),'protection':{'path':str(root/'protection.json'),'sha256':ref(root/'protection.json')['sha256']}}
private={'HOME':str(root/'home'),'USERPROFILE':str(root/'home'),'TEMP':str(root/'cache'),'TMP':str(root/'cache'),'HF_HOME':str(root/'cache'),'HF_HUB_OFFLINE':'1','TRANSFORMERS_OFFLINE':'1','PYTHONDONTWRITEBYTECODE':'1'}
namespace={'RAYA_RETRIEVAL_RECEIPT_ROOT':spaces['retrieval']['root'],'RAYA_RETRIEVAL_RECEIPT_SID':sid,'RAYA_RETRIEVAL_RECEIPT_GENERATIONS':json.dumps(spaces['retrieval']['generations'],separators=(',',':'))}
memory={**common,'kind':'memory','source':str(root/'source'/'memory'),'source_sha256':pins,'port':58741,'retrieval_selection':namespace,'env':{**private,'RAYA_MEMORY_ROOT':str(root),'RAYA_MEMORY_PORT':'58741','RAYA_RETRIEVAL_PORT':'58742','RAYA_MEMORY_TOKEN_FILE':str(root/'tokens'/'memory.token'),'RAYA_MEMORY_RETRIEVAL_TOKEN_FILE':str(root/'tokens'/'retrieval.token'),'RAYA_MEMORY_OPERATION_ROOT':spaces['memory']['root'],'RAYA_MEMORY_OPERATION_SID':sid,'RAYA_MEMORY_OPERATION_GENERATIONS':json.dumps(spaces['memory']['generations'],separators=(',',':'))}}
other={**common,'kind':'retrieval','source':str(root/'source'/'retrieval'),'source_sha256':retrieval,'port':58742,'env':{**private,**namespace,'RAYA_RETRIEVAL_PORT':'58742','RAYA_RETRIEVAL_TOKEN_FILE':str(root/'tokens'/'retrieval.token')}}
if len(sys.argv)>5:
 notes=pathlib.Path(sys.argv[5]);witness={}
 for name,file in (('root',notes),('system',notes/'System')):
  info=file.lstat();witness[name]=[info.st_dev,info.st_ino,info.st_birthtime_ns]
 memory['notes_selection']={'root':str(notes),'system':str(notes/'System'),'generations':{name:[str(value) for value in row] for name,row in witness.items()}}
 memory['env'].update(RAYA_MEMORY_ROOT=str(notes),RAYA_MEMORY_NOTE_GENERATIONS=json.dumps(witness,separators=(',',':')),RAYA_MEMORY_RETRIEVAL_PROTOCOL='raya.retrieval.request.settlement.v2')
 reuse=json.loads(sys.argv[6]);release=sys.argv[7]
 for name in reuse:
  if name.startswith('retrieval_reuse/'): files.append(image(root/'source'/name))
 folder=root/'source'/'retrieval_reuse';info=folder.lstat();directories.append({'path':str(folder),'identity':[info.st_dev,info.st_ino,info.st_ctime_ns]})
 memory['env']['RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256']=release
 other.update(source=str(root/'source'),source_sha256=reuse,retrieval_protocol='raya.retrieval.request.settlement.v2')
 other['env']['RAYA_RETRIEVAL_RELEASE_SHA256']=release
for name,plan in (('memory-plan.json',memory),('retrieval-plan.json',other)): (root/name).write_text(json.dumps(plan,separators=(',',':')),encoding='utf-8')
for space in spaces.values(): space['generations']={name:[str(value) for value in row] for name,row in space['generations'].items()}
cfg={'format':'raya.memory.managed.launch','version':2,'root':str(root),'python':ref(root/'python'/'python.exe'),'supervisor':ref(root/'source'/'supervise.py'),'plan':ref(root/'memory-plan.json'),'retrieval':ref(root/'retrieval-plan.json'),'namespaces':spaces}
if 'notes_selection' in memory: cfg['notes']=memory['notes_selection']
print(json.dumps(cfg,separators=(',',':')))`
  const output = await command(
    path.join(root, "python/python.exe"),
    [
      "-I",
      "-S",
      "-B",
      "-c",
      body,
      root,
      sid,
      JSON.stringify(source.pins),
      JSON.stringify(retrieval),
      ...(notes ? [notes, JSON.stringify(images), fingerprint] : []),
    ],
    { windowsHide: true },
  )
  const cfg = descriptor(JSON.parse(output.stdout))
  const setup = parse({
    format: "raya.memory.setup",
    version: 2,
    protocol: notes ? "raya.memory.operation.v2" : "raya.memory.operation.v1",
    origin: "http://127.0.0.1:58741",
    root: notes ?? root,
    source_sha256: source.pins,
  })
  return { cfg, setup }
}
