"""Actual independent consumer codec and durable Store; metadata fixtures only."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

SOURCE = Path(__file__).parent
for name in ('retrieval', 'retrieval_reuse', 'service'):
    sys.path.insert(0, str(SOURCE/name))
from admission import Store
from retirement import certificate, fingerprint, ledger
from receipts import completion, failure

PROTOCOL = 'raya.retrieval.request.settlement.v2'


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='raya-memory-settlement-')
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(self.tmp.name)
        self.identity = {'request': 'a' * 32, 'owner_epoch': 'b' * 32,
                         'selected_release_sha256': 'c' * 64, 'request_sha256': 'd' * 64}
        self.output = {'synthetic': True, 'values': [0.125, 1.0]}
        self.observation = {**self.identity, 'format': 'raya.retrieval.lease.observation', 'version': 2,
                            'lease': 'e' * 32, 'sequence': 1, 'original_process_running': True,
                            'original_job_membership_observed': True, 'selected_images_unchanged': True,
                            'worker': {'birth_filetime': '123456789', 'image': 'C:\\fixed\\python.exe'}}

    def parse(self, row, protocol=PROTOCOL):
        return certificate(row, self.identity['request'], self.identity['owner_epoch'],
                           self.identity['selected_release_sha256'], self.identity['request_sha256'], protocol)

    def begin(self, protocol=PROTOCOL):
        return self.store.begin(self.identity['request'], 8873, self.identity['owner_epoch'],
                                self.identity['selected_release_sha256'], 'f' * 32,
                                self.identity['request_sha256'], protocol)

    def test_independent_consumer_accepts_bound_live_metadata_without_join_claim(self):
        row = completion(self.identity, self.output, self.observation)
        self.assertEqual(self.parse(row), row)
        self.assertEqual(row['result_sha256'], fingerprint(self.output))
        self.assertNotIn('joins_observed', row)

    def test_legacy_selection_does_not_accept_v2_or_unknown_protocol(self):
        row = completion(self.identity, self.output, self.observation)
        for protocol in ('raya.retrieval.retirement.v1', 'automatic', ''):
            with self.assertRaises(ValueError):
                self.parse(row, protocol)
        self.assertFalse(self.store.pending())

    def test_actual_store_pending_and_settled_states_are_distinct_from_retirement(self):
        pending = self.begin()
        self.assertEqual(pending['format'], 'raya-retrieval-settlement-v3')
        self.assertTrue(self.store.pending())
        self.store.finish(pending, completion(self.identity, self.output, self.observation))
        saved = ledger(json.loads(self.store.retirement.read_bytes()))
        self.assertEqual(saved['status'], 'settled')
        self.assertFalse(self.store.pending())
        reopened = Store(self.tmp.name, existing=True, generation=self.store.generation)
        self.assertFalse(reopened.pending())

    def test_unconfirmed_or_mutated_evidence_keeps_actual_pending_bytes(self):
        pending = self.begin()
        before = self.store.retirement.read_bytes()
        original = completion(self.identity, self.output, self.observation)
        for key, value in [('request', 'f' * 32), ('sequence', True), ('version', 2.0),
                           ('original_process_running', 1), ('original_job_membership_observed', False),
                           ('selected_images_unchanged', False), ('joins_observed', True)]:
            row = {**original, key: value}
            row['receipt_sha256'] = fingerprint({name: item for name, item in row.items() if name != 'receipt_sha256'})
            with self.assertRaises(ValueError):
                self.store.finish(pending, row)
            self.assertEqual(self.store.retirement.read_bytes(), before)
            self.assertTrue(self.store.pending())

    def test_never_started_failure_can_settle_without_worker_exit_claim(self):
        pending = self.begin()
        row = failure(self.identity, 'cancelled')
        self.assertEqual(self.parse(row), row)
        self.store.finish(pending, row)
        self.assertFalse(self.store.pending())
        self.assertFalse(row['joins_observed'])
        self.assertNotIn('root_exit', row)

    def test_legacy_ledger_remains_retired_and_cannot_finish_with_v2(self):
        pending = self.begin('raya.retrieval.retirement.v1')
        before = self.store.retirement.read_bytes()
        with self.assertRaises(ValueError):
            self.store.finish(pending, failure(self.identity, 'cancelled'))
        self.assertEqual(self.store.retirement.read_bytes(), before)
        row = {**self.identity, 'format': 'raya.retrieval.retirement', 'version': 1, 'phase': 'retired',
               'worker_created': False, 'cleanup_outcome': 'not_started', 'joins_observed': False,
               'queued_never_created': True, 'inference_outcome': 'cancelled'}
        row['receipt_sha256'] = fingerprint(row)
        self.store.finish(pending, row)
        self.assertEqual(json.loads(self.store.retirement.read_bytes())['status'], 'retired')
        self.assertFalse(self.store.pending())


if __name__ == '__main__':
    unittest.main()
