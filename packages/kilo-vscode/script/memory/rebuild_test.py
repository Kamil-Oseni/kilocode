"""Actual rebuild body, Policy, SQLite and NumPy; controlled embeddings, no model.

This isolates the cache algorithm, not native admission, transport or tokenization.
"""
import ast
from contextlib import contextmanager
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'service'))
from policy import Policy

SOURCE = HERE / 'service/index.py'
TREE = ast.parse(SOURCE.read_bytes())
NAMES = {'digest', 'decode', 'semantic', 'scan', 'headings', 'split'}
BODY = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in NAMES]
OWNER = next(node for node in TREE.body if isinstance(node, ast.ClassDef) and node.name == 'Index')
METHOD = next(node for node in OWNER.body if isinstance(node, ast.FunctionDef) and node.name == 'rebuild')
# Admission/deadline decorators are outside this disposable cache fixture.
METHOD.decorator_list = []
BODY.append(METHOD)
BODY.extend(node for node in TREE.body if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == 'SIGNATURE' for target in node.targets))
MODEL = {'revision': 'controlled-cache-test'}
remaining = lambda: None
tokens = len
exec(compile(ast.fix_missing_locations(ast.Module(body=BODY, type_ignores=[])), str(SOURCE), 'exec'), globals())


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='raya-cache-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.raw = b'# Historical\nOld preference.\n   ## Current preference\nPrefer warm light.\n```md\n# Example only\n```\n'
        (self.root / 'note.md').write_bytes(self.raw)
        self.policy = Policy({'format': 'raya-general-sources-v1', 'root': str(self.root),
                              'enabled': True, 'revision': 1, 'files': [
                                  {'relative': 'note.md', 'sha256': digest(self.raw),
                                   'classification': 'general', 'review': 'approved'}]})
        self.path = self.root / 'cache.sqlite'
        self.calls = []
        self.broken = False
        self.owner = SimpleNamespace(root=self.root, lease=SimpleNamespace(policy=self.policy, sha='reviewed-fixture'),
                                     connect=self.connect, guard=self.guard)
        with self.owner.connect() as db:
            db.execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute('CREATE TABLE chunks (id TEXT PRIMARY KEY, path TEXT, start INTEGER, end INTEGER, heading TEXT, text TEXT, filehash TEXT, contenthash TEXT, vector BLOB)')
            db.execute('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)',
                       ('legacy', 'note.md', 1, 8, 'Historical', self.raw.decode(), digest(self.raw),
                        digest(self.raw), np.full(1024, 1 / 32, dtype=np.float32).tobytes()))
            db.executemany('INSERT INTO meta VALUES (?,?)', [
                ('signature', SIGNATURE.replace('markdown-v4:', 'markdown-v3:', 1) + ':admission:reviewed-fixture'),
                ('files', json.dumps({'note.md': digest(self.raw)}, sort_keys=True)), ('updated', 'old')])
        self.prior = self.rows()
        self.meta = self.metadata()
        self.original = globals().get('api')
        globals()['api'] = self.embedding
        self.addCleanup(self.restore)

    def restore(self):
        if self.original is None:
            globals().pop('api', None)
            return
        globals()['api'] = self.original

    def guard(self, snapshot):
        self.assertEqual(snapshot, scan(self.root, self.policy))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        try:
            with db:
                yield db
        finally:
            db.close()

    def embedding(self, path, body, gate):
        gate()
        self.assertEqual(path, '/v1/embeddings')
        self.assertEqual(body['input_type'], 'document')
        self.calls.append(body['input'])
        if self.broken:
            raise RuntimeError('controlled embedding failure')
        return {'revision': MODEL['revision'], 'dimensions': 1024,
                'data': [{'embedding': [1 / 32] * 1024} for _ in body['input']]}

    def rows(self):
        with self.owner.connect() as db:
            return list(db.execute('SELECT * FROM chunks ORDER BY id'))

    def metadata(self):
        with self.owner.connect() as db:
            return dict(db.execute('SELECT key,value FROM meta'))

    def test_old_recipe_rebuilds_unchanged_notes_and_then_reuses_current_cache(self):
        result = rebuild(self.owner)
        chunks = split('note.md', scan(self.root, self.policy)['note.md'])
        self.assertGreater(result['new_embeddings'], 0)
        self.assertEqual(result['reused_embeddings'], 0)
        self.assertEqual(result['chunks'], len(chunks))
        rows = self.rows()
        self.assertNotEqual(rows, self.prior)
        self.assertEqual([row[:8] for row in rows], sorted([
            (chunk['id'], chunk['path'], chunk['start'], chunk['end'], chunk['heading'], chunk['text'],
             chunk['filehash'], chunk['contenthash']) for chunk in chunks]))
        self.assertIn('Current preference', [row[4] for row in rows])
        self.assertNotIn('Example only', [row[4] for row in rows])
        for row in rows:
            self.assertEqual(decode(row[8]).shape, (1024,))
        self.assertEqual(self.metadata()['signature'], SIGNATURE + ':admission:reviewed-fixture')
        count = len(self.calls)
        again = rebuild(self.owner)
        self.assertEqual(again['new_embeddings'], 0)
        self.assertEqual(again['reused_embeddings'], len(chunks))
        self.assertEqual(len(self.calls), count)
        self.assertEqual(self.rows(), rows)
        self.assertEqual((self.root / 'note.md').read_bytes(), self.raw)

    def test_embedding_failure_keeps_old_cache_and_original_notes(self):
        self.broken = True
        with self.assertRaisesRegex(RuntimeError, 'controlled embedding failure'):
            rebuild(self.owner)
        self.assertEqual(self.rows(), self.prior)
        self.assertEqual(self.metadata(), self.meta)
        self.assertEqual((self.root / 'note.md').read_bytes(), self.raw)
        self.assertTrue(self.calls)


if __name__ == '__main__':
    unittest.main()
