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
from pool import available, resources, budget, admitted, GIB, Pool, Ticket, Redirect
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

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

    def test_selected_text_budget_and_actual_commit_boundaries(self):
        revision = '914f7f89142e33e77833254d9c9b90c3cef7303b'
        self.assertEqual(budget('embeddings', 'embeddinggemma-2', revision, True), 4*GIB)
        for kind, selected, image in [('embeddings', False, revision), ('media', True, revision), ('embeddings', True, 'a'*40)]:
            self.assertEqual(budget(kind, 'embeddinggemma-2', image, selected), 5*GIB)
        self.assertTrue(admitted(6*GIB, 5*GIB, 6*GIB, 4*GIB, True))
        self.assertFalse(admitted(6*GIB-1, 5*GIB, 6*GIB, 4*GIB, True))
        self.assertFalse(admitted(6*GIB, 5*GIB-1, 6*GIB, 4*GIB, True))
        self.assertTrue(admitted(6*GIB, 5*GIB, 6*GIB, 5*GIB, True))
        self.assertFalse(admitted(6*GIB, 5*GIB, 6*GIB, GIB//2, False))
        self.assertTrue(admitted(6*GIB+GIB//2, 0, 6*GIB, GIB//2, False))
        self.assertFalse(admitted(8*GIB-1, 5*GIB, 8*GIB, 4*GIB, True))
        self.assertTrue(admitted(8*GIB, 5*GIB, 8*GIB, 4*GIB, True))
        self.assertFalse(admitted(6*GIB-1, 5*GIB, 4*GIB, 4*GIB, True))
        self.assertTrue(admitted(6*GIB, 5*GIB, 4*GIB, 4*GIB, True))
        self.assertTrue(all(value > 0 for value in resources()))

    def test_settling_cancelled_and_expired_before_any_worker(self):
        ticket = Ticket('embeddings', self.body(), time.monotonic()+1)
        ticket.cancel.set()
        with self.assertRaisesRegex(ValueError, 'cancelled_or_expired'):
            self.pool.settling(ticket, 4*GIB)
        ticket.cancel.clear()
        ticket.until = time.monotonic()-1
        with self.assertRaisesRegex(ValueError, 'cancelled_or_expired'):
            self.pool.settling(ticket, 4*GIB)
        self.assertIsNone(self.pool.owner)

    def test_residency_opener_refuses_redirect_before_destination(self):
        hits = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/destination')
                self.end_headers()
            def log_message(self, *args):
                return
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirect())
            with self.assertRaises(urllib.error.HTTPError) as raised:
                opener.open(f'http://127.0.0.1:{server.server_port}/source', timeout=1)
            raised.exception.close()
            self.assertEqual(hits, ['/source'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

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
