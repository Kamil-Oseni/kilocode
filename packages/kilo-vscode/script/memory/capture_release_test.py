"""Actual supervisor release admission and physical current sources; no service launch."""
import hashlib
import importlib.util
from pathlib import Path
import unittest
import subprocess
import json

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('capture_supervisor_test', HERE / 'supervise.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def test_current_memory_prepare_uses_real_native_counter_without_model_stack(self):
        python = Path('D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe')
        dependencies = python.parent.parent / 'Lib/site-packages'
        body = """import importlib.util,json,os,sys
spec=importlib.util.spec_from_file_location('selected_supervisor',sys.argv[1]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
for sources in (module.CAPTURE, module.CLOSED):
    module.prepare({'kind':'memory','env':dict(os.environ),'dependencies':sys.argv[2],'source_sha256':sources})
assert 'numpy' in sys.modules and 'tokenizers' in sys.modules
assert not any(name in sys.modules for name in ('torch','transformers','scipy','sklearn'))
print(json.dumps({'counter':True,'model_stack':False}))
"""
        child = subprocess.run([str(python), '-B', '-c', body, str(HERE / 'supervise.py'), str(dependencies)],
                               capture_output=True, text=True, timeout=15, check=True,
                               creationflags=subprocess.CREATE_NO_WINDOW)
        self.assertEqual(child.stderr, '')
        self.assertEqual(json.loads(child.stdout), {'counter': True, 'model_stack': False})

    def test_actual_source_release_and_separate_legacy_selection(self):
        current = {name: hashlib.sha256((HERE / 'service' / name).read_bytes()).hexdigest() for name in module.CAPTURE}
        self.assertEqual(len(current), 13)
        self.assertEqual(module.release('memory', current), module.CAPTURE)
        self.assertEqual(module.release('memory', module.CLOSED), module.CLOSED)
        self.assertEqual({key for key in module.CAPTURE if module.CAPTURE[key] != module.CLOSED[key]}, {'index.py'})
        self.assertEqual(module.CLOSED['index.py'], 'e6f14470dbbe65d1ab6e0c2d0707253b2951bfa6ff529de6e7271c9ba376b5d7')
        for prior in module.PREVIOUS:
            self.assertEqual(module.release('memory', prior), prior)
        self.assertEqual(module.release('memory', module.RELEASES['memory']), module.RELEASES['memory'])
        self.assertEqual(module.release('retrieval', module.RELEASES['retrieval']), module.RELEASES['retrieval'])
        for changed in [dict(current, **{'capture.py': 'f' * 64}),
                        {name: sha for name, sha in current.items() if name != 'capture.py'},
                        dict(current, **{'extra.py': 'f' * 64})]:
            with self.assertRaises(ValueError):
                module.release('memory', changed)


if __name__ == '__main__':
    unittest.main()
