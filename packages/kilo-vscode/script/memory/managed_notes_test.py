"""Actual selected-notes validator, real disposable directories, no service imports."""
import ast
import copy
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SOURCE = HERE/'supervise.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8'))
SCOPE = {'Path': Path, 'json': json, 'stat': stat}
CODE = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and
                       node.name in ('reject', 'notes')], type_ignores=[])
exec(compile(ast.fix_missing_locations(CODE), str(SOURCE), 'exec'), SCOPE)


class Tests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix='raya-memory-notes-witness-')).resolve()
        self.root = self.folder/'external'
        self.root.mkdir()
        (self.root/'System').mkdir()
        self.capsule = self.folder/'raya-memory-managed-test'
        self.capsule.mkdir()
        self.images = {HERE/'service'/'namespace.py': (HERE/'service'/'namespace.py').read_bytes()}
        self.raw = {'root': self.generation(self.root), 'system': self.generation(self.root/'System')}
        self.plan = {'kind': 'memory', 'root': str(self.capsule), 'source': str(HERE/'service'),
                     'env': {'RAYA_MEMORY_ROOT': str(self.root), 'RAYA_MEMORY_NOTE_GENERATIONS': json.dumps(self.raw)},
                     'notes_selection': {'root': str(self.root), 'system': str(self.root/'System'),
                                         'generations': {name: list(map(str, value)) for name, value in self.raw.items()}}}

    def tearDown(self):
        shutil.rmtree(self.folder)

    def generation(self, path):
        row = path.lstat()
        return [row.st_dev, row.st_ino, row.st_birthtime_ns]

    def check(self, plan=None, managed=True):
        return SCOPE['notes'](self.plan if plan is None else plan, self.images, managed)

    def inputs(self, env, selected):
        # Execute the original load path-containment loop, rather than duplicate it.
        load = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'load')
        loop = next(node for node in load.body if isinstance(node, ast.For) and
                    isinstance(node.iter, ast.Name) and node.iter.id == 'paths')
        scope = {'Path': Path, 'root': self.capsule, 'env': env, 'selected': selected,
                 'paths': list(env), 'reject': SCOPE['reject']}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[loop], type_ignores=[])), str(SOURCE), 'exec'), scope)

    def test_actual_existing_root_and_system_accept_without_service_or_mutation(self):
        before = set(sys.modules)
        self.assertEqual(self.check(), self.root)
        self.assertFalse({'server', 'numpy', 'torch', 'transformers', 'uvicorn'} & (set(sys.modules)-before))
        self.assertEqual(list((self.root/'System').iterdir()), [])

    def test_index_writes_do_not_invalidate_stable_directory_identity(self):
        (self.root/'System'/'index.sqlite').write_bytes(b'synthetic index')
        self.assertEqual(self.check(), self.root)
        self.assertEqual(self.raw['system'], self.generation(self.root/'System'))

    def test_replaced_root_and_system_refuse(self):
        for path in (self.root/'System', self.root):
            with self.subTest(path=path.name):
                held = path.with_name(path.name+'-original')
                path.rename(held)
                path.mkdir()
                if path == self.root:
                    (path/'System').mkdir()
                with self.assertRaises(ValueError):
                    self.check()
                shutil.rmtree(path)
                held.rename(path)

    def test_alias_or_linked_ancestry_refuses(self):
        alias = self.folder/'alias'
        import subprocess
        run = subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(alias), str(self.root)],
                             capture_output=True, check=True)
        self.assertEqual(run.returncode, 0)
        try:
            plan = copy.deepcopy(self.plan)
            plan['notes_selection']['root'] = str(alias)
            plan['notes_selection']['system'] = str(alias/'System')
            plan['env']['RAYA_MEMORY_ROOT'] = str(alias)
            with self.assertRaises(ValueError):
                self.check(plan)
        finally:
            alias.rmdir()

    def test_missing_wrong_system_and_foreign_environment_refuse(self):
        for name, value in (('system', str(self.folder)), ('root', str(self.folder))):
            plan = copy.deepcopy(self.plan)
            plan['notes_selection'][name] = value
            with self.assertRaises(ValueError):
                self.check(plan)
        plan = copy.deepcopy(self.plan)
        plan['env']['RAYA_MEMORY_ROOT'] = str(self.capsule)
        with self.assertRaises(ValueError):
            self.check(plan)
        (self.root/'System').rmdir()
        with self.assertRaises(FileNotFoundError):
            self.check()

    def test_malformed_rounded_and_stale_generations_refuse(self):
        for value in (None, 1, '01', '-1', '18446744073709551616', '1'*1000):
            plan = copy.deepcopy(self.plan)
            plan['notes_selection']['generations']['root'][0] = value
            with self.assertRaises(ValueError):
                self.check(plan)
        for value in (float(self.raw['root'][0]), self.raw['root'][0]+1, True):
            plan = copy.deepcopy(self.plan)
            raw = copy.deepcopy(self.raw)
            raw['root'][0] = value
            plan['env']['RAYA_MEMORY_NOTE_GENERATIONS'] = json.dumps(raw)
            with self.assertRaises(ValueError):
                self.check(plan)

    def test_duplicate_or_oversized_environment_generation_text_refuses(self):
        for raw in ('{"root":[1,2,3],"root":'+json.dumps(self.raw['root'])+',"system":'+json.dumps(self.raw['system'])+'}', ' '*4097):
            plan = copy.deepcopy(self.plan)
            plan['env']['RAYA_MEMORY_NOTE_GENERATIONS'] = raw
            with self.assertRaises(ValueError):
                self.check(plan)

    def test_witness_is_managed_memory_only_and_exact_shape(self):
        with self.assertRaises(ValueError):
            self.check(managed=False)
        plan = copy.deepcopy(self.plan)
        plan['kind'] = 'retrieval'
        with self.assertRaises(ValueError):
            self.check(plan)
        for field in ('extra', 'root'):
            plan = copy.deepcopy(self.plan)
            if field == 'extra':
                plan['notes_selection'][field] = True
            else:
                del plan['notes_selection'][field]
            with self.assertRaises(ValueError):
                self.check(plan)
        plan = copy.deepcopy(self.plan)
        plan['notes_selection'] = None
        with self.assertRaises(ValueError):
            self.check(plan)

    def test_only_exact_notes_input_gets_containment_exception(self):
        selected = self.check()
        self.inputs({'RAYA_MEMORY_ROOT': str(self.root)}, selected)
        for name in ('RAYA_MEMORY_TOKEN_FILE', 'RAYA_MEMORY_OPERATION_ROOT', 'RAYA_MEMORY_RETRIEVAL_TOKEN_FILE',
                     'RAYA_RETRIEVAL_TOKEN_FILE', 'RAYA_RETRIEVAL_RECEIPT_ROOT'):
            with self.assertRaises(ValueError):
                self.inputs({name: str(self.root)}, selected)
        with self.assertRaises(ValueError):
            self.inputs({'RAYA_MEMORY_ROOT': str(self.folder)}, selected)

    def test_absent_witness_preserves_legacy_containment(self):
        plan = copy.deepcopy(self.plan)
        del plan['notes_selection']
        self.assertIsNone(self.check(plan))
        self.inputs({'RAYA_MEMORY_ROOT': str(self.capsule/'notes')}, None)
        with self.assertRaises(ValueError):
            self.inputs({'RAYA_MEMORY_ROOT': str(self.root)}, None)


if __name__ == '__main__':
    unittest.main()
