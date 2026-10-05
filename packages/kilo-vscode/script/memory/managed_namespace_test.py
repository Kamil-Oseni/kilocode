"""Actual managed pre-START namespace validator; protected synthetic directories only."""
import ast
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from namespace_publication_test import Tests as Base, MODULE, HERE

SOURCE = HERE/'supervise.py'
TREE = ast.parse(SOURCE.read_text(encoding='utf-8'))
CODE = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and
                       node.name in ('reject', 'namespaces')], type_ignores=[])
SCOPE = {'Path': Path, 'json': json}
exec(compile(ast.fix_missing_locations(CODE), str(SOURCE), 'exec'), SCOPE)


class Tests(Base):
    def home(self, managed, env):
        load = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'load')
        nodes = [node for node in load.body if
                 isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'home'
                                                     for target in node.targets) or
                 isinstance(node, ast.If) and "env.get('HOME')" in ast.get_source_segment(SOURCE.read_text(encoding='utf-8'), node)]
        self.assertEqual(len(nodes), 2)
        scope = {'root': self.root, 'managed': managed, 'env': env, 'reject': SCOPE['reject']}
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(SOURCE), 'exec'), scope)

    def test_managed_home_guard_requires_exact_private_home(self):
        expected = str(self.root/'home')
        self.home(True, {'HOME': expected, 'USERPROFILE': expected})
        for env in ({'HOME': str(self.root), 'USERPROFILE': str(self.root)},
                    {'HOME': expected, 'USERPROFILE': str(self.root)},
                    {'HOME': str(self.root/'foreign'), 'USERPROFILE': expected}, {}):
            with self.assertRaises(ValueError):
                self.home(True, env)

    def test_disposable_home_guard_still_requires_original_root(self):
        expected = str(self.root)
        self.home(False, {'HOME': expected, 'USERPROFILE': expected})
        with self.assertRaises(ValueError):
            self.home(False, {'HOME': str(self.root/'home'), 'USERPROFILE': str(self.root/'home')})

    def plan(self, kind='memory'):
        generations = {name: MODULE.generation(self.root if name == 'root' else self.root/name)
                       for name in ('root', 'Runs', 'Requests')}
        def selection(prefix):
            return {prefix+'_ROOT': str(self.root), prefix+'_SID': self.sid,
                    prefix+'_GENERATIONS': json.dumps(generations)}
        plan = {'kind': kind, 'root': str(self.root.parent), 'source': str(HERE/'service'),
                'env': selection('RAYA_MEMORY_OPERATION' if kind == 'memory' else 'RAYA_RETRIEVAL_RECEIPT')}
        if kind == 'memory':
            plan['retrieval_selection'] = selection('RAYA_RETRIEVAL_RECEIPT')
        return plan

    def check(self, plan):
        SCOPE['namespaces'](plan, {HERE/'service'/'namespace.py': (HERE/'service'/'namespace.py').read_bytes()})

    def test_actual_selected_namespace_is_accepted_without_service_import(self):
        before = set(sys.modules)
        self.check(self.plan())
        self.assertFalse({'server', 'numpy', 'transformers', 'uvicorn'} & (set(sys.modules)-before))
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_retrieval_own_selected_namespace_is_accepted_before_start(self):
        before = set(sys.modules)
        self.check(self.plan('retrieval'))
        self.assertFalse({'server', 'numpy', 'torch', 'transformers', 'uvicorn'} & (set(sys.modules)-before))
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_retrieval_foreign_stale_missing_and_rounded_namespace_refuse(self):
        original = self.plan('retrieval')
        for field, value in (('RAYA_RETRIEVAL_RECEIPT_SID', 'S-1-5-21-1-2-3-1001'),
                             ('RAYA_RETRIEVAL_RECEIPT_ROOT', str(self.root.parent.parent))):
            plan = copy.deepcopy(original)
            plan['env'][field] = value
            with self.assertRaises((ValueError, BaseExceptionGroup)):
                self.check(plan)
        for rounded in (False, True):
            plan = copy.deepcopy(original)
            value = json.loads(plan['env']['RAYA_RETRIEVAL_RECEIPT_GENERATIONS'])
            value['Requests'][1] = float(value['Requests'][1]) if rounded else value['Requests'][1]+1
            plan['env']['RAYA_RETRIEVAL_RECEIPT_GENERATIONS'] = json.dumps(value)
            with self.assertRaises(ValueError):
                self.check(plan)
        plan = copy.deepcopy(original)
        del plan['env']['RAYA_RETRIEVAL_RECEIPT_GENERATIONS']
        with self.assertRaises(KeyError):
            self.check(plan)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_stale_original_generation_refuses_before_gate(self):
        plan = self.plan()
        value = json.loads(plan['env']['RAYA_MEMORY_OPERATION_GENERATIONS'])
        value['root'][1] += 1
        plan['env']['RAYA_MEMORY_OPERATION_GENERATIONS'] = json.dumps(value)
        with self.assertRaises(ValueError):
            self.check(plan)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_retrieval_selection_cannot_be_missing_foreign_or_outside(self):
        original = self.plan()
        for field, value in (('RAYA_RETRIEVAL_RECEIPT_SID', 'S-1-5-21-1-2-3-1001'),
                             ('RAYA_RETRIEVAL_RECEIPT_ROOT', str(self.root.parent.parent))):
            plan = copy.deepcopy(original)
            plan['retrieval_selection'][field] = value
            with self.assertRaises((ValueError, BaseExceptionGroup)):
                self.check(plan)
        plan = copy.deepcopy(original)
        del plan['retrieval_selection']
        with self.assertRaises(ValueError):
            self.check(plan)

    def test_unsafe_integer_generation_is_not_rounded_into_acceptance(self):
        plan = self.plan()
        value = json.loads(plan['retrieval_selection']['RAYA_RETRIEVAL_RECEIPT_GENERATIONS'])
        self.assertTrue(any(number > 2**53 for row in value.values() for number in row))
        value['root'][0] = float(value['root'][0])
        plan['retrieval_selection']['RAYA_RETRIEVAL_RECEIPT_GENERATIONS'] = json.dumps(value)
        with self.assertRaises(ValueError):
            self.check(plan)


del Base  # Do not collect the inherited three baseline tests a second time.

if __name__ == '__main__':
    unittest.main()
