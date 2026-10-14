"""Actual read-only SQLite inspection with real approved notes; no inference."""
import hashlib
import json
import sqlite3
import struct
import sys
import threading
import time
from contextlib import closing
from pathlib import Path
import unittest

import index_http_test as support


class Tests(unittest.TestCase):
    setUp = support.HTTP.setUp
    cleanup = support.HTTP.cleanup
    policy = support.HTTP.policy

    def populate(self):
        # Build the empty production schema, then supply exact production chunks
        # and inert normalized vectors without starting an embedding worker.
        self.server.INDEX.sync(expected=self.policy())
        target = self.notes / 'Projects/Inspection.md'
        target.parent.mkdir()
        text = '\n\n'.join(f'# Section {number}\nApproved setup observation {number} remains qualified.' for number in range(160))
        target.write_text(text, encoding='utf-8')
        sha = hashlib.sha256(target.read_bytes()).hexdigest()
        policy = self.policy(files=[dict(relative='Projects/Inspection.md', sha256=sha,
                                         classification='general', review='approved')])
        module = sys.modules['index']
        with module.operation():
            chunks = module.split('Projects/Inspection.md', {'text': text, 'hash': sha}, module.measure())
        self.assertEqual(len(chunks), 160)
        vector = struct.pack('<' + 'f' * module.SPACE['dimensions'], 1, *([0] * (module.SPACE['dimensions'] - 1)))
        with closing(sqlite3.connect(self.server.INDEX.db)) as db:
            with db:
                db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('signature', module.SIGNATURE + ':admission:' + policy))
                db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('files', json.dumps({'Projects/Inspection.md': sha}, sort_keys=True)))
                db.executemany('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)',
                    [tuple(row[key] for key in ('id', 'path', 'start', 'end', 'heading', 'text', 'filehash', 'contenthash')) + (vector,) for row in chunks])
        original = self.server.INDEX
        self.server.INDEX = type(original)(self.notes, existing=True, generation=original.store.generation)
        return module, policy

    def test_complete_inspection_continues_across_multiple_sqlite_progress_callbacks(self):
        module, policy = self.populate()
        before = self.server.INDEX.db.read_bytes()
        calls = []
        with closing(sqlite3.connect(self.server.INDEX.db.as_uri() + '?mode=ro', uri=True)) as db:
            db.set_progress_handler(lambda: calls.append(True) or 0, 1000)
            self.assertEqual(len(list(db.execute('SELECT id,path,start,end,heading,text,filehash,contenthash,vector FROM chunks LIMIT 10001'))), 160)
        self.assertGreater(len(calls), 0, 'Fixture must cross the original 1000-opcode boundary')
        value = module.execute(self.server.INDEX.inspect, time.monotonic() + 4, threading.Event())
        self.assertEqual(value, {'status': 'synced', 'digest': policy})
        self.assertEqual(self.server.INDEX.db.read_bytes(), before)

    def test_expired_inspection_preserves_original_database_and_policy(self):
        module, _ = self.populate()
        before = self.server.INDEX.db.read_bytes()
        policy = self.server.INDEX.store.file.read_bytes()
        with self.assertRaises(TimeoutError):
            module.execute(self.server.INDEX.inspect, time.monotonic() - 1, threading.Event())
        self.assertEqual(self.server.INDEX.db.read_bytes(), before)
        self.assertEqual(self.server.INDEX.store.file.read_bytes(), policy)

    def test_cancelled_inspection_preserves_original_database_and_policy(self):
        module, _ = self.populate()
        before = self.server.INDEX.db.read_bytes()
        policy = self.server.INDEX.store.file.read_bytes()
        cancel = threading.Event()
        cancel.set()
        with self.assertRaises(module.Cancelled):
            module.execute(self.server.INDEX.inspect, time.monotonic() + 4, cancel)
        self.assertEqual(self.server.INDEX.db.read_bytes(), before)
        self.assertEqual(self.server.INDEX.store.file.read_bytes(), policy)


if __name__ == '__main__':
    unittest.main()
