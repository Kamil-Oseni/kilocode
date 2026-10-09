import path from "node:path"
import { check, document, sha } from "../control/frames"
import { command } from "../control/command"
import { environment } from "../control/identity"
import { release } from "../control/catalog-capture"
import { current } from "./catalog"
import type { Descriptor } from "./descriptor"

const body = `import hashlib,json,os,pathlib,stat,sys
def identity(info): return [info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_nlink]
def read(file,limit):
 file=pathlib.Path(file);before=file.lstat()
 if file.resolve()!=file or not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>limit or getattr(before,'st_file_attributes',0)&0x400: raise ValueError('ordinary_upgrade_image')
 with file.open('rb') as held:
  initial=os.fstat(held.fileno());raw=held.read(limit+1);final=os.fstat(held.fileno())
 after=file.lstat()
 # Windows path/descriptor ctime have distinct semantics; retain each API exactly, as the actual supervisor does.
 paths=identity(before);opened=identity(initial)
 if len(raw)>limit or len(raw)!=before.st_size or paths!=identity(after) or opened!=identity(final) or any(paths[index]!=opened[index] for index in (0,1,2,3,5)): raise ValueError('upgrade_image_changed')
 return raw,{'path':str(file),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'identity':identity(before)}
raw,ref=read(sys.argv[1],16777216)
if ref['sha256']!=sys.argv[2]: raise ValueError('original_upgrade_plan_changed')
plan=json.loads(raw);root=pathlib.Path(plan['root']);source=pathlib.Path(plan['source']);sid=sys.argv[3]
raw,ref=read(source/'namespace.py',1048576)
if ref['sha256']!=plan['source_sha256']['namespace.py']: raise ValueError('upgrade_observer_changed')
module={'__name__':'upgrade_namespace','__file__':str(source/'namespace.py')};exec(compile(raw,str(source/'namespace.py'),'exec'),module)
module['acl'](root,sid,True);module['acl'](source,sid)
prior=[]
for name,digest in plan['source_sha256'].items():
 file=source/name;raw,ref=read(file,1048576);module['acl'](file,sid)
 candidates=[row for row in plan['files'] if row['path']==str(file)]
 if len(candidates)!=1 or candidates[0]!=ref or ref['sha256']!=digest: raise ValueError('original_upgrade_source_changed')
 prior.append(ref)
for file in (root,source):
 info=file.lstat();candidates=[row for row in plan['directories'] if row['path']==str(file)]
 if file.resolve()!=file or not stat.S_ISDIR(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400 or len(candidates)!=1 or candidates[0]['identity']!=[info.st_dev,info.st_ino,info.st_ctime_ns]: raise ValueError('original_upgrade_directory_changed')
images=[];directory=None
if sys.argv[4]:
 folder=pathlib.Path(sys.argv[4]);module['acl'](folder,sid)
 info=folder.lstat()
 if folder.resolve()!=folder or not stat.S_ISDIR(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400: raise ValueError('ordinary_upgrade_directory')
 directory={'path':str(folder),'identity':[str(info.st_dev),str(info.st_ino),str(info.st_ctime_ns)]}
 pins=json.loads(sys.argv[5])
 if {file.name for file in folder.iterdir()}!=set(pins): raise ValueError('exact_new_upgrade_inventory')
 for name,digest in pins.items():
  file=folder/name;raw,ref=read(file,1048576);module['acl'](file,sid)
  if ref['sha256']!=digest: raise ValueError('new_upgrade_image_changed')
  images.append(ref)
spaces=[]
if sys.argv[6]:
 namespaces=json.loads(sys.argv[6]);paths=[pathlib.Path(namespaces['memory']['root']).parent]
 for value in namespaces.values():
  folder=pathlib.Path(value['root']);module['Namespace'](folder,value['sid'],{name:[int(token) for token in row] for name,row in value['generations'].items()})
  paths.extend((folder,folder/'Runs',folder/'Requests'))
 for file in paths:
  info=file.lstat();spaces.append({'path':str(file),'identity':[str(info.st_dev),str(info.st_ino),str(info.st_ctime_ns)]})
for row in prior+images: row['identity']=[str(value) for value in row['identity']]
print(json.dumps({'prior':prior,'images':images,'directory':directory,'spaces':spaces},separators=(',',':')))`

const script =
  "import json\ntry:\n" +
  body
    .split("\n")
    .map((line) => " " + line)
    .join("\n") +
  `
except Exception as error:
 codes={'ordinary_upgrade_image','upgrade_image_changed','original_upgrade_plan_changed','upgrade_observer_changed','original_upgrade_source_changed','original_upgrade_directory_changed','ordinary_upgrade_directory','exact_new_upgrade_inventory','new_upgrade_image_changed','receipt_selected_owner','receipt_acl_count','receipt_protected_dacl','receipt_trustees','receipt_full_control','receipt_allow_ace','receipt_directory_inheritance','receipt_duplicate_trustee'}
 code=str(error) if str(error) in codes else type(error).__name__
 print(json.dumps({'refused':code},separators=(',',':')))`

type Image = { path: string; bytes: number; sha256: string; identity: string[] }
type Observation = {
  prior: Image[]
  images: Image[]
  directory: { path: string; identity: string[] } | null
  spaces: { path: string; identity: string[] }[]
}

/** Observe existing old/new code with native uint64 tuples and actual inherited Windows ACLs; never repair. */
export async function observe(cfg: Descriptor, source = "", namespaces?: Descriptor["namespaces"]) {
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
      JSON.stringify({ ...release, "supervise.py": current }),
      namespaces ? JSON.stringify(namespaces) : "",
    ],
    { windowsHide: true, env: { ...environment(), TEMP: cfg.root, TMP: cfg.root } },
  )
  const raw = Buffer.from(result.stdout.trim())
  document(raw, 65536)
  // The observer emits native integers as strings and bounded sizes/counts as safe numbers.
  const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>
  if (Object.hasOwn(parsed, "refused")) {
    check(
      typeof parsed.refused === "string" && /^[A-Za-z_]{1,64}$/.test(parsed.refused),
      "Bounded upgrade refusal required",
    )
    throw new Error("Native upgrade observation refused: " + parsed.refused)
  }
  const value = parsed as unknown as Observation
  check(
    Array.isArray(value.prior) &&
      value.prior.length === 13 &&
      Array.isArray(value.images) &&
      value.images.length === (source ? 14 : 0),
    "Exact native upgrade observation required",
  )
  for (const item of [...value.prior, ...value.images])
    check(
      path.isAbsolute(item.path) &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes > 0 &&
        /^[a-f0-9]{64}$/.test(item.sha256) &&
        item.identity.length === 6 &&
        item.identity.every(
          (token) =>
            typeof token === "string" && /^(0|[1-9]\d{0,19})$/.test(token) && BigInt(token) <= 0xffffffffffffffffn,
        ),
      "Native upgrade image strings required",
    )
  check(source ? value.directory?.path === source : value.directory === null, "Selected upgrade directory required")
  check(
    Array.isArray(value.spaces) && value.spaces.length === (namespaces ? 7 : 0),
    "Native fresh upgrade spaces required",
  )
  return Object.freeze({ ...value, producer: result.receipt, programSHA: sha(script) })
}
