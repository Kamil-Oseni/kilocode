"""Actual bounded coordinator, timers, RAM query and ACL namespace; no inference."""
import importlib.util
from pathlib import Path
import sys
import time
import unittest
import uuid

SOURCE = Path(__file__).parent
sys.path.insert(0, str(SOURCE/'retrieval'))
sys.path.insert(0, str(SOURCE/'retrieval_reuse'))
from pool import available, Pool

spec = importlib.util.spec_from_file_location('pool_namespace_fixture', SOURCE/'namespace_publication_test.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class Tests(unittest.TestCase):
    cleanup = fixture.Tests.cleanup

    def setUp(self):
        fixture.Tests.setUp(self)
        self.pool = Pool(uuid.uuid4().hex, 'a' * 64, {'qwen3-embedding-0.6b': 'b' * 40}, self.namespace)
        self.addCleanup(self.join)

    def join(self):
        value = self.pool.close()
        self.assertTrue(value['closed'])
        self.assertTrue(value['original_coordinator_joined'])
        self.assertFalse(value['ownership_retained'])

    def body(self):
        return {'model': 'qwen3-embedding-0.6b', 'input': ['Synthetic queued request.']}

    def test_four_total_admissions_and_no_hidden_executor(self):
        tickets = [self.pool.submit('embeddings', self.body(), time.monotonic() + 2) for _ in range(4)]
        with self.assertRaisesRegex(ValueError, 'pool_capacity'):
            self.pool.submit('embeddings', self.body(), time.monotonic() + 2)
        self.assertIsNone(self.pool.thread)
        self.assertIsNone(self.pool.owner)
        for ticket in tickets:
            ticket.cancel.set()
        self.pool.start()
        for ticket in tickets:
            self.assertTrue(ticket.done.wait(1))
            self.assertEqual(ticket.error, 'pool_queue_cancelled')
            self.assertIsNone(ticket.body)
        self.assertIsNone(self.pool.owner)

    def test_actual_queue_expiry_without_worker_creation(self):
        ticket = self.pool.submit('embeddings', self.body(), time.monotonic() + 0.01)
        time.sleep(0.03)
        self.pool.start()
        self.assertTrue(ticket.done.wait(1))
        self.assertEqual(ticket.error, 'pool_queue_expired')
        self.assertIsNone(self.pool.owner)

    def test_snapshot_cannot_be_changed_by_submitter(self):
        body = self.body()
        ticket = self.pool.submit('embeddings', body, time.monotonic() + 2)
        body['input'][0] = 'Changed after admission.'
        self.assertEqual(ticket.body['input'], ['Synthetic queued request.'])
        self.pool.close()
        self.assertTrue(ticket.done.is_set())
        self.assertEqual(ticket.error, 'pool_closed')
        with self.assertRaisesRegex(ValueError, 'pool_admission_closed'):
            self.pool.submit('embeddings', self.body(), time.monotonic() + 2)

    def test_invalid_admission_releases_capacity(self):
        for body in [{'model': []}, {**self.body(), 'input': []}, {**self.body(), 'extra': True}]:
            with self.assertRaises(ValueError):
                self.pool.submit('embeddings', body, time.monotonic() + 2)
        tickets = [self.pool.submit('embeddings', self.body(), time.monotonic() + 2) for _ in range(4)]
        self.assertEqual(len(tickets), 4)

    def test_real_ram_policy_denies_before_native_creation(self):
        self.assertGreater(available(), 0)
        self.pool.reserve = 1 << 50  # A deliberately impossible reserve; actual OS measurement is used.
        ticket = self.pool.submit('embeddings', self.body(), time.monotonic() + 2)
        self.pool.start()
        self.assertTrue(ticket.done.wait(1))
        self.assertEqual(ticket.error, 'pool_memory_reserve')
        self.assertIsNone(self.pool.owner)

    def test_rejects_duplicate_start_and_expired_admission(self):
        with self.assertRaisesRegex(ValueError, 'pool_deadline'):
            self.pool.submit('embeddings', self.body(), time.monotonic() - 1)
        self.pool.start()
        with self.assertRaisesRegex(ValueError, 'pool_already_started_or_closed'):
            self.pool.start()

    def test_pause_cancels_original_queue_and_resume_does_not_replay_it(self):
        self.pool.reserve = 1 << 50
        tickets = [self.pool.submit('embeddings', self.body(), time.monotonic()+2) for _ in range(4)]
        with self.pool.condition:
            self.pool.start()
            original = self.pool.thread
            self.pool.pause()
        self.assertTrue(self.pool.drained.wait(1))
        self.assertTrue(self.pool.quiet())
        for ticket in tickets:
            self.assertTrue(ticket.done.is_set())
            self.assertTrue(ticket.cancel.is_set())
            self.assertIsNone(ticket.body)
            self.assertIsNone(ticket.owner)
        with self.assertRaisesRegex(ValueError, 'pool_admission_closed'):
            self.pool.submit('embeddings', self.body(), time.monotonic()+2)
        self.pool.resume()
        self.assertIs(self.pool.thread, original)
        self.assertTrue(original.is_alive())
        current = self.pool.submit('embeddings', self.body(), time.monotonic()+2)
        self.assertTrue(current.done.wait(1))
        self.assertEqual(current.error, 'pool_memory_reserve')
        self.assertIsNone(current.owner)


if __name__ == '__main__':
    unittest.main()
