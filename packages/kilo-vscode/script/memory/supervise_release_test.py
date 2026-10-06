"""Genuine release admission only; no service, native START, or model execution.

The disposable protection document is fixture input, not proof of Windows ACLs.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('supervise', BASE/'supervise.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class Release(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raya-memory-disposable-')
        self.root = Path(self.temp.name).resolve()
        source = self.root/'source'
        deps = self.root/'dependencies'
        source.mkdir()
        deps.mkdir()
        for name, sha in module.RELEASES['memory'].items():
            raw = (BASE/'service'/name).read_bytes()
            self.assertEqual(digest(raw), sha)
            (source/name).write_bytes(raw)
        (deps/'inert.py').write_bytes(b'# inert dependency closure\n')
        proof = self.root/'protection.json'
        proof.write_text(json.dumps({'passed': True, 'root': str(self.root)}), encoding='utf-8')
        keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
        files = []
        for path in [*source.iterdir(), deps/'inert.py']:
            info = path.lstat()
            raw = path.read_bytes()
            files.append({'path': str(path), 'bytes': len(raw), 'sha256': digest(raw),
                          'identity': [getattr(info, key) for key in keys]})
        self.plan = {
            'format': 'raya.memory.disposable.supervisor', 'version': 1, 'kind': 'memory',
            'execution_admitted': True, 'root': str(self.root),
            'protection': {'path': str(proof), 'sha256': digest(proof.read_bytes())},
            'directories': [{'path': str(path), 'identity': [path.stat().st_dev, path.stat().st_ino,
                             path.stat().st_ctime_ns]} for path in (self.root, source, deps)],
            'python_sha256': digest(Path(sys.executable).read_bytes()), 'source': str(source),
            'source_sha256': dict(module.RELEASES['memory']), 'files': files, 'dependencies': str(deps),
            'env': {'HOME': str(self.root), 'USERPROFILE': str(self.root), 'TEMP': str(self.root),
                    'TMP': str(self.root), 'HF_HOME': str(self.root), 'HF_HUB_OFFLINE': '1',
                    'TRANSFORMERS_OFFLINE': '1', 'PYTHONDONTWRITEBYTECODE': '1',
                    'RAYA_MEMORY_ROOT': str(self.root), 'RAYA_MEMORY_TOKEN_FILE': str(self.root/'token'),
                    'RAYA_MEMORY_OPERATION_ROOT': str(self.root/'operations'),
                    'RAYA_MEMORY_RETRIEVAL_TOKEN_FILE': str(self.root/'retrieval-token')},
        }

    def tearDown(self):
        self.temp.cleanup()

    def load(self):
        path = self.root/'plan.json'
        raw = json.dumps(self.plan).encode()
        path.write_bytes(raw)
        return module.load(str(path), digest(raw))

    def test_current_release_admits_all_original_bytes(self):
        plan, images = self.load()
        self.assertEqual(plan, self.plan)
        self.assertEqual(len(images), 12)
        self.assertEqual(set(images), {Path(plan['source'])/name for name in module.RELEASES['memory']})
        for path, raw in images.items():
            self.assertEqual(raw, path.read_bytes())

    def test_missing_or_extra_source_refused(self):
        pins = self.plan['source_sha256']
        saved = pins.pop('proposals.py')
        with self.assertRaisesRegex(ValueError, 'Exact selected service release required'):
            self.load()
        pins['proposals.py'] = saved
        pins['extra.py'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'Exact selected service release required'):
            self.load()

    def test_changed_release_refused(self):
        self.plan['source_sha256']['index.py'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'Exact selected service release required'):
            self.load()


if __name__ == '__main__':
    unittest.main()
