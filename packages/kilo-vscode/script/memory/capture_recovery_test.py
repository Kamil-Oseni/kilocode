"""Actual ASGI publication, policy refresh and read-only recovery verification."""
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import unittest
import uuid
import sys
import httpx
import capture_http_test as support
from capture_recovery import review


class Recovery(unittest.TestCase):
    def setUp(self):
        fixture = support.HTTP('test_capture_auth_original_epoch_publication_and_no_replay')
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        for name in ['root', 'notes', 'key', 'server', 'body', 'sha']:
            setattr(self, name, getattr(fixture, name))
        from admission import Store
        file = self.notes / 'README.md'
        file.write_bytes(b'# Synthetic index entry\n')
        self.sha = Store(self.notes, existing=True).replace(
            dict(format='raya-general-sources-v1', root=str(self.notes), enabled=True, revision=2,
                 files=[dict(relative='README.md', sha256=hashlib.sha256(file.read_bytes()).hexdigest(),
                             classification='general', review='approved')]), self.sha)
        async def publish():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.server.app),
                                         base_url='http://127.0.0.1:8874') as client:
                body = dict(publication=self.body, expected_policy_sha256=self.sha)
                headers = {'Authorization': 'Bearer ' + self.key, 'X-Raya-Memory-Request-ID': uuid.uuid4().hex,
                           'X-Raya-Memory-Owner-Epoch': self.server.EPOCH}
                result = await client.post('/v1/memory/capture', json=body, headers=headers)
                self.assertEqual(result.status_code, 200, result.text)
                return result.json()
        self.result = asyncio.run(publish())
        from capture import refresh
        refresh(self.notes, self.body['id'], self.result['input_sha256'], self.sha, lambda: None)
        self.cfg = dict(source=str(Path(__file__).parent / 'service'), root=str(self.notes),
                        pins=self.server.SOURCE, bodySHA=self.result['operation']['request_sha256'],
                        resultSHA=self.result['operation']['result_sha256'],
                        turn=dict(id=self.body['id'], project=self.body['project'], sessionID=self.body['session'],
                                  messageID=self.body['message'], source_sha256=self.body['source_sha256']))

    def inventory(self):
        return {str(file.relative_to(self.root)): hashlib.sha256(file.read_bytes()).hexdigest()
                for file in self.root.rglob('*') if file.is_file()}

    def test_committed_effect_and_original_request_are_verified_without_writes(self):
        before = self.inventory()
        value = review(self.cfg)
        self.assertEqual(value['result'], {key: item for key, item in self.result.items() if key != 'operation'})
        self.assertEqual(value['previousPolicySHA'], self.sha)
        self.assertFalse(value['requestSettlement'])
        self.assertFalse(value['replay'])
        self.assertFalse(value['indexConfirmed'])
        self.assertEqual(self.inventory(), before)

    def test_changed_current_note_and_original_snapshot_are_refused(self):
        files = [self.notes / 'Preferences/Raya.md',
                 self.notes / 'System' / 'Changes' / self.body['id'] / 'after-0.md',
                 self.notes / 'System' / 'Changes' / self.body['id'] / 'source-0.txt']
        for file in files:
            raw = file.read_bytes()
            file.write_bytes(raw + b'changed')
            with self.assertRaises(ValueError):
                review(self.cfg)
            file.write_bytes(raw)
        self.assertEqual(review(self.cfg)['capture'], self.body['id'])

    def test_changed_request_result_turn_and_selected_release_are_refused(self):
        for field in ['bodySHA', 'resultSHA']:
            cfg = copy.deepcopy(self.cfg)
            cfg[field] = '0' * 64
            with self.assertRaises(AssertionError):
                review(cfg)
        for field in ['messageID', 'source_sha256', 'sessionID', 'project']:
            cfg = copy.deepcopy(self.cfg)
            cfg['turn'][field] = 'changed'
            with self.assertRaises(AssertionError):
                review(cfg)
        cfg = copy.deepcopy(self.cfg)
        cfg['pins']['capture.py'] = '0' * 64
        with self.assertRaises(AssertionError):
            review(cfg)

    def test_unrelated_policy_change_is_not_adopted(self):
        from admission import serialize
        file = self.notes / 'System/general-admission.json'
        raw = file.read_bytes()
        value = json.loads(raw)
        value['revision'] += 1
        file.write_bytes(serialize(value))
        with self.assertRaises(AssertionError):
            review(self.cfg)
        file.write_bytes(raw)
        self.assertEqual(review(self.cfg)['previousPolicySHA'], self.sha)


if __name__ == '__main__':
    if sys.argv[1:] == ['--prepare']:
        fixture = Recovery('test_committed_effect_and_original_request_are_verified_without_writes')
        fixture.setUp()
        fixture.server.POOL.shutdown(wait=True)
        fixture.server.STORAGE.shutdown(wait=True)
        print(json.dumps(dict(root=str(fixture.root), notes=str(fixture.notes), cfg=fixture.cfg,
                              result=fixture.result, operations=str(fixture.server.JOURNAL.folder))))
        fixture._cleanups.clear()
        sys.exit(0)
    unittest.main()
