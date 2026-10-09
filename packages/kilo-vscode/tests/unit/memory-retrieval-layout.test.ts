import { expect, test } from "bun:test"
import path from "node:path"
import { exec } from "../../src/util/process"

const native = process.platform === "win32" ? test : test.skip

native(
  "actual supervisor selects complete current and retained Retrieval cohorts and rejects mixed images",
  async () => {
    const result = await exec(
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        String.raw`
import hashlib,importlib.util,pathlib,sys
root=pathlib.Path(sys.argv[1]);spec=importlib.util.spec_from_file_location('checked_supervisor',root/'supervise.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for selected,reuse in ((module.RELEASES['retrieval'],False),(module.FINITE_PREVIOUS,False),
                       (module.REUSED,True),(module.REUSE_PREVIOUS,True),(module.REUSE_COLD,True),(module.REUSE,True)):
 assert module.release('retrieval',selected,reuse)==selected
for name,digest in module.RELEASES['retrieval'].items():
 assert hashlib.sha256((root/'retrieval'/name).read_bytes()).hexdigest()==digest
for name,digest in module.REUSE.items():
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest
for mixed,reuse in ((dict(module.FINITE_PREVIOUS,**{'bootstrap.py':module.RELEASES['retrieval']['bootstrap.py']}),False),
                   (dict(module.REUSE_PREVIOUS,**{'retrieval/owner.py':module.REUSE['retrieval/owner.py']}),True),
                   (dict(module.REUSE_COLD,**{'retrieval_reuse/session.py':module.REUSE['retrieval_reuse/session.py']}),True)):
 try:module.release('retrieval',mixed,reuse)
 except ValueError as error:assert str(error)=='Exact selected service release required'
 else:raise AssertionError('mixed original/current images admitted')
assert not any(name in sys.modules for name in ('torch','transformers','models','scipy','sklearn'))
print('6 exact cohorts, 23 current source hashes, and 3 mixed-cohort refusals passed.')
`,
        path.resolve("script/memory"),
      ],
      { timeout: 10000, maxBuffer: 4096 },
    )
    expect(result.stderr).toBe("")
    expect(result.stdout.trim()).toBe("6 exact cohorts, 23 current source hashes, and 3 mixed-cohort refusals passed.")
  },
)

native(
  "actual isolated Retrieval layout gates preserve the capsule and private environment without model admission",
  async () => {
    const result = await exec(
      "D:/Raya/Services/Packaging/Python/3.12.14/python.exe",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        String.raw`
import os,pathlib,shutil,subprocess,sys,tempfile
source=pathlib.Path(sys.argv[1])
child=r'''
import importlib.util,os,pathlib,sys
folder=pathlib.Path(sys.argv[1]);valid=sys.argv[2]=='1';wrong=sys.argv[3]=='1'
sys.path[:0]=[str(folder/'retrieval_reuse'),str(folder/'retrieval')]
import owner,entry
spec=importlib.util.spec_from_file_location('checked_bootstrap',folder/'retrieval'/'bootstrap.py')
boot=importlib.util.module_from_spec(spec);spec.loader.exec_module(boot)
spec=importlib.util.spec_from_file_location('checked_lease_bootstrap',folder/'retrieval_reuse'/'bootstrap.py')
lease=importlib.util.module_from_spec(spec);spec.loader.exec_module(lease)
support=lease.support();assert support.ROOT==folder.parent
for key,value in boot.ENV.items():os.environ[key]=value
if wrong:os.environ['HOME']=str(folder/'foreign')
try:boot.private()
except ValueError as error:
 assert str(error)==('private_environment' if valid and wrong else 'private_source_layout'),str(error)
else:assert valid and not wrong
original=object.__new__(owner.Owner)
try:original.spawn()
except ValueError as error:assert not valid and str(error)=='private_source_layout',str(error)
except AttributeError as error:assert valid and 'library' in str(error),str(error)
else:raise AssertionError('owner created a process')
try:entry.build({})
except ValueError as error:
 assert str(error)==('reuse_selected_interpreter_path' if valid else 'reuse_private_source_layout'),str(error)
else:raise AssertionError('entry admitted unselected interpreter')
assert not any(name in sys.modules for name in ('torch','transformers','models','scipy','sklearn'))
print('three actual gates checked')
'''
with tempfile.TemporaryDirectory(prefix='raya-layout-owned-') as temp:
 cases=[('raya-memory-managed-owned','source',True,False),
        ('raya-memory-managed-owned','raya-memory-source-upgrade-'+'a'*32,True,False),
        ('raya-memory-managed-owned','raya-memory-source-upgrade-'+'b'*32,True,True),
        ('raya-memory-managed-owned','raya-memory-source-upgrade-'+'a'*31,False,False),
        ('raya-memory-managed-owned','raya-memory-source-upgrade-'+'A'*32,False,False),
        ('raya-memory-managed-owned','foreign',False,False),
        ('foreign-managed','source',False,False)]
 for index,(name,leaf,valid,wrong) in enumerate(cases):
  root=pathlib.Path(temp)/str(index)/name;folder=root/leaf
  for directory in ('retrieval','retrieval_reuse'):
   target=folder/directory;target.mkdir(parents=True)
   for file in (source/directory).glob('*.py'):shutil.copyfile(file,target/file.name)
  for directory in ('home','tmp','hf'):(root/directory).mkdir()
  value=subprocess.run([sys.executable,'-I','-S','-B','-c',child,str(folder),str(int(valid)),str(int(wrong))],
                       stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=10)
  assert value.returncode==0,(index,value.stdout,value.stderr)
  assert value.stdout.strip()=='three actual gates checked' and not value.stderr
print('21 actual layout/private-environment gates passed; no process or model admission.')
`,
        path.resolve("script/memory"),
      ],
      { timeout: 20000, maxBuffer: 4096 },
    )
    expect(result.stderr).toBe("")
    expect(result.stdout.trim()).toBe(
      "21 actual layout/private-environment gates passed; no process or model admission.",
    )
  },
  25000,
)
