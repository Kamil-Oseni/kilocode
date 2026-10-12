import path from "node:path"
import { check, document, sha } from "../control/frames"
import { command } from "../control/command"
import { environment } from "../control/identity"
import { release } from "../control/catalog-capture"
import { current } from "./catalog"
import { images, cohort } from "./reuse-catalog"
import type { Descriptor } from "./descriptor"

const body = `import hashlib,json,os,pathlib,stat,sys
def identity(info): return [info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink]
def read(file,limit):
 file=pathlib.Path(file);before=file.lstat()
 if file.resolve()!=file or not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limit or getattr(before,'st_file_attributes',0)&0x400: raise ValueError('ordinary_upgrade_image')
 with file.open('rb') as held:
  opened=os.fstat(held.fileno());raw=held.read(limit+1);final=os.fstat(held.fileno())
 after=file.lstat();paths=identity(before);initial=identity(opened)
 if len(raw)>limit or len(raw)!=before.st_size or paths!=identity(after) or initial!=identity(final) or any(paths[index]!=initial[index] for index in (0,1,2,3,5)): raise ValueError('upgrade_image_changed')
 return raw,{'path':str(file),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'identity':[str(value) for value in paths]}
def directory(file):
 file=pathlib.Path(file);info=file.lstat()
 if file.resolve()!=file or not stat.S_ISDIR(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400: raise ValueError('ordinary_upgrade_directory')
 module['acl'](file,sid)
 return {'path':str(file),'identity':[str(info.st_dev),str(info.st_ino),str(info.st_ctime_ns)]}
raw,ref=read(sys.argv[1],16777216)
if ref['sha256']!=sys.argv[2]: raise ValueError('original_upgrade_plan_changed')
plan=json.loads(raw);root=pathlib.Path(plan['root']);source=pathlib.Path(plan['source']);sid=sys.argv[3]
raw,ref=read(source/'namespace.py',1048576)
if ref['sha256']!=plan['source_sha256']['namespace.py']: raise ValueError('upgrade_observer_changed')
module={'__name__':'upgrade_namespace','__file__':str(source/'namespace.py')};exec(compile(raw,str(source/'namespace.py'),'exec'),module)
module['acl'](root,sid,True)
raw,ref=read(sys.argv[7],16777216)
if ref['sha256']!=sys.argv[8]: raise ValueError('original_retrieval_plan_changed')
other=json.loads(raw);policy=json.loads(sys.argv[9]);previous=pathlib.Path(other['source'])
if str(previous)!=str(pathlib.Path(policy['source'])) or other['source_sha256']!=policy['pins'] or other['env']['RAYA_RETRIEVAL_RELEASE_SHA256']!=policy['release'] or plan['env']['RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256']!=policy['release'] or other['files']!=plan['files'] or other['directories']!=plan['directories']: raise ValueError('original_retrieval_selection_changed')
def originals(folder,pins):
 result=[]
 for name,digest in pins.items():
  file=folder/name;raw,ref=read(file,1048576);module['acl'](file,sid)
  candidates=[row for row in plan['files'] if pathlib.Path(row['path'])==file]
  if len(candidates)!=1 or {**candidates[0],'path':str(file),'identity':[str(value) for value in candidates[0]['identity']]}!=ref or ref['sha256']!=digest: raise ValueError('original_upgrade_source_changed')
  result.append(ref)
 return result
prior=originals(source,plan['source_sha256']);retrieval=originals(previous,policy['pins'])
for folder in {source,previous,previous/'retrieval',previous/'retrieval_reuse'}:
 observed=directory(folder);candidates=[row for row in plan['directories'] if pathlib.Path(row['path'])==folder]
 if len(candidates)!=1 or [str(value) for value in candidates[0]['identity']]!=observed['identity']: raise ValueError('original_upgrade_directory_changed')
new=[];dirs=[]
if sys.argv[4]:
 folder=pathlib.Path(sys.argv[4]);pins=json.loads(sys.argv[5]);dirs=[directory(folder),directory(folder/'retrieval'),directory(folder/'retrieval_reuse')]
 if {file.name for file in folder.iterdir()}!={name for name in pins if '/' not in name}|{'retrieval','retrieval_reuse'}: raise ValueError('exact_new_upgrade_inventory')
 for name in ('retrieval','retrieval_reuse'):
  if {file.name for file in (folder/name).iterdir()}!={leaf.split('/')[1] for leaf in pins if leaf.startswith(name+'/')}: raise ValueError('exact_new_upgrade_inventory')
 for name,digest in pins.items():
  file=folder/name;raw,ref=read(file,1048576);module['acl'](file,sid)
  if ref['sha256']!=digest: raise ValueError('new_upgrade_image_changed')
  new.append(ref)
spaces=[]
if sys.argv[6]:
 namespaces=json.loads(sys.argv[6]);paths=[pathlib.Path(namespaces['memory']['root']).parent]
 for value in namespaces.values():
  folder=pathlib.Path(value['root']);module['Namespace'](folder,value['sid'],{name:[int(token) for token in row] for name,row in value['generations'].items()});paths.extend((folder,folder/'Runs',folder/'Requests'))
 for file in paths: spaces.append(directory(file))
print(json.dumps({'prior':prior,'retrieval':retrieval,'images':new,'directories':dirs,'spaces':spaces},separators=(',',':')))`

const script =
  "import json\ntry:\n" +
  body
    .split("\n")
    .map((line) => " " + line)
    .join("\n") +
  "\nexcept Exception as error:\n print(json.dumps({'refused':type(error).__name__},separators=(',',':')))"
type Image = { path: string; bytes: number; sha256: string; identity: string[] }
type Directory = { path: string; identity: string[] }
export type Retrieval = { source: string; pins: Readonly<Record<string, string>>; release: string }

function tokens(value: unknown, count: number): asserts value is string[] {
  check(
    Array.isArray(value) &&
      value.length === count &&
      value.every(
        (token) =>
          typeof token === "string" && /^(0|[1-9]\d{0,19})$/.test(token) && BigInt(token) <= 0xffffffffffffffffn,
      ),
    "Exact native upgrade integer strings required",
  )
}

type Observation = {
  prior: Image[]
  retrieval: Image[]
  images: Image[]
  directories: Directory[]
  spaces: Directory[]
  refused?: string
}

function checked(value: Observation, source: string, fresh: boolean) {
  check(
    !value.refused &&
      Array.isArray(value.prior) &&
      [13, 15].includes(value.prior.length) &&
      Array.isArray(value.retrieval) &&
      value.retrieval.length === 16 &&
      Array.isArray(value.images) &&
      value.images.length === (source ? Object.keys(release).length + Object.keys(images).length + 1 : 0) &&
      Array.isArray(value.directories) &&
      value.directories.length === (source ? 3 : 0) &&
      Array.isArray(value.spaces) &&
      value.spaces.length === (fresh ? 7 : 0),
    "Exact v2 native upgrade observation required",
  )
  for (const row of [...value.prior, ...value.retrieval, ...value.images]) {
    check(
      path.isAbsolute(row.path) &&
        Number.isSafeInteger(row.bytes) &&
        row.bytes > 0 &&
        /^[a-f0-9]{64}$/.test(row.sha256),
      "Exact native image required",
    )
    tokens(row.identity, 6)
  }
  for (const row of [...value.directories, ...value.spaces]) {
    check(path.isAbsolute(row.path), "Absolute native directory required")
    tokens(row.identity, 3)
  }
  check(!source || value.directories[0].path === source, "Selected v2 source directory required")
}

/** Native original-image/ACL witnesses, without importing models or changing original plans. */
export async function observe(cfg: Descriptor, prior: Retrieval, source = "", namespaces?: Descriptor["namespaces"]) {
  check(
    cfg.retrieval &&
      path.isAbsolute(prior.source) &&
      JSON.stringify(Object.entries(prior.pins).sort()) ===
        JSON.stringify(Object.entries(cohort(prior.release)).sort()),
    "Exact original reusable Retrieval selection required",
  )
  const result = await command(
    cfg.python.path,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      script,
      cfg.plan.path,
      cfg.plan.sha256,
      cfg.namespaces.memory.sid,
      source,
      JSON.stringify({ ...release, "supervise.py": current, ...images }),
      namespaces ? JSON.stringify(namespaces) : "",
      cfg.retrieval.path,
      cfg.retrieval.sha256,
      JSON.stringify(prior),
    ],
    { windowsHide: true, env: { ...environment(), TEMP: cfg.root, TMP: cfg.root } },
  )
  const raw = Buffer.from(result.stdout.trim())
  document(raw, 65536)
  const value = JSON.parse(raw.toString()) as Observation
  checked(value, source, Boolean(namespaces))
  return { ...value, producer: result.receipt, programSHA: sha(script) }
}
