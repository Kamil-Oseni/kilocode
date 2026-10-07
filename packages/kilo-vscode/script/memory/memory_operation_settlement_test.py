"""Actual protected Journal publication; downstream values are metadata fixtures."""
import json
import sys
import unittest
from namespace_publication_test import Tests as Base, MODULE, HERE

sys.modules['namespace'] = MODULE
sys.path.insert(0, str(HERE/'service'))
from operations import Journal
from retirement import fingerprint

PROTOCOL = 'raya.retrieval.request.settlement.v2'


class Tests(Base):
    def journal(self, protocol=PROTOCOL):
        self.folder.rmdir()
        generations = {name: MODULE.generation(self.root if name == 'root' else self.root/name)
                       for name in ('root', 'Runs', 'Requests')}
        return Journal(str(self.root), self.sid, generations, 'e'*32, 'f'*64, protocol)

    def proof(self, result):
        row = {'format': 'raya.retrieval.request.settlement', 'version': 2, 'phase': 'settled',
               'request': 'a'*32, 'owner_epoch': 'b'*32, 'selected_release_sha256': 'c'*64,
               'request_sha256': 'd'*64, 'inference_outcome': 'completed', 'lease': '1'*32,
               'sequence': 1, 'original_process_running': True,
               'original_job_membership_observed': True, 'selected_images_unchanged': True,
               'worker': {'birth_filetime': '123456789', 'image': 'C:\\fixed\\python.exe'},
               'result_sha256': fingerprint(result)}
        return dict(row, receipt_sha256=fingerprint(row))

    def test_explicit_v2_publishes_distinct_envelope_without_join_claim(self):
        journal = self.journal()
        pending = journal.reserve('2'*32, 'search', {'query': 'synthetic'})
        result = {'results': []}
        proof = self.proof(result)
        terminal = journal.complete(pending, result, 'completed', [proof])
        self.assertEqual(pending['format'], 'raya.memory.operation.v2')
        self.assertEqual(terminal['downstream'], [proof])
        self.assertNotIn('joins_observed', terminal['downstream'][0])
        self.assertEqual(terminal['result_sha256'], fingerprint(result))
        self.assertEqual(json.loads((journal.folder/('2'*32+'-terminal.json')).read_bytes()), terminal)
        MODULE.acl(journal.folder/('2'*32+'-terminal.json'), self.sid)

    def test_legacy_journal_refuses_v2_and_preserves_original_pending(self):
        journal = self.journal('raya.retrieval.retirement.v1')
        pending = journal.reserve('2'*32, 'search', {})
        path = journal.folder/('2'*32+'-pending.json')
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            journal.complete(pending, {}, 'completed', [self.proof({})])
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((journal.folder/('2'*32+'-terminal.json')).exists())
        self.assertEqual(pending['format'], 'raya.memory.operation.v1')

    def test_v2_rejects_mixed_envelope_duplicate_proofs_and_native_claims(self):
        journal = self.journal()
        pending = journal.reserve('2'*32, 'search', {})
        proof = self.proof({})
        altered = dict(proof, joins_observed=True)
        altered['receipt_sha256'] = fingerprint({key: value for key, value in altered.items()
                                               if key != 'receipt_sha256'})
        for row, proofs in ((dict(pending, format='raya.memory.operation.v1'), [proof]),
                            (pending, [proof, proof]), (pending, [altered])):
            with self.assertRaises(ValueError):
                journal.complete(row, {}, 'completed', proofs)
        self.assertFalse((journal.folder/('2'*32+'-terminal.json')).exists())

    def test_unknown_protocol_refused_before_namespace_selection(self):
        with self.assertRaisesRegex(ValueError, 'protocol'):
            Journal('unselected', 'unselected', {}, 'e'*32, 'f'*64, 'automatic')


if __name__ == '__main__':
    unittest.main()
