"""Selected source and control gate tests; no model, service, or native START."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).parent/'retrieval_reuse'
spec = importlib.util.spec_from_file_location('lease_bootstrap', BASE/'bootstrap.py')
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)
ARGS = ('1' * 32, '2' * 32, 'a' * 64, 'b' * 64, 'embeddings', 'embeddinggemma-2')


def frame():
    return {'format': 'raya.worker.lease.start', 'version': 2, 'lease': ARGS[0],
            'owner_epoch': ARGS[1], 'selection_sha256': ARGS[2], 'selected_release_sha256': ARGS[3],
            'kind': ARGS[4], 'model': ARGS[5], 'limit': 32}


def raw(value):
    return (json.dumps(value, separators=(',', ':')) + '\n').encode('utf-8')


class Tests(unittest.TestCase):
    def test_exact_control_gate(self):
        self.assertEqual(boot.gate(raw(frame()), *ARGS), frame())
        changes = {'format': 'raya.worker.start', 'version': 2.0, 'lease': '3' * 32,
                   'owner_epoch': '3' * 32, 'selection_sha256': 'c' * 64,
                   'selected_release_sha256': 'c' * 64, 'kind': 'rerank',
                   'model': 'qwen3-embedding-0.6b', 'limit': 32.0, 'extra': True}
        for key, value in changes.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                boot.gate(raw({**frame(), key: value}), *ARGS)

    def test_duplicate_and_incomplete_control_refusal(self):
        value = raw(frame())
        for candidate in (value[:-1], value + b'\n', b'x' * 1025 + b'\n',
                          value.replace(b'"version":2', b'"version":2,"version":2'), b'null\n'):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                boot.gate(candidate, *ARGS)

    def test_invalid_launch_selection(self):
        for index, value in [(0, 'foreign'), (1, 'foreign'), (2, 'foreign'), (3, 'foreign'),
                             (4, 'other'), (5, 'other')]:
            args = list(ARGS)
            args[index] = value
            with self.subTest(index=index), self.assertRaises(ValueError):
                boot.gate(raw(frame()), *args)
        with self.assertRaisesRegex(ValueError, 'lease_fixed_launch_required'):
            boot.main()

    def test_actual_pinned_source_images(self):
        support = boot.support()
        self.assertEqual(hashlib.sha256(boot.SUPPORT.read_bytes()).hexdigest(), boot.DIGEST)
        for name, digest in boot.PINS.items():
            path = boot.SUPPORT.parent/name if name == 'validation.py' else BASE/name
            self.assertEqual(hashlib.sha256(support.image(path, digest)).hexdigest(), digest)
        self.assertNotIn('torch', sys.modules)
        self.assertNotIn('models', sys.modules)


if __name__ == '__main__':
    unittest.main()
