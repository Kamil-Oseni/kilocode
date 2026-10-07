"""Actual disposable Python capsule/job/ACL receipts; no model inference."""
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import threading
import time
import unittest
import uuid

SOURCE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('namespace_fixture', SOURCE/'namespace_publication_test.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


@unittest.skipUnless(os.name == 'nt', 'Actual Windows native owner required')
class Tests(unittest.TestCase):
    cleanup = fixture.Tests.cleanup

    def setUp(self):
        fixture.Tests.setUp(self)
        self.capsule = self.root/'raya-memory-managed-reuse-test'
        self.capsule.mkdir()
        source = self.capsule/'source'
        source.mkdir()
        for name in ('retrieval', 'retrieval_reuse'):
            shutil.copytree(SOURCE/name, source/name)
        for name in ('home', 'tmp', 'hf', 'dependencies'):
            (self.capsule/name).mkdir()
        shutil.copytree(r'D:/Raya/Services/Packaging/Python/3.12.14', self.capsule/'python',
                        ignore=shutil.ignore_patterns('site-packages', '__pycache__', 'include', 'libs', 'tcl'))
        self.previous = {name: sys.modules.get(name) for name in ('owner', 'lease', 'living', 'validation')}
        self.paths = list(sys.path)
        self.addCleanup(self.restore)
        for name in self.previous:
            sys.modules.pop(name, None)
        sys.path.insert(0, str(source/'retrieval'))
        sys.path.insert(0, str(source/'retrieval_reuse'))
        spec = importlib.util.spec_from_file_location('selected_reuse_session', source/'retrieval_reuse'/'session.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.owner = self.module.Owner(uuid.uuid4().hex, uuid.uuid4().hex, 'a' * 64,
                                       'embeddings', 'qwen3-embedding-0.6b', threading.Event(),
                                       self.fence, self.namespace,
                                       idle=90 if self._testMethodName == 'test_actual_lifetime_expiry' else 0.05,
                                       lifetime=1 if self._testMethodName == 'test_actual_lifetime_expiry' else 10)
        self.fenced = False
        self.addCleanup(self.retire)

    def fence(self):
        self.fenced = True

    def restore(self):
        sys.path[:] = self.paths
        for name, value in self.previous.items():
            if value is None:
                sys.modules.pop(name, None)
                continue
            sys.modules[name] = value

    def retire(self):
        self.owner.retire(True)
        self.assertEqual(self.owner.handles, {})

    def joined(self, value):
        self.assertEqual(value['phase'], 'terminal')
        self.assertEqual(value['cleanup_outcome'], 'joined')
        self.assertTrue(value['joins_observed'])
        self.assertTrue(value['writer_joined'])
        self.assertEqual(value['job_active'], 0)
        self.assertEqual(self.owner.handles, {})

    def test_ready_and_natural_eof_retirement(self):
        with self.assertRaisesRegex(ValueError, 'retained_owner_requires_start_and_retire'):
            self.owner.run()
        self.assertFalse(self.owner.created)
        value = self.owner.start()
        self.assertTrue(self.owner.ready)
        self.assertTrue(value['creation']['creation_time_job_list'])
        self.assertEqual(self.owner.frames, 0)
        receipt = self.owner.retire()
        self.joined(receipt)
        self.assertEqual(receipt['root_exit'], 0)
        self.assertFalse(receipt['ownership_retained'])

    def test_forced_retirement_keeps_original_cleanup(self):
        self.owner.start()
        value = self.owner.retire(True)
        self.joined(value)
        self.assertEqual(value['root_exit'], 1)
        self.assertTrue(self.owner.cancel.is_set())

    def test_actual_idle_expiry(self):
        self.owner.start()
        time.sleep(0.06)
        value = self.owner.tick()
        self.joined(value)
        self.assertEqual(value['root_exit'], 0)

    def test_actual_lifetime_expiry(self):
        self.owner.start()
        time.sleep(1.1)
        value = self.owner.tick()
        self.joined(value)
        self.assertEqual(value['root_exit'], 1)

    def test_pre_cancelled_request_is_not_admitted(self):
        self.owner.start()
        cancel = threading.Event()
        cancel.set()
        with self.assertRaisesRegex(ValueError, 'lease_owner_closed'):
            self.owner.exchange(uuid.uuid4().hex, {'model': self.owner.model, 'input': ['not admitted']},
                                'unused-revision', cancel, time.monotonic() + 2)
        self.assertEqual(self.owner.lease.sequence, 0)
        self.joined(self.owner.state)

    def test_invalid_request_has_no_completion_and_joins(self):
        self.owner.start()
        with self.assertRaises(ValueError):
            self.owner.exchange(uuid.uuid4().hex, {'model': self.owner.model, 'input': []},
                                'unused-revision', threading.Event(), time.monotonic() + 2)
        self.assertEqual(self.owner.frames, 0)
        self.joined(self.owner.state)
        self.assertNotEqual(self.owner.state['root_exit'], 0)


if __name__ == '__main__':
    unittest.main()
