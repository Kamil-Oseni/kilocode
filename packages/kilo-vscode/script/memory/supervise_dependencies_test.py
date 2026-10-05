"""Actual dependency verifier/executor over real files; no service/model imports."""
import ast
from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import tempfile
import threading
import unittest

SOURCE = Path(__file__).resolve().parent/'supervise.py'
TREE = ast.parse(SOURCE.read_bytes())
NAMES = {'reject', 'stable', 'verify', 'dependencies'}
CODE = compile(ast.fix_missing_locations(ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in NAMES], type_ignores=[])), str(SOURCE), 'exec')


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raya-supervisor-verification-')
        self.root = Path(self.temp.name).resolve()
        self.scope = {'Path': Path, 'os': os, 'stat': __import__('stat'), 'hashlib': hashlib, 'ThreadPoolExecutor': ThreadPoolExecutor}
        exec(CODE, self.scope)

    def tearDown(self):
        self.temp.cleanup()

    def row(self, name, raw=b'reviewed synthetic bytes'):
        file = self.root/name
        file.write_bytes(raw)
        info = file.lstat()
        return {'path': str(file), 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                'identity': [getattr(info, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')]}

    def test_full_multibatch_exact_order_and_selected_bytes(self):
        rows = [self.row(str(i), bytes([i % 256])*1025) for i in range(130)]
        selected = {Path(row['path']) for row in rows[::10]}
        paths, images = self.scope['dependencies'](rows, selected)
        self.assertEqual(paths, {Path(row['path']) for row in rows})
        self.assertEqual(list(images), [Path(row['path']) for row in rows if Path(row['path']) in selected])
        for file, raw in images.items():
            self.assertEqual(raw, file.read_bytes())

    def test_duplicate_rejected_before_any_original_task(self):
        row = self.row('duplicate')
        Path(row['path']).unlink()
        with self.assertRaisesRegex(ValueError, 'Duplicate dependency path'):
            self.scope['dependencies']([row, row], set())

    def test_hash_refusal_and_no_later_batch(self):
        rows = [self.row(str(i)) for i in range(65)]
        rows[0]['sha256'] = 'a'*64
        Path(rows[64]['path']).unlink()
        with self.assertRaises(BaseExceptionGroup) as caught:
            self.scope['dependencies'](rows, set())
        self.assertEqual(len(caught.exception.exceptions), 1)
        self.assertIsInstance(caught.exception.exceptions[0], ValueError)
        self.assertIn('source/dependency differs', str(caught.exception.exceptions[0]))

    def test_identity_drift_refused(self):
        row = self.row('changed')
        Path(row['path']).write_bytes(b'different reviewed bytes')
        with self.assertRaises(BaseExceptionGroup):
            self.scope['dependencies']([row], set())

    def test_original_held_read_and_every_future_join_before_failure(self):
        rows = [self.row(str(i)) for i in range(10)]
        rows[0]['sha256'] = 'a'*64
        entered = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        guard = threading.Lock()
        seen = []
        result = []
        original = self.scope['verify']

        def held(item, retain):
            # A genuine file handle remains held while the real executor has
            # another failed task. All validation is the original verifier.
            if item['path'] == rows[1]['path']:
                with Path(item['path']).open('rb') as reader:
                    entered.set()
                    release.wait()
                    self.assertEqual(reader.read(), b'reviewed synthetic bytes')
            try:
                return original(item, retain)
            finally:
                with guard:
                    seen.append(item['path'])

        self.scope['verify'] = held

        def run():
            try:
                self.scope['dependencies'](rows, set())
            except BaseException as error:
                result.append(error)
            finally:
                finished.set()

        child = threading.Thread(target=run)
        child.start()
        try:
            self.assertTrue(entered.wait(5))
            self.assertFalse(finished.wait(.05))
        finally:
            release.set()
            child.join(5)
        self.assertFalse(child.is_alive())
        self.assertEqual(set(seen), {row['path'] for row in rows})
        self.assertEqual(len(seen), len(rows))
        self.assertEqual(len(result), 1)
        self.assertIsInstance(result[0], BaseExceptionGroup)

    def test_actual_load_joins_before_namespace_or_service_authority(self):
        load = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'load')
        call = next(i for i, node in enumerate(load.body) if isinstance(node, ast.Assign) and ast.unparse(node.value).startswith('dependencies('))
        namespace = next(i for i, node in enumerate(load.body) if isinstance(node, ast.If) and ast.unparse(node.test) == 'managed')
        self.assertLess(call, namespace)
        main = next(node for node in TREE.body if isinstance(node, ast.If) and '__name__' in ast.unparse(node.test))
        text = ast.unparse(main)
        self.assertLess(text.index('load('), text.index('gate()'))
        self.assertLess(text.index('gate()'), text.index('serve('))

    def test_partial_submission_failure_joins_original_submitted_tasks(self):
        rows = [self.row(str(i)) for i in range(4)]
        original = self.scope['verify']
        seen = []

        def recorded(item, retain):
            try:
                return original(item, retain)
            finally:
                seen.append(item['path'])

        class Refusing(ThreadPoolExecutor):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.count = 0

            def submit(self, *args, **kwargs):
                self.count += 1
                if self.count == 3:
                    raise RuntimeError('synthetic original submission refusal')
                return super().submit(*args, **kwargs)

        self.scope['verify'] = recorded
        self.scope['ThreadPoolExecutor'] = Refusing
        with self.assertRaises(BaseExceptionGroup) as caught:
            self.scope['dependencies'](rows, set())
        self.assertEqual(set(seen), {row['path'] for row in rows[:2]})
        self.assertEqual(len(caught.exception.exceptions), 1)
        self.assertIsInstance(caught.exception.exceptions[0], RuntimeError)


if __name__ == '__main__':
    unittest.main()
