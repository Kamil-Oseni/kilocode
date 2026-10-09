"""Join genuine failed/cancelled Futures without confusing published outcomes with cleanup failure."""
from concurrent.futures import Future, ThreadPoolExecutor
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
import sys
import threading
import time
from types import SimpleNamespace

path = Path(__file__).resolve().parents[2] / 'script/memory/supervise.py'
spec = importlib.util.spec_from_file_location('supervisor', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def test_exact_new_and_retained_retrieval_cohorts(self):
        for pins in (module.REUSE, module.REUSE_PREVIOUS, module.REUSED):
            self.assertEqual(module.release('retrieval', dict(pins), True), pins)
        self.assertEqual(module.REUSE['retrieval_reuse/pool.py'], hashlib.sha256((path.parent / 'retrieval_reuse/pool.py').read_bytes()).hexdigest())
        self.assertEqual(module.REUSE_PREVIOUS['retrieval_reuse/pool.py'], 'c6938930c0090dfab5369de422b659aa28410c714fc1e1ac6e88d8dcbdb0955a')
        mixed = dict(module.REUSE, **{'retrieval_reuse/entry.py': module.REUSED['retrieval_reuse/entry.py']})
        with self.assertRaises(ValueError):
            module.release('retrieval', mixed, True)

    def test_every_cold_resource_sample_preserves_original_admission_floor(self):
        root = path.parent
        sys.path[:0] = [str(root / 'retrieval_reuse'), str(root / 'retrieval')]
        import pool
        # Evaluate the exact production observation closure; pool probes and gates remain actual code.
        tree = ast.parse(path.read_text(encoding='utf-8'))
        diagnostic = next(row for row in tree.body if isinstance(row, ast.FunctionDef) and row.name == 'diagnostics')
        measured = next(row for row in diagnostic.body if isinstance(row, ast.FunctionDef) and row.name == 'measured')
        owner = SimpleNamespace(reserve=6 * pool.GIB, text=True, settle=True, owner=None,
                                revisions={'embeddinggemma-2': '914f7f89142e33e77833254d9c9b90c3cef7303b'})
        ticket = pool.Ticket('embeddings', {'model': 'embeddinggemma-2'}, time.monotonic() + 10)
        local = threading.local()
        local.current = {'pool': owner, 'ticket': ticket, 'samples': []}
        scope = dict(pool=pool, resources=pool.resources, local=local, time=time)
        exec(compile(ast.Module(body=[measured], type_ignores=[]), str(path), 'exec'), scope)
        for _ in range(35):
            free, commit = scope['measured']()
            self.assertGreater(free, 0)
            self.assertGreater(commit, 0)
        samples = local.current['samples']
        self.assertEqual(len(samples), 32)
        for row in samples:
            self.assertEqual(row['required_ram_bytes'], 6 * pool.GIB)
            self.assertEqual(row['reserve_ram_bytes'], 6 * pool.GIB)
            self.assertEqual(row['admission_headroom_bytes'], 0)
            self.assertEqual(row['model_budget_bytes'], 4 * pool.GIB)
            self.assertTrue(row['cold_gemma'])
            self.assertFalse(row['original_owner_present'])
            self.assertTrue(row['settling_enabled'])
            self.assertGreater(row['available_commit_bytes'], 0)
        self.assertFalse(pool.admitted(6 * pool.GIB - 1, 5 * pool.GIB, owner.reserve, 4 * pool.GIB, True))
        self.assertTrue(pool.admitted(6 * pool.GIB, 5 * pool.GIB, owner.reserve, 4 * pool.GIB, True))
        self.assertFalse(pool.admitted(6 * pool.GIB, 5 * pool.GIB - 1, owner.reserve, 4 * pool.GIB, True))
        self.assertNotIn('torch', sys.modules)
        self.assertNotIn('models', sys.modules)

    def record(self, outcome='cancelled'):
        pending = dict(format='raya.memory.operation.v2', request='a'*32, owner_epoch='b'*32,
                       selected_release_sha256='c'*64, kind='search', request_sha256='d'*64, status='pending')
        terminal = dict(pending, status='terminal', operation_outcome=outcome, downstream=[])
        terminal['receipt_sha256'] = hashlib.sha256(json.dumps(terminal, sort_keys=True,
            separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        with ThreadPoolExecutor(max_workers=1) as pool:
            publication = pool.submit(lambda: terminal)
            self.assertIs(publication.result(), terminal)
        return dict(pending=pending, terminal=terminal, publication=publication, phase='terminal', faults=[])

    def failure(self):
        def work():
            raise ValueError('Original inference cancelled')
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(work)
        return future

    def test_cancelled(self):
        self.assertIsNone(module.settled(self.record(), 'future', self.failure()))

    def test_failed(self):
        self.assertIsNone(module.settled(self.record('failed'), 'future', self.failure()))

    def test_unstarted_cancelled(self):
        future = Future()
        self.assertTrue(future.cancel())
        self.assertIsNone(module.settled(self.record(), 'future', future))

    def test_missing_or_failed_publication(self):
        for publication in (None, self.failure()):
            record = self.record()
            record['publication'] = publication
            with self.assertRaises(ValueError):
                module.settled(record, 'future', self.failure())

    def test_foreign_or_damaged_terminal(self):
        for field, value in (('request', 'e'*32), ('receipt_sha256', '0'*64), ('operation_outcome', 'completed')):
            record = self.record()
            record['terminal'][field] = value
            with self.assertRaises(ValueError):
                module.settled(record, 'future', self.failure())
        record = self.record()
        record['terminal'] = dict(record['terminal'])
        with self.assertRaises(ValueError):
            module.settled(record, 'future', self.failure())

    def test_faults_and_publication_errors_remain_errors(self):
        record = self.record()
        record['faults'].append(RuntimeError('Unconfirmed retirement'))
        with self.assertRaises(ValueError):
            module.settled(record, 'future', self.failure())
        for name in ('reservation', 'publication', 'terminal_write'):
            with self.assertRaises(ValueError):
                module.settled(self.record(), name, self.failure())


unittest.main()
