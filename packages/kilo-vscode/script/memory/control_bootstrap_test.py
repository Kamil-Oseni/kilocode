"""Actual isolated verified Bridge bootstrap; no control operation or publication."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
FIXTURE = HERE.parents[1] / 'tests/fixtures'
ORIGINAL = '0c75ad3254fb85a0a187a6dfd69ebf3774ceaeb322eaa793a4e7de1b40993c85'
BODY = '''import importlib.util,json,sys,types
from pathlib import Path
source=Path(sys.argv[2]);assert str(source) not in sys.path
if sys.argv[3]=='preloaded':sys.modules['entries']=types.ModuleType('entries')
spec=importlib.util.spec_from_file_location('verified_control',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
owner=module.Bridge(Path(sys.argv[4]))
assert str(source) not in sys.path
assert not {'torch','transformers','numpy','tokenizers'} & set(sys.modules)
assert Path(owner.host.store.root)==Path(sys.argv[5])
assert all(Path(item.__file__)==source/(name+'.py') for name,item in owner.modules.items())
print(json.dumps({'modules':list(owner.modules),'sourceOnPath':False,'operations':0,'inference':False}))
'''


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raya-control-bootstrap-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.notes = self.root / 'notes'
        self.notes.mkdir()
        (self.notes / 'System').mkdir()
        self.source = self.root / 'source'
        self.source.mkdir()
        self.pins = {}
        for name in ('server', 'index', 'notes', 'policy', 'admission', 'host', 'operations', 'retirement',
                     'namespace', 'historical', 'dispatch', 'proposals', 'capture', 'entries', 'management'):
            target = self.source / (name + '.py')
            shutil.copyfile(HERE / 'service' / target.name, target)
            self.pins[target.name] = hashlib.sha256(target.read_bytes()).hexdigest()
        self.bridge = self.root / 'control.py'
        shutil.copyfile(HERE / 'control.py', self.bridge)
        self.config = self.root / 'config.json'

    def child(self, action='current'):
        self.config.write_text(json.dumps(dict(format='raya.memory.control.setup', version=2,
            root=str(self.notes), source_dir=str(self.source), source_sha256=self.pins)), encoding='utf-8')
        before = sorted(str(path.relative_to(self.notes)) for path in self.notes.rglob('*'))
        child = subprocess.run([sys.executable, '-I', '-S', '-B', '-c', BODY, str(self.bridge),
                                str(self.source), action, str(self.config), str(self.notes)],
                               capture_output=True, text=True, timeout=10,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.assertEqual(sorted(str(path.relative_to(self.notes)) for path in self.notes.rglob('*')), before)
        return child

    def test_current_fifteen_verified_modules_load_entries_before_capture(self):
        child = self.child()
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(child.stderr, '')
        value = json.loads(child.stdout)
        self.assertLess(value['modules'].index('entries'), value['modules'].index('capture'))
        self.assertEqual(value['operations'], 0)
        self.assertFalse(value['sourceOnPath'])
        self.assertFalse(value['inference'])

    def test_original_verified_loader_reproduces_missing_entries_before_any_operation(self):
        raw = gzip.decompress((FIXTURE / 'memory-control-predecessor/control.py.gz').read_bytes())
        self.assertEqual(hashlib.sha256(raw).hexdigest(), ORIGINAL)
        self.bridge.write_bytes(raw)
        child = self.child()
        self.assertNotEqual(child.returncode, 0)
        self.assertIn("ModuleNotFoundError: No module named 'entries'", child.stderr)
        self.assertEqual(child.stdout, '')

    def test_legacy_thirteen_capture_does_not_load_or_require_entries(self):
        raw = gzip.decompress((FIXTURE / 'memory-90c-predecessor/capture.py.gz').read_bytes())
        self.assertEqual(hashlib.sha256(raw).hexdigest(), 'b059c9bb84a176c86e5ff7b7e35b1470cba30fdfec5fb7dcdef4d829298b0dfe')
        (self.source / 'capture.py').write_bytes(raw)
        self.pins['capture.py'] = hashlib.sha256(raw).hexdigest()
        for name in ('entries.py', 'management.py'):
            self.pins.pop(name)
            (self.source / name).unlink()
        self.assertEqual(len(self.pins), 13)
        child = self.child()
        self.assertEqual(child.returncode, 0, child.stderr)
        value = json.loads(child.stdout)
        self.assertNotIn('entries', value['modules'])
        self.assertIn('capture', value['modules'])
        self.assertEqual(value['operations'], 0)

    def test_unselected_preloaded_module_is_refused(self):
        child = self.child('preloaded')
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('Unselected module already loaded.', child.stderr)
        self.assertEqual(child.stdout, '')

    def test_mixed_entry_image_and_incomplete_source_set_are_refused(self):
        self.pins['entries.py'] = 'f' * 64
        child = self.child()
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('Selected source changed.', child.stderr)
        self.pins.pop('management.py')
        child = self.child()
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('Exact fields required.', child.stderr)
        self.assertEqual(child.stdout, '')


if __name__ == '__main__':
    unittest.main()
