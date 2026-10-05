"""Actual Windows protected publication, real executor, and original child joins."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from namespace_publication_test import Tests as Base, MODULE, HERE

sys.modules['namespace'] = MODULE
sys.path.insert(0, str(HERE / 'service'))
from dispatch import dispatch, prepare, submit
from historical import inspect, restore
from operations import Journal
from retirement import decode, fingerprint


class Tests(Base):
    def journal(self):
        self.folder.rmdir()
        names = ('server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py',
                 'host.py', 'operations.py', 'retirement.py', 'namespace.py', 'historical.py', 'dispatch.py')
        self.source = {name: hashlib.sha256((HERE / 'service' / name).read_bytes()).hexdigest() for name in names}
        self.generations = {name: MODULE.generation(self.root if name == 'root' else self.root / name) for name in ('root', 'Runs', 'Requests')}
        return Journal(str(self.root), self.sid, self.generations, 'e' * 32, fingerprint(self.source))

    def sticky(self, journal):
        pending = journal.folder / ('1' * 32 + '-pending.json')
        self.assertEqual(decode(pending.read_bytes())['status'], 'pending')
        self.assertFalse((journal.folder / ('1' * 32 + '-terminal.json')).exists())
        with self.assertRaises(ValueError):
            Journal(str(self.root), self.sid, self.generations, 'f' * 32, journal.release)

    def test_actual_fsync_before_executor_and_original_inspection(self):
        journal = self.journal()
        flushes = []
        original = os.fsync

        def observe(fd):
            original(fd)
            flushes.append(os.fstat(fd).st_ino)

        def task(pending):
            self.assertEqual(len(flushes), 2)
            paths = list(journal.folder.glob('*.json'))
            self.assertEqual(len(paths), 2)
            provenance = next(path for path in paths if not path.name.endswith('-pending.json'))
            value = decode(provenance.read_bytes())
            self.assertEqual(value['pending'], pending)
            restore(journal.namespace, value)
            return {'results': [], 'capture_enabled': False}

        os.fsync = observe  # Observe the real completed native fsync, never substitute success.
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                result = dispatch(journal, '1' * 32, 'search', {'query': 'synthetic violet', 'top': 5}, self.source, executor, task)
                reply = result['future'].result()
        finally:
            os.fsync = original
        self.sticky(journal)
        journal.complete(result['pending'], reply, 'completed', [])
        self.assertEqual(inspect(result['selection'])['operation']['operation_outcome'], 'completed')
        self.assertNotIn('synthetic violet', (journal.folder / result['provenance']['name']).read_text())
        with ThreadPoolExecutor(max_workers=1) as executor:
            with self.assertRaises(FileExistsError):
                dispatch(journal, '1' * 32, 'search', {'query': 'synthetic violet', 'top': 5}, self.source, executor, task)

    def test_executor_refusal_retains_durable_provenance_and_pending(self):
        journal = self.journal()
        marker = self.root / 'body-entered'
        with ThreadPoolExecutor(max_workers=1) as executor:
            executor.shutdown(wait=True)
            with self.assertRaises(RuntimeError):
                dispatch(journal, '1' * 32, 'search', {'query': 'synthetic', 'top': 5}, self.source, executor,
                         lambda _: marker.write_text('admitted'))
        self.assertFalse(marker.exists())
        self.assertEqual(len(list(journal.folder.glob('*.json'))), 2)
        self.sticky(journal)

    def test_split_preparation_tamper_cannot_admit_body(self):
        journal = self.journal()
        prepared = prepare(journal, '1' * 32, 'search', {'query': 'synthetic', 'top': 5}, self.source)
        path = journal.folder / prepared['provenance']['name']
        with path.open('ab') as held:
            held.write(b' ')
            held.flush()
            os.fsync(held.fileno())
        with ThreadPoolExecutor(max_workers=1) as executor:
            with self.assertRaises(ValueError):
                submit(journal, prepared, self.source, executor, lambda _: self.fail('Body admitted'))
        self.sticky(journal)

    def child(self, mode):
        journal = self.journal()
        # Only the untouched test epoch is removed before this child's original Journal creation.
        journal.folder.rmdir()
        script = """import hashlib,json,os,sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0,sys.argv[1])
from operations import Journal
from dispatch import dispatch
from retirement import fingerprint
root=Path(sys.argv[2]); mode=sys.argv[4]; generations=json.loads(sys.argv[5])
source={name:hashlib.sha256((Path(sys.argv[1])/name).read_bytes()).hexdigest() for name in ('server.py','index.py','notes.py','policy.py','admission.py','host.py','operations.py','retirement.py','namespace.py','historical.py','dispatch.py')}
journal=Journal(str(root),sys.argv[3],generations,'e'*32,fingerprint(source))
original=os.fsync; count=0
def boundary(fd):
 global count
 count+=1
 if count==2 and mode=='fail':
  os.close(fd)
 original(fd)
 if count==2 and mode=='crash':
  os._exit(23)
os.fsync=boundary
with ThreadPoolExecutor(max_workers=1) as executor:
 try:
  dispatch(journal,'1'*32,'search',{'query':'synthetic','top':5},source,executor,lambda _:(root/'body-entered').write_text('admitted'))
 except OSError:
  assert mode=='fail' and count==2 and not (root/'body-entered').exists()
  print(json.dumps({'publicationFailed':True,'fsyncEntered':count,'bodyEntered':False}))
 else:
  raise AssertionError('Publication fault unexpectedly admitted work')
"""
        process = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-c', script,
                                    str(HERE / 'service'), str(self.root), self.sid, mode, json.dumps(self.generations)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
        out, err = process.communicate()
        self.assertEqual(process.returncode, 23 if mode == 'crash' else 0, err.decode())
        self.assertEqual(err, b'')
        if mode == 'fail':
            self.assertEqual(json.loads(out), {'publicationFailed': True, 'fsyncEntered': 2, 'bodyEntered': False})
        if mode == 'crash':
            self.assertEqual(out, b'')
        self.assertFalse((self.root / 'body-entered').exists())
        self.sticky(journal)
        self.assertEqual(len(list(journal.folder.glob('*.json'))), 2)

    def test_actual_bad_descriptor_publication_failure_no_body(self):
        self.child('fail')

    def test_child_crash_after_provenance_fsync_before_submission(self):
        self.child('crash')

    def test_wrong_source_and_malformed_request_admit_nothing(self):
        journal = self.journal()
        with ThreadPoolExecutor(max_workers=1) as executor:
            wrong = dict(self.source, **{'server.py': '0' * 64})
            with self.assertRaises(ValueError):
                dispatch(journal, '1' * 32, 'search', {}, wrong, executor, lambda _: None)
            with self.assertRaises(ValueError):
                dispatch(journal, '../escape', 'search', {}, self.source, executor, lambda _: None)
        self.assertEqual(list(journal.folder.iterdir()), [])


if __name__ == '__main__':
    # Imported Base is not separately discovered. Its three inherited regressions run once.
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests))
    sys.exit(not result.wasSuccessful())
