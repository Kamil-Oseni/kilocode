"""Actual v2 metadata codec checks; synthetic evidence is not native ownership."""
from pathlib import Path
import sys
import unittest

SOURCE = Path(__file__).parent
sys.path.insert(0, str(SOURCE/'retrieval'))
sys.path.insert(0, str(SOURCE/'retrieval_reuse'))
from receipts import completion, failure, parse, seal


class Tests(unittest.TestCase):
    def setUp(self):
        self.identity = {'request': 'a' * 32, 'owner_epoch': 'b' * 32,
                         'selected_release_sha256': 'c' * 64, 'request_sha256': 'd' * 64}
        self.output = {'synthetic': True, 'value': [0.125, 1.0]}
        self.observation = {**self.identity, 'format': 'raya.retrieval.lease.observation', 'version': 2,
                            'lease': 'e' * 32, 'sequence': 1, 'original_process_running': True,
                            'original_job_membership_observed': True, 'selected_images_unchanged': True,
                            'worker': {'birth_filetime': '123456789', 'image': 'C:\\fixed\\python.exe'}}

    def test_live_completion_is_distinct_from_retirement(self):
        row = completion(self.identity, self.output, self.observation)
        self.assertEqual(parse(row, self.identity, self.output), row)
        for key in ('joins_observed', 'cleanup_outcome', 'original_handles_closed', 'root_exit'):
            self.assertNotIn(key, row)
        self.assertEqual(row['phase'], 'settled')

    def test_wrong_original_identity_is_refused(self):
        for key in self.identity:
            with self.assertRaises(ValueError):
                completion(self.identity, self.output, {**self.observation, key: 'f' * len(self.identity[key])})

    def test_boolean_sequences_and_numeric_evidence_are_refused(self):
        for key, value in [('sequence', True), ('sequence', 0), ('sequence', 33), ('version', True),
                           ('original_process_running', 1), ('original_job_membership_observed', False),
                           ('selected_images_unchanged', 1)]:
            with self.assertRaises(ValueError):
                completion(self.identity, self.output, {**self.observation, key: value})

    def test_extra_retirement_claim_is_refused(self):
        row = completion(self.identity, self.output, self.observation)
        row.pop('receipt_sha256')
        with self.assertRaises(ValueError):
            parse(seal({**row, 'joins_observed': True}), self.identity, self.output)

    def test_result_mutation_and_fingerprint_mutation_are_refused(self):
        row = completion(self.identity, self.output, self.observation)
        with self.assertRaises(ValueError):
            parse(row, self.identity, {'synthetic': True, 'value': [0.25, 1.0]})
        with self.assertRaises(ValueError):
            parse({**row, 'receipt_sha256': 'f' * 64}, self.identity)

    def test_failed_queued_request_has_no_native_retirement_claim(self):
        row = failure(self.identity, 'cancelled')
        self.assertFalse(row['worker_created'])
        self.assertFalse(row['joins_observed'])
        self.assertEqual(row['cleanup_outcome'], 'not_started')
        self.assertEqual(parse(row, self.identity), row)
        with self.assertRaises(ValueError):
            parse(row, self.identity, self.output)

    def test_failure_cannot_claim_unobserved_worker_joins(self):
        row = failure(self.identity, 'failed')
        row.pop('receipt_sha256')
        with self.assertRaises(ValueError):
            parse(seal({**row, 'worker_created': True}), self.identity)
        with self.assertRaises(ValueError):
            parse(seal({**row, 'joins_observed': 0}), self.identity)

    def test_worker_identity_shape_is_bounded(self):
        for worker in [{'birth_filetime': '0', 'image': 'C:/python.exe'},
                       {'birth_filetime': '18446744073709551616', 'image': 'C:/python.exe'},
                       {'birth_filetime': 123, 'image': 'C:/python.exe'},
                       {'birth_filetime': '123', 'image': 'x\x00y'}]:
            with self.assertRaises(ValueError):
                completion(self.identity, self.output, {**self.observation, 'worker': worker})


if __name__ == '__main__':
    unittest.main()
