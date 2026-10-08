"""Actual authenticated ASGI capture and original operation journals; no model."""
import asyncio
import copy
import hashlib
import json
import os
import unittest
import uuid
import httpx
import proposals_http_test as support


class HTTP(unittest.TestCase):
    cleanup = support.HTTP.cleanup

    def setUp(self):
        prior = os.environ.get('RAYA_MEMORY_RETRIEVAL_PROTOCOL')
        os.environ['RAYA_MEMORY_RETRIEVAL_PROTOCOL'] = 'raya.retrieval.request.settlement.v2'
        try:
            support.HTTP.setUp(self)
        finally:
            if prior is None:
                os.environ.pop('RAYA_MEMORY_RETRIEVAL_PROTOCOL', None)
            else:
                os.environ['RAYA_MEMORY_RETRIEVAL_PROTOCOL'] = prior
        source = {'user': {'id': 'user-original', 'text': 'I prefer warm lights.'},
                  'assistant': {'id': 'reply-original', 'text': 'I will remember that.'}, 'tools': []}
        self.body = dict(format='raya.memory.capture.v3', project=str(self.project), session='session-original',
                         message='reply-original', observed_utc='2026-10-09T01:30:00.000Z', day='2026-10-08',
                         zone='America/Toronto', source=source, entries=[dict(category='Preferences', key='lights',
                         text='Prefers warm lights.', origin='user_statement', evidence=[dict(id='user-original', start=0, end=21)])])
        raw = json.dumps([self.body['project'], self.body['session'], self.body['message']], separators=(',', ':')).encode()
        self.body['id'] = str(uuid.UUID(hex=hashlib.sha256(raw).hexdigest()[:32], version=5))
        raw = json.dumps([self.body['observed_utc'], source['user']['id'], source['user']['text'],
                         source['assistant']['id'], source['assistant']['text'], []], separators=(',', ':')).encode()
        self.body['source_sha256'] = hashlib.sha256(raw).hexdigest()

    def test_capture_auth_original_epoch_publication_and_no_replay(self):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.server.app), base_url='http://127.0.0.1:8874') as client:
                target = self.notes / 'Preferences/Raya.md'
                self.assertEqual((await client.post('/v1/memory/capture', json=self.body)).status_code, 401)
                headers = {'Authorization': 'Bearer ' + self.key, 'X-Raya-Memory-Request-ID': uuid.uuid4().hex}
                self.assertEqual((await client.post('/v1/memory/capture', json=self.body, headers=headers)).status_code, 409)
                headers['X-Raya-Memory-Owner-Epoch'] = self.server.EPOCH
                damaged = copy.deepcopy(self.body)
                damaged['source_sha256'] = '0' * 64
                self.assertEqual((await client.post('/v1/memory/capture', json=damaged, headers=headers)).status_code, 422)
                self.assertFalse(target.exists())
                response = await client.post('/v1/memory/capture', json=self.body, headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
                result = response.json()
                self.assertEqual(result['status'], 'committed')
                self.assertEqual(result['operation']['kind'], 'capture')
                self.assertEqual(result['operation']['operation_outcome'], 'completed')
                self.assertEqual(result['operation']['downstream'], [])
                print(json.dumps({'response': response.text, 'selected': {'request': headers['X-Raya-Memory-Request-ID'],
                    'epoch': self.server.EPOCH, 'release': self.server.RELEASE,
                    'digest': result['operation']['request_sha256'], 'kind': 'capture', 'protocol': self.server.JOURNAL.format}}))
                saved = target.read_bytes()
                self.assertEqual((await client.post('/v1/memory/capture', json=self.body, headers=headers)).status_code, 409)
                self.assertEqual(target.read_bytes(), saved)
                self.assertEqual(self.server.ACTIVE, 0)
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
