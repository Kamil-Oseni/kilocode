"""Execute exact server admission/callback AST without importing models or tokens.

The synthetic work and empty downstream store are explicit dependency boundaries;
Journal, protected Windows namespace, fsync, pools, deadlines and callbacks are real.
"""
import ast
import asyncio
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from dispatch_test import Tests as Dispatch, HERE, MODULE
from namespace_publication_test import Tests as Base
from dispatch import prepare, submit
from admission import Retirement, failures
from retirement import fingerprint


def extract(path, names, scope):
    tree = ast.parse(path.read_text())
    rows = [row for row in tree.body if isinstance(row, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and row.name in names]
    if {row.name for row in rows} != set(names):
        raise ValueError('Exact production functions required.')
    exec(compile(ast.Module(body=rows, type_ignores=[]), str(path), 'exec'), scope)


class Tests(Base):
    journal = Dispatch.journal
    sticky = Dispatch.sticky

    def scope(self, journal, pool, storage):
        scope = dict(asyncio=asyncio, threading=threading, time=time, hashlib=hashlib,
                     ROOT=HERE/'service', JOURNAL=journal, SOURCE=self.source,
                     prepare=prepare, submit=submit, Retirement=Retirement, failures=failures,
                     fingerprint=fingerprint, GUARD=threading.Lock(), ACTIVE=1,
                     UNCERTAIN=False, SLOTS=threading.BoundedSemaphore(1),
                     POOL=pool, STORAGE=storage,
                     INDEX=SimpleNamespace(store=SimpleNamespace(pending=lambda: [])),
                     contextmanager=contextmanager)
        scope['SLOTS'].acquire()
        for name in ('CANCEL', 'DEADLINE', 'CORRELATION', 'PROOFS'):
            scope[name] = ContextVar(name, default=None)
        extract(HERE/'service'/'index.py', ('Cancelled', 'remaining', 'operation', 'execute'), scope)
        extract(HERE/'service'/'server.py', ('admit', 'integrity', 'finish', 'published', 'settled', 'fence'), scope)
        return scope

    def record(self):
        return dict(request='1'*32, phase='reserving', cancel=threading.Event(), proofs=[],
                    pending=None, terminal=None, future=None, publication=None,
                    reservation=None, faults=[])

    def terminal(self, record):
        until = time.monotonic()+5
        while record['terminal'] is None and not record['faults'] and time.monotonic() < until:
            time.sleep(0.001)
        self.assertFalse(record['faults'])
        self.assertIsNotNone(record['terminal'])
        self.assertTrue(record['reservation'].done())
        self.assertTrue(record['future'].done())
        self.assertTrue(record['publication'].done())
        return record['terminal']

    def test_actual_server_admission_fsync_original_future_and_terminal(self):
        journal = self.journal()
        record = self.record()
        flushes = []
        original = os.fsync
        def observe(fd):
            original(fd)
            flushes.append(os.fstat(fd).st_ino)
        def work():
            self.assertEqual(len(flushes), 2)
            self.assertEqual(record['pending']['status'], 'pending')
            self.assertEqual(len(list(journal.folder.glob('*.json'))), 2)
            return {'results': [], 'capture_enabled': False}
        os.fsync = observe
        try:
            with ThreadPoolExecutor(max_workers=1) as pool, ThreadPoolExecutor(max_workers=1) as storage:
                scope = self.scope(journal, pool, storage)
                future = asyncio.run(scope['admit'](record, '1'*32, 'search', {'query':'synthetic','top':5}, work))
                self.assertIs(future, record['future'])
                self.assertEqual(future.result(), {'results': [], 'capture_enabled': False})
                self.assertEqual(self.terminal(record)['operation_outcome'], 'completed')
                self.assertEqual(scope['ACTIVE'], 0)
                self.assertTrue(scope['SLOTS'].acquire(blocking=False))
        finally:
            os.fsync = original

    def test_actual_server_cancel_between_reservation_and_submission(self):
        journal = self.journal()
        record = self.record()
        record['cancel'].set()
        with ThreadPoolExecutor(max_workers=1) as pool, ThreadPoolExecutor(max_workers=1) as storage:
            scope = self.scope(journal, pool, storage)
            with self.assertRaises(scope['Cancelled']):
                asyncio.run(scope['admit'](record, '1'*32, 'search', {'query':'synthetic','top':5}, lambda: self.fail('Body admitted')))
        self.assertIsNone(record['future'])
        self.assertEqual(len(list(journal.folder.glob('*.json'))), 2)
        self.sticky(journal)

    def test_actual_server_reservation_timeout_never_submits_late_body(self):
        journal = self.journal()
        record = self.record()
        gate = threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool, ThreadPoolExecutor(max_workers=1) as storage:
            blocker = storage.submit(gate.wait)
            scope = self.scope(journal, pool, storage)
            try:
                with self.assertRaises(asyncio.TimeoutError):
                    asyncio.run(scope['admit'](record, '1'*32, 'search', {'query':'synthetic','top':5}, lambda: self.fail('Body admitted')))
                scope['fence'](record, TimeoutError())
            finally:
                gate.set()
            blocker.result()
            prepared = record['reservation'].result()
            self.assertEqual(prepared['pending']['status'], 'pending')
        self.assertIsNone(record['future'])
        self.assertIsNone(record['pending'])
        self.assertTrue(scope['UNCERTAIN'])
        self.sticky(journal)

    def test_actual_queued_pool_cancellation_does_not_enter_work(self):
        journal = self.journal()
        record = self.record()
        gate = threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool, ThreadPoolExecutor(max_workers=1) as storage:
            blocker = pool.submit(gate.wait)
            scope = self.scope(journal, pool, storage)
            future = asyncio.run(scope['admit'](record, '1'*32, 'search', {'query':'synthetic','top':5}, lambda: self.fail('Body admitted')))
            record['cancel'].set()
            gate.set()
            blocker.result()
            with self.assertRaises(Exception):
                future.result()
            self.assertEqual(self.terminal(record)['operation_outcome'], 'cancelled')


if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests))
    raise SystemExit(not result.wasSuccessful())
