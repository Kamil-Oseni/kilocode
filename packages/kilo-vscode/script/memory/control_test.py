"""Exact control release schema and source-image checks without starting control/services."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('raya_control', HERE/'control.py')
CONTROL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROL)


class Control(unittest.TestCase):
    def setUp(self):
        self.source = HERE/'service'
        self.pins = {name: hashlib.sha256((self.source/name).read_bytes()).hexdigest() for name in CONTROL.FILES}

    def test_exact_eleven_release_and_catalog_bridge_binding(self):
        self.assertEqual(len(CONTROL.FILES), 11)
        self.assertIn('dispatch.py', CONTROL.FILES)
        self.assertIn('historical.py', CONTROL.FILES)
        catalog = (HERE.parents[1]/'src/second-brain/control/catalog-v2.ts').read_text()
        for name, digest in self.pins.items():
            self.assertIn(json.dumps(name)+': '+json.dumps(digest), catalog)
        selected = re.search(r'export const bridge = "([a-f0-9]{64})"', catalog).group(1)
        self.assertEqual(selected, hashlib.sha256((HERE/'control.py').read_bytes()).hexdigest())
        CONTROL.fields(self.pins, CONTROL.FILES)

    def test_missing_extra_and_renamed_selected_source_refused(self):
        missing = dict(self.pins)
        missing.pop('historical.py')
        extra = {**self.pins, 'foreign.py': '0'*64}
        renamed = dict(self.pins)
        renamed['elsewhere.py'] = renamed.pop('dispatch.py')
        for pins in (missing, extra, renamed):
            with self.assertRaises(ValueError):
                CONTROL.fields(pins, CONTROL.FILES)

    def test_actual_image_verification_includes_new_images(self):
        owner = CONTROL.Bridge.__new__(CONTROL.Bridge)
        owner.source = self.source
        owner.generation = {self.source: CONTROL.directory(self.source)}
        owner.pins = dict(self.pins)
        owner.modules = {}
        owner.check()
        for name in ('dispatch.py', 'historical.py'):
            with self.subTest(name=name):
                digest = owner.pins[name]
                owner.pins[name] = '0'*64
                with self.assertRaises(ValueError):
                    owner.check()
                owner.pins[name] = digest
        owner.check()

    def test_strict_json_refusals(self):
        for value in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":'):
            with self.assertRaises(ValueError):
                CONTROL.decode(value)


if __name__ == '__main__':
    unittest.main()
