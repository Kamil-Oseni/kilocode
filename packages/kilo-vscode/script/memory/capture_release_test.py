"""Actual supervisor release admission and physical current sources; no service launch."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('capture_supervisor_test', HERE / 'supervise.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def test_actual_source_release_and_separate_legacy_selection(self):
        current = {name: hashlib.sha256((HERE / 'service' / name).read_bytes()).hexdigest() for name in module.CAPTURE}
        self.assertEqual(len(current), 13)
        self.assertEqual(module.release('memory', current), module.CAPTURE)
        self.assertEqual(module.release('memory', module.PREVIOUS), module.PREVIOUS)
        self.assertEqual(module.release('memory', module.RELEASES['memory']), module.RELEASES['memory'])
        self.assertEqual(module.release('retrieval', module.RELEASES['retrieval']), module.RELEASES['retrieval'])
        for changed in [dict(current, **{'capture.py': 'f' * 64}),
                        {name: sha for name, sha in current.items() if name != 'capture.py'},
                        dict(current, **{'extra.py': 'f' * 64})]:
            with self.assertRaises(ValueError):
                module.release('memory', changed)


if __name__ == '__main__':
    unittest.main()
