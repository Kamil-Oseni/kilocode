"""Actual ASGI routes, protected private namespace and original storage Futures; no model."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import unittest
import uuid
import httpx
import namespace_publication_test as support
MODULE = support.MODULE
HERE = support.HERE


class HTTP(unittest.TestCase):
    cleanup = support.Tests.cleanup

    def setUp(self):
        support.Tests.setUp(self)
        self.folder.rmdir()
        self.notes = self.root / 'notes'
        self.notes.mkdir()
        (self.notes / 'System').mkdir()
        self.project = self.root / 'project'
        self.project.mkdir()
        token = self.root / 'credential.private'
        token.write_text(uuid.uuid4().hex)
        self.key = token.read_text()
        env = dict(RAYA_MEMORY_PORT='8874', RAYA_MEMORY_ROOT=str(self.notes), RAYA_MEMORY_TOKEN_FILE=str(token),
                   RAYA_MEMORY_RETRIEVAL_TOKEN_FILE=str(token), RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256='0'*64,
                   RAYA_MEMORY_OPERATION_ROOT=str(self.root), RAYA_MEMORY_OPERATION_SID=self.sid,
                   RAYA_MEMORY_OPERATION_GENERATIONS=json.dumps({name: MODULE.generation(self.root if name == 'root' else self.root/name) for name in ('root', 'Runs', 'Requests')}),
                   RAYA_MEMORY_NOTE_GENERATIONS=json.dumps({name: MODULE.generation(self.notes if name == 'root' else self.notes/'System') for name in ('root', 'system')}))
        previous = dict(os.environ)
        os.environ.update(env)
        sys.path.insert(0, str(HERE / 'service'))
        try:
            spec = importlib.util.spec_from_file_location('proposal_server', HERE / 'service/server.py')
            self.server = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.server)
        finally:
            os.environ.clear()
            os.environ.update(previous)
        self.addCleanup(self.server.POOL.shutdown, wait=True)
        self.addCleanup(self.server.STORAGE.shutdown, wait=True)

    def test_actual_bearer_epoch_bounds_and_unlimited_terminal_reads(self):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.server.app), base_url='http://127.0.0.1:8874') as client:
                body = dict(action='list', project=str(self.project))
                self.assertEqual((await client.post('/v1/memory/proposals', json=body)).status_code, 401)
                headers = {'Authorization': 'Bearer ' + self.key}
                self.assertEqual((await client.post('/v1/memory/proposals', json=body, headers=headers)).status_code, 409)
                headers['X-Raya-Memory-Owner-Epoch'] = self.server.EPOCH
                self.assertEqual((await client.post('/v1/memory/proposals', content=b' ' * 2100001, headers=dict(headers, **{'Content-Type': 'application/json'}))).status_code, 422)
                for _ in range(260):
                    response = await client.post('/v1/memory/proposals', json=body, headers=headers)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), {'proposals': [], 'capture_enabled': False})
                self.assertEqual(self.server.ACTIVE, 0)
                self.assertEqual(len(self.server.REVIEWS), 0)
        asyncio.run(run())

    def test_lost_transport_does_not_cancel_or_retry_original(self):
        async def run():
            hold = threading.Event()
            original = self.server.STORAGE.submit(hold.wait)
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.server.app), base_url='http://127.0.0.1:8874') as client:
                    headers = {'Authorization': 'Bearer ' + self.key, 'X-Raya-Memory-Owner-Epoch': self.server.EPOCH}
                    body = dict(action='list', project=str(self.project))
                    task = asyncio.create_task(client.post('/v1/memory/proposals', json=body, headers=headers))
                    while not self.server.REVIEWS:
                        await asyncio.sleep(.001)
                    retained = next(iter(self.server.REVIEWS))
                    task.cancel()
                    response = await task
                    self.assertEqual(response.status_code, 503)
                    self.assertFalse(retained.cancelled())
                    self.assertFalse(retained.done())
                    self.assertEqual((await client.post('/v1/memory/proposals', json=body, headers=headers)).status_code, 409)
                    hold.set()
                    await asyncio.wrap_future(original)
                    self.assertEqual(await asyncio.wrap_future(retained), {'proposals': [], 'capture_enabled': False})
                    while self.server.REVIEWS:
                        await asyncio.sleep(.001)
                    self.assertEqual(self.server.ACTIVE, 0)
            finally:
                hold.set()
                original.result()
        asyncio.run(run())

    def test_actual_storage_timeout_retains_original(self):
        async def run():
            hold = threading.Event()
            original = self.server.STORAGE.submit(hold.wait)
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.server.app), base_url='http://127.0.0.1:8874') as client:
                    headers = {'Authorization': 'Bearer ' + self.key, 'X-Raya-Memory-Owner-Epoch': self.server.EPOCH}
                    body = dict(action='list', project=str(self.project))
                    response = await client.post('/v1/memory/proposals', json=body, headers=headers)
                    self.assertEqual(response.status_code, 503)
                    retained = next(iter(self.server.REVIEWS))
                    self.assertFalse(retained.done())
                    self.assertFalse(retained.cancelled())
                    self.assertEqual((await client.post('/v1/memory/proposals', json=body, headers=headers)).status_code, 409)
                    hold.set()
                    await asyncio.wrap_future(original)
                    await asyncio.wrap_future(retained)
                    while self.server.REVIEWS:
                        await asyncio.sleep(.001)
                    self.assertEqual(self.server.ACTIVE, 0)
            finally:
                hold.set()
                original.result()
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
