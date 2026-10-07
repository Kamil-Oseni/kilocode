"""Admitted actual ASGI/framework, bounded scheduler and ACL storage; no inference."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import unittest
import uuid

SOURCE = Path(__file__).parent
sys.path.insert(0, str(SOURCE/'retrieval'))
sys.path.insert(0, str(SOURCE/'retrieval_reuse'))
from owner import selected
from pool import Pool
from server import CATALOGS, Runtime, create
from validation import fingerprint

spec = importlib.util.spec_from_file_location('reuse_api_namespace_fixture', SOURCE/'namespace_publication_test.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


@unittest.skipUnless(os.environ.get('RAYA_REUSE_API_TEST_ADMITTED') == 'GemmaText-20261006-root',
                     'Actual dependency candidate requires explicit root admission')
class Tests(unittest.TestCase):
    cleanup = fixture.Tests.cleanup

    @classmethod
    def setUpClass(cls):
        root = Path('D:/Raya/Services/Retrieval/Candidates/GemmaText-20261006-root')
        path = root/'dependency-images.json'
        selected(path, 'd2d6de6f5af6b69dd27b48607cba41614491612cb373c9eaab8780b617eae705')
        inventory = json.loads(path.read_bytes())
        deps = root/'venv'/'Lib'/'site-packages'
        for parent in (deps, *deps.parents):
            row = parent.lstat()
            if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
                raise ValueError('dependency_parent')

        def verify(row):
            image = deps/row['relative']
            if not image.resolve().is_relative_to(deps.resolve()):
                raise ValueError('dependency_scope')
            before = image.lstat()
            if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                    getattr(before, 'st_file_attributes', 0) & 0x400 or before.st_size != row['bytes']):
                raise ValueError('dependency_image')
            keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
            stamp = tuple(getattr(before, key) for key in keys)
            with image.open('rb') as file:
                opened = os.fstat(file.fileno())
                digest = hashlib.file_digest(file, 'sha256').hexdigest()
                final = os.fstat(file.fileno())
            after = image.lstat()
            if (digest != row['sha256'] or any(tuple(getattr(value, key) for key in keys) != stamp
                                             for value in (opened, final, after)) or
                    before.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns):
                raise ValueError('dependency_changed')

        # Streaming dependency verification allows large DLLs; do not relax the
        # finite native owner's 16 MiB executable/source-image bound.
        with ThreadPoolExecutor(max_workers=8) as executor:
            list(executor.map(verify, inventory['images']))
        sys.path.append(str(deps))

    def setUp(self):
        fixture.Tests.setUp(self)
        images = {path.relative_to(SOURCE).as_posix(): (path, hashlib.sha256(path.read_bytes()).hexdigest())
                  for folder in ('retrieval', 'retrieval_reuse') for path in (SOURCE/folder).glob('*.py')}
        catalogs = {name: (Path('D:/Raya/Models/Catalog')/name, digest) for name, digest in CATALOGS.items()}
        release = fingerprint({'source_sha256': {key: value[1] for key, value in images.items()},
                               'catalog_sha256': {key: value[1] for key, value in catalogs.items()}}, 65536)
        pool = Pool(uuid.uuid4().hex, release, {'qwen3-embedding-0.6b': 'b' * 40}, self.namespace, reserve=1 << 50)
        self.runtime = Runtime(pool, self.namespace, images, catalogs, 'synthetic-test-token-'+'x' * 32)
        self.app = create(self.runtime)
        self.addCleanup(self.join)

    def join(self):
        result = self.runtime.close()
        self.assertTrue(result['closed'])
        self.assertTrue(result['original_coordinator_joined'])
        self.assertTrue(result['request_publications_confirmed'])
        self.assertIsNone(self.runtime.pool.owner)

    async def request(self, method, path, raw=b'', headers=None, gate=None):
        base = {'host': '127.0.0.1:8873', 'authorization': 'Bearer '+self.runtime.token,
                'x-raya-owner-epoch': self.runtime.pool.epoch, 'content-type': 'application/json',
                'x-raya-request-id': uuid.uuid4().hex}
        base.update(headers or {})
        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': method,
                 'scheme': 'http', 'path': '/'+path, 'raw_path': ('/'+path).encode(), 'query_string': b'',
                 'root_path': '', 'headers': [(key.encode(), value.encode()) for key, value in base.items()],
                 'client': ('127.0.0.1', 1), 'server': ('127.0.0.1', 8873)}
        messages = []
        delivered = False

        async def receive():
            nonlocal delivered
            if not delivered:
                if gate is not None:
                    await gate.wait()
                delivered = True
                return {'type': 'http.request', 'body': raw, 'more_body': False}
            await asyncio.Event().wait()

        async def send(message):
            messages.append(message)

        await asyncio.wait_for(self.app(scope, receive, send), 5)
        status = next(row['status'] for row in messages if row['type'] == 'http.response.start')
        body = b''.join(row.get('body', b'') for row in messages if row['type'] == 'http.response.body')
        return status, json.loads(body)

    def body(self):
        return b'{"model":"qwen3-embedding-0.6b","input":["Synthetic API input"]}'

    def test_origin_authentication_and_epoch_refusal(self):
        async def run():
            for headers, status in [({'origin': 'https://example.com'}, 403),
                                    ({'authorization': 'Bearer wrong'}, 401),
                                    ({'x-raya-owner-epoch': 'f' * 32}, 409)]:
                actual, _ = await self.request('POST', 'v2/embeddings', self.body(), headers)
                self.assertEqual(actual, status)
            self.assertEqual(self.runtime.records, {})
        asyncio.run(run())

    def test_actual_ram_refusal_publishes_settlement_and_reserves_identity(self):
        async def run():
            async with self.app.router.lifespan_context(self.app):
                key = uuid.uuid4().hex
                headers = {'x-raya-request-id': key}
                status, response = await self.request('POST', 'v2/embeddings', self.body(), headers)
                self.assertEqual(status, 503)
                self.assertEqual(response['error']['code'], 'memory_pressure')
                proof = response['settlement']
                self.assertFalse(proof['worker_created'])
                self.assertFalse(proof['joins_observed'])
                self.assertEqual(proof['phase'], 'settled')
                self.assertIsNone(self.runtime.pool.owner)
                status, observed = await self.request('GET', 'v2/requests/'+key)
                self.assertEqual(status, 200)
                self.assertEqual(observed, proof)
                status, _ = await self.request('POST', 'v2/embeddings', self.body(), headers)
                self.assertEqual(status, 409)
                status, value = await self.request('DELETE', 'v2/requests/'+key)
                self.assertEqual(status, 200)
                self.assertFalse(value['settlement_acknowledged'])
                folder = self.namespace.root/'Requests'/self.runtime.pool.epoch
                self.assertEqual(len(list(folder.glob('*.json'))), 2)
        asyncio.run(run())

    def test_invalid_input_does_not_reserve_a_request(self):
        async def run():
            async with self.app.router.lifespan_context(self.app):
                for raw in (b'{"model":"x","model":"y"}', b'{"model":"qwen3-embedding-0.6b","input":[]}', b'NaN'):
                    status, _ = await self.request('POST', 'v2/embeddings', raw)
                    self.assertEqual(status, 422)
            self.assertEqual(self.runtime.records, {})
        asyncio.run(run())

    def test_ready_requires_original_coordinator_and_shutdown_preserves_journal(self):
        async def run():
            status, value = await self.request('GET', 'health')
            self.assertEqual(status, 200)
            self.assertFalse(value['ready'])
            async with self.app.router.lifespan_context(self.app):
                status, value = await self.request('GET', 'health')
                self.assertTrue(value['ready'])
                await self.request('POST', 'v2/embeddings', self.body())
            status, value = await self.request('GET', 'health')
            self.assertFalse(value['ready'])
            pool = Pool(self.runtime.pool.epoch, self.runtime.pool.release,
                        dict(self.runtime.pool.revisions), self.namespace, reserve=1 << 50)
            with self.assertRaisesRegex(ValueError, 'reuse_runtime_prior_receipts'):
                Runtime(pool, self.namespace, self.runtime.images, self.runtime.catalogs, self.runtime.token)
            self.assertTrue(pool.close()['closed'])
        asyncio.run(run())

    def test_http_capacity_includes_body_reading(self):
        async def run():
            async with self.app.router.lifespan_context(self.app):
                gate = asyncio.Event()
                tasks = [asyncio.create_task(self.request('POST', 'v2/embeddings', self.body(), gate=gate)) for _ in range(4)]
                try:
                    await asyncio.sleep(0.05)
                    status, _ = await self.request('POST', 'v2/embeddings', self.body())
                    self.assertEqual(status, 429)
                finally:
                    gate.set()
                    results = await asyncio.gather(*tasks)
                self.assertEqual([status for status, _ in results], [503] * 4)
                self.assertEqual(len(self.runtime.records), 4)
        asyncio.run(run())


if __name__ == '__main__':
    unittest.main()
