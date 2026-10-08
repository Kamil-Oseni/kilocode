"""Real authenticated index inspection after cold reopening; no inference or mocks."""
import asyncio
import hashlib
import json
import sqlite3
import struct
import sys
import os
import subprocess
import threading
import time
from pathlib import Path
import unittest
from contextlib import closing

import httpx
import capture_http_test as support


class HTTP(unittest.TestCase):
    setUp = support.HTTP.setUp
    cleanup = support.HTTP.cleanup

    def policy(self, enabled=True, files=None):
        raw = self.server.INDEX.store.file
        prior = json.loads(raw.read_bytes()) if raw.exists() else None
        return self.server.INDEX.store.replace(dict(format='raya-general-sources-v1', root=str(self.notes),
            enabled=enabled, revision=prior['revision'] + 1 if prior else 1, files=files or []),
            hashlib.sha256(raw.read_bytes()).hexdigest() if prior else None)

    def health(self):
        async def run():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.server.app), base_url='http://127.0.0.1:8874') as client:
                return await client.get('/health', headers={'Authorization': 'Bearer ' + self.key})
        return asyncio.run(run())

    def test_current_policy_and_complete_empty_index_restore_without_writing(self):
        self.assertEqual(self.health().json()['index'], {'status': 'unchecked'})
        sha = self.policy()
        self.assertEqual(self.health().json()['index'], {'status': 'approved', 'digest': sha})
        self.assertFalse(self.server.INDEX.db.exists())
        self.server.INDEX.sync(expected=sha)
        original = self.server.INDEX
        before = original.db.read_bytes()
        self.server.INDEX = type(original)(self.notes, existing=True, generation=original.store.generation)
        result = self.health()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['index'], {'status': 'synced', 'digest': sha})
        self.assertEqual(original.db.read_bytes(), before)
        print(json.dumps({'index': result.json()['index']}))

    def test_queue_wait_consumes_deadline_and_original_read_remains_owned(self):
        hold = threading.Event()
        original = self.server.STORAGE.submit(hold.wait)
        try:
            started = time.monotonic()
            self.assertEqual(self.health().status_code, 503)
            self.assertLess(time.monotonic() - started, 5)
            self.assertEqual(len(self.server.READS), 1)
            retained = next(iter(self.server.READS))
            self.assertFalse(retained.done())
            self.assertTrue(self.server.READS[retained]['cancel'].is_set())
            self.assertEqual(self.health().status_code, 503)
            self.assertFalse(self.server.INDEX.db.exists())
        finally:
            hold.set()
            original.result(timeout=5)
        with self.assertRaises(Exception):
            retained.result(timeout=5)
        until = time.monotonic() + 1
        while self.server.READS and time.monotonic() < until:
            time.sleep(.001)
        self.assertEqual(self.server.READS, {})
        self.assertEqual(self.health().status_code, 200)
        self.assertFalse(self.server.INDEX.db.exists())

    def test_changed_policy_or_disabled_sources_never_restore_ready(self):
        sha = self.policy()
        self.server.INDEX.sync(expected=sha)
        self.policy()
        self.assertEqual(self.health().json()['index']['status'], 'approved')
        sha = self.policy(False)
        self.assertEqual(self.health().json()['index'], {'status': 'policy_disabled', 'digest': sha})

    def test_extra_chunk_refuses_without_rebuilding(self):
        sha = self.policy()
        self.server.INDEX.sync(expected=sha)
        with closing(sqlite3.connect(self.server.INDEX.db)) as db:
            with db:
                db.execute('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)', ('foreign', 'Other.md', 1, 1, '', 'foreign', '0'*64, '0'*64, b'bad'))
        before = self.server.INDEX.db.read_bytes()
        self.assertEqual(self.health().status_code, 503)
        self.assertEqual(self.server.INDEX.db.read_bytes(), before)

    def test_changed_approved_note_refuses_without_reapproval(self):
        target = self.notes / 'Preferences/Raya.md'
        target.parent.mkdir()
        target.write_text('Original approved note.', encoding='utf-8')
        self.policy(files=[dict(relative='Preferences/Raya.md', sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                                classification='general', review='approved')])
        target.write_text('Changed outside the original approval.', encoding='utf-8')
        self.assertEqual(self.health().status_code, 503)
        self.assertFalse(self.server.INDEX.db.exists())

    def test_complete_real_tokenized_chunks_and_vectors_are_required(self):
        sha = self.policy()
        self.server.INDEX.sync(expected=sha)
        target = self.notes / 'Preferences/Raya.md'
        target.parent.mkdir()
        text = '# First\nA warm light preference.\n\n# Second\nA quiet evening preference.'
        target.write_text(text, encoding='utf-8')
        sha = self.policy(files=[dict(relative='Preferences/Raya.md', sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                                     classification='general', review='approved')])
        module = sys.modules['index']
        with module.operation():
            chunks = module.split('Preferences/Raya.md', {'text': text, 'hash': hashlib.sha256(target.read_bytes()).hexdigest()})
            self.assertEqual(chunks, module.split('Preferences/Raya.md', {'text': text, 'hash': hashlib.sha256(target.read_bytes()).hexdigest()}, module.measure()))
            from transformers import AutoTokenizer
            model = json.loads((module.CATALOG / 'google--embeddinggemma-2.json').read_bytes())
            tokenizer = AutoTokenizer.from_pretrained(model['path'], local_files_only=True)
            count = module.measure(model)
            for sample in ['café 日本語 😀', 'Source: Preferences/Raya.md\nSection: First\nA warm light preference.', 'x ' * 400, '```python\nprint(1)\n```', 'First\r\nSecond']:
                self.assertEqual(count(sample), len(tokenizer.encode(sample, add_special_tokens=False)))
        self.assertEqual(len(chunks), 2)
        vector = struct.pack('<' + 'f' * module.SPACE['dimensions'], 1, *([0] * (module.SPACE['dimensions'] - 1)))
        with closing(sqlite3.connect(self.server.INDEX.db)) as db:
            with db:
                db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('signature', module.SIGNATURE + ':admission:' + sha))
                db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('files', json.dumps({'Preferences/Raya.md': hashlib.sha256(target.read_bytes()).hexdigest()}, sort_keys=True)))
                db.executemany('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)',
                    [tuple(row[key] for key in ('id', 'path', 'start', 'end', 'heading', 'text', 'filehash', 'contenthash')) + (vector,) for row in chunks])
        original = self.server.INDEX
        self.server.INDEX = type(original)(self.notes, existing=True, generation=original.store.generation)
        result = self.health()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['index'], {'status': 'synced', 'digest': sha})
        env = dict(os.environ, RAYA_MEMORY_RETRIEVAL_TOKEN_FILE=str(self.root / 'credential.private'),
                   RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256='0'*64, RAYA_MEMORY_RETRIEVAL_PROTOCOL='raya.retrieval.request.settlement.v2')
        child = subprocess.run([sys.executable, '-B', str(Path(__file__).with_name('index_inspection_child.py')), str(self.notes),
            json.dumps({str(name): value for name, value in original.store.generation.items()})], env=env,
            capture_output=True, text=True, timeout=15, check=True)
        cold = json.loads(child.stdout)
        self.assertEqual(cold['index'], result.json()['index'])
        self.assertFalse(cold['inferenceImports'])
        self.assertLess(cold['milliseconds'], 5000)
        with closing(sqlite3.connect(original.db)) as db:
            with db:
                db.execute('DELETE FROM chunks WHERE id=?', (chunks[0]['id'],))
        before = original.db.read_bytes()
        self.assertEqual(self.health().status_code, 503)
        self.assertEqual(original.db.read_bytes(), before)
        with closing(sqlite3.connect(original.db)) as db:
            with db:
                row = chunks[0]
                damaged = struct.pack('<' + 'f' * module.SPACE['dimensions'], float('nan'), *([0] * (module.SPACE['dimensions'] - 1)))
                db.execute('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)',
                    tuple(row[key] for key in ('id', 'path', 'start', 'end', 'heading', 'text', 'filehash', 'contenthash')) + (damaged,))
        before = original.db.read_bytes()
        self.assertEqual(self.health().status_code, 503)
        self.assertEqual(original.db.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
