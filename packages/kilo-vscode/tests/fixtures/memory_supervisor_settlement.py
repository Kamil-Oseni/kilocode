"""Join genuine failed/cancelled Futures without confusing published outcomes with cleanup failure."""
from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / 'script/memory/supervise.py'
spec = importlib.util.spec_from_file_location('supervisor', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
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
