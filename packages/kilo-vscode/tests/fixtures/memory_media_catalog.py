"""Real temporary files and SQLite catalog tests; no inference quality claim."""
import importlib.util
from contextlib import closing
import ctypes
from ctypes import wintypes
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('media_library', Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
space = dict(model=module.MODEL, revision=module.REVISION, dimensions=module.DIMENSIONS)


class Catalog(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raya-media-catalog-')
        self.root = Path(self.temp.name)
        self.folder = self.root/'library'
        self.folder.mkdir()
        self.library = module.Library(self.folder)
        self.source = self.root/'fixture.png'
        self.source.write_bytes(b'\x89PNG\r\n\x1a\nfixture-one')
        self.item = self.library.add(self.source, 'Test attachment')
        self.vector = [1.0] + [0.0] * 767

    def tearDown(self):
        self.temp.cleanup()

    def row(self, item=None):
        value = item or self.item
        return dict(id=value['id'], sha256=value['sha256'], vector=self.vector)

    def test_import_search_and_forget(self):
        self.library.publish([self.row()], space)
        result = self.library.search(self.vector, space)
        self.assertEqual(result[0]['id'], self.item['id'])
        self.assertEqual(result[0]['similarity'], 1)
        self.assertEqual(Path(result[0]['path']).read_bytes(), self.source.read_bytes())
        self.assertTrue(self.library.forget(self.item['id'])['forgotten'])
        self.assertEqual(self.library.search(self.vector, space), [])
        self.assertFalse(Path(result[0]['path']).exists())
        self.assertTrue(self.library.forget(self.item['id'])['forgotten'])
        with closing(sqlite3.connect(self.library.path)) as db, db:
            self.assertIsNotNone(db.execute('SELECT id FROM tombstones').fetchone())
        self.library.add(self.source, 'Explicit re-import')
        with closing(sqlite3.connect(self.library.path)) as db, db:
            self.assertIsNone(db.execute('SELECT id FROM tombstones').fetchone())

    def test_changed_source_is_a_distinct_snapshot(self):
        self.source.write_bytes(b'\x89PNG\r\n\x1a\nfixture-two')
        second = self.library.add(self.source, 'Second revision')
        self.assertNotEqual(second['id'], self.item['id'])
        self.assertEqual(len(self.library.inventory()), 2)
        self.assertEqual((self.folder/self.item['relative']).read_bytes(), b'\x89PNG\r\n\x1a\nfixture-one')

    def test_changed_snapshot_refuses_recall(self):
        self.library.publish([self.row()], space)
        (self.folder/self.item['relative']).write_bytes(b'\x89PNG\r\n\x1a\nchanged')
        with self.assertRaisesRegex(ValueError, 'snapshot changed'):
            self.library.search(self.vector, space)

    def test_other_models_cannot_publish_or_search(self):
        other = dict(model='qwen3-embedding-0.6b', revision='other', dimensions=1024)
        with self.assertRaisesRegex(ValueError, 'different model space'):
            self.library.publish([self.row()], other)
        with self.assertRaisesRegex(ValueError, 'different embedding space'):
            self.library.search(self.vector, other)
        self.assertEqual(self.library.search(self.vector, space), [])

    def test_bad_batch_does_not_partially_publish(self):
        self.source.write_bytes(b'\x89PNG\r\n\x1a\nfixture-two')
        second = self.library.add(self.source, 'Second')
        invalid = dict(self.row(second), vector=[0.0] * 768)
        with self.assertRaisesRegex(ValueError, 'normalized'):
            self.library.publish([self.row(), invalid], space)
        self.assertEqual(self.library.search(self.vector, space), [])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.library.publish([self.row(), self.row()], space)

    def test_malformed_vectors_and_limits(self):
        for vector in ([1.0] * 1024, [float('nan')] + [0.0] * 767, [True] + [0.0] * 767, [0.0] * 768):
            with self.assertRaises(ValueError):
                self.library.publish([dict(self.row(), vector=vector)], space)
        with self.assertRaises(ValueError):
            self.library.search(self.vector, space, top=11)
        invalid = self.root/'unapproved.txt'
        invalid.write_text('Ordinary text is not a supported media attachment.')
        with self.assertRaisesRegex(ValueError, 'signature'):
            self.library.add(invalid, 'Unsupported')

    def test_mutated_database_address_cannot_escape(self):
        with closing(sqlite3.connect(self.library.path)) as db, db:
            db.execute('UPDATE items SET relative=? WHERE id=?', ('../fixture.png', self.item['id']))
        with self.assertRaisesRegex(ValueError, 'address differs'):
            self.library.item(self.item['id'])
        self.assertEqual(self.source.read_bytes(), b'\x89PNG\r\n\x1a\nfixture-one')

    def test_changed_database_space_is_refused(self):
        with closing(sqlite3.connect(self.library.path)) as db, db:
            db.execute('UPDATE meta SET value=? WHERE key=?', ('1024', 'dimensions'))
        with self.assertRaisesRegex(ValueError, 'space changed'):
            self.library.inventory()

    def test_full_catalog_stays_searchable_and_rejects_new_assets(self):
        self.library.publish([self.row()], space)
        for index in range(127):
            self.source.write_bytes(b'\x89PNG\r\n\x1a\n' + str(index).encode())
            self.library.add(self.source, 'Attachment ' + str(index))
        before = sorted(path.name for path in self.library.assets.iterdir())
        self.source.write_bytes(b'\x89PNG\r\n\x1a\noverflow')
        with self.assertRaisesRegex(ValueError, '128 attachments'):
            self.library.add(self.source, 'Overflow')
        self.assertEqual(sorted(path.name for path in self.library.assets.iterdir()), before)
        self.assertEqual(len(self.library.inventory()), 128)
        self.assertEqual(self.library.search(self.vector, space)[0]['id'], self.item['id'])
        self.source.write_bytes(b'\x89PNG\r\n\x1a\nfixture-one')
        self.assertEqual(self.library.add(self.source, 'Renamed')['title'], 'Renamed')
        self.assertEqual(len(self.library.inventory()), 128)

    def test_locked_file_forgetting_hides_recall_and_retries_cleanup(self):
        self.library.publish([self.row()], space)
        target = self.folder/self.item['relative']
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.CreateFileW(str(target), 0x80000000, 1, None, 3, 0x80, None)
        self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
        try:
            with self.assertRaises(PermissionError):
                self.library.forget(self.item['id'])
            self.assertTrue(target.exists())
            self.assertEqual(self.library.search(self.vector, space), [])
            self.assertEqual(self.library.inventory(), [])
            with self.assertRaisesRegex(ValueError, 'forgotten'):
                self.library.item(self.item['id'])
            with self.assertRaisesRegex(ValueError, 'cleanup is pending'):
                self.library.add(self.source, 'Cannot resurrect during cleanup')
        finally:
            self.assertTrue(kernel.CloseHandle(handle))
        self.library = module.Library(self.folder)
        self.assertEqual(self.library.search(self.vector, space), [])
        self.assertTrue(self.library.forget(self.item['id'])['forgotten'])
        self.assertFalse(target.exists())
        self.assertEqual(self.library.search(self.vector, space), [])
        self.assertTrue(self.library.forget(self.item['id'])['forgotten'])


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], verbosity=2)
