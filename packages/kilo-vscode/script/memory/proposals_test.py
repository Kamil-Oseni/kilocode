import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).parent / 'service'))
from proposals import Proposals


class Review(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.project = self.root / 'project'
        self.project.mkdir()
        self.notes = self.root / 'notes'
        self.notes.mkdir()
        self.source = self.project / 'source.txt'
        self.source.write_text('observed evidence', encoding='utf-8')
        self.api = Proposals(self.notes)

    def tearDown(self):
        self.tmp.cleanup()

    def request(self, content='Reviewed correction', expected=None):
        return {'changes': [{'path': 'Preferences/review.md', 'expected': expected, 'content': content}],
                'sources': [{'path': str(self.source), 'sha256': hashlib.sha256(self.source.read_bytes()).hexdigest(),
                             'kind': 'document', 'event_time': None}]}

    def call(self, action, **fields):
        return self.api.execute(dict(action=action, project=str(self.project), **fields))

    def propose(self, request=None):
        return self.call('propose', id=str(uuid.uuid4()), request=request or self.request())

    def test_create_correct_delete(self):
        value = self.propose()
        path = self.notes / 'Preferences/review.md'
        self.assertFalse(path.exists())
        self.assertEqual(value['changes'][0]['before'], None)
        self.assertEqual(len(self.call('list')['proposals']), 1)
        self.assertEqual(self.call('read', id=value['id'])['digest'], value['digest'])
        result = self.call('apply', id=value['id'], digest=value['digest'])
        self.assertEqual(result['status'], 'applied')
        self.assertFalse(result['capture_enabled'])
        self.assertEqual(self.api.store.state(value['id'])['status'], 'committed')
        old = path.read_bytes()
        value = self.propose(self.request('Corrected evidence', hashlib.sha256(old).hexdigest()))
        self.assertEqual(value['changes'][0]['before'], old.decode())
        self.call('apply', id=value['id'], digest=value['digest'])
        self.assertTrue(path.read_text().startswith('Corrected evidence'))
        value = self.propose(self.request(None, hashlib.sha256(path.read_bytes()).hexdigest()))
        self.call('apply', id=value['id'], digest=value['digest'])
        self.assertFalse(path.exists())

    def test_source_and_note_stale(self):
        value = self.propose()
        self.source.write_text('changed')
        with self.assertRaises(ValueError):
            self.call('apply', id=value['id'], digest=value['digest'])
        self.assertEqual(self.call('read', id=value['id'])['status'], 'pending')
        value = self.propose()
        path = self.notes / 'Preferences/review.md'
        path.parent.mkdir()
        path.write_text('external update')
        with self.assertRaises(ValueError):
            self.call('apply', id=value['id'], digest=value['digest'])
        self.assertEqual(path.read_text(), 'external update')

    def test_deleted_source_and_missing_proposal_refuse_without_write(self):
        value = self.propose()
        self.source.unlink()
        with self.assertRaisesRegex(ValueError, 'Source disappeared'):
            self.call('apply', id=value['id'], digest=value['digest'])
        self.assertEqual(self.call('read', id=value['id'])['status'], 'pending')
        with self.assertRaisesRegex(ValueError, 'unavailable'):
            self.call('read', id=str(uuid.uuid4()))
        self.assertFalse((self.notes / 'Preferences/review.md').exists())

    def test_edit_cancel_project_and_digest(self):
        value = self.propose()
        edited = self.call('edit', id=value['id'], digest=value['digest'], request=self.request('edited'))
        self.assertNotEqual(value['digest'], edited['digest'])
        with self.assertRaises(ValueError):
            self.call('apply', id=value['id'], digest=value['digest'])
        self.call('cancel', id=edited['id'], digest=edited['digest'])
        with self.assertRaises(ValueError):
            self.call('apply', id=edited['id'], digest=edited['digest'])
        other = self.root / 'other'
        other.mkdir()
        with self.assertRaises(ValueError):
            self.api.execute(dict(action='read', project=str(other), id=value['id']))
        request = self.request()
        request['sources'][0]['path'] = str(self.root / 'outside.txt')
        with self.assertRaises(ValueError):
            self.propose(request)

    def test_applying_is_not_replayed(self):
        value = self.propose()
        self.api.save(dict(value, status='applying'))
        with self.assertRaises(ValueError):
            self.call('apply', id=value['id'], digest=value['digest'])
        self.assertFalse((self.notes / 'Preferences/review.md').exists())
        self.assertTrue(self.api.pending())

    def test_traversal_and_actual_link_refused(self):
        request = self.request()
        request['changes'][0]['path'] = 'Preferences/../Areas/escape.md'
        with self.assertRaises(ValueError):
            self.propose(request)
        link = self.project / 'linked'
        import subprocess
        import os
        child = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                                'New-Item -ItemType Junction -Path $env:RAYA_TEST_LINK -Target $env:RAYA_TEST_TARGET -ErrorAction Stop | Out-Null'],
                               env=dict(os.environ, RAYA_TEST_LINK=str(link), RAYA_TEST_TARGET=str(self.root)), capture_output=True)
        self.assertEqual(child.returncode, 0)
        try:
            request = self.request()
            request['sources'][0]['path'] = str(link / 'project/source.txt')
            with self.assertRaises(ValueError):
                self.propose(request)
        finally:
            link.rmdir()

    def test_daily_and_all_legitimate_folders(self):
        from notes import FOLDERS
        for name in FOLDERS:
            request = self.request()
            request['changes'][0]['path'] = name + '/review.md'
            value = self.propose(request)
            self.call('apply', id=value['id'], digest=value['digest'])
        path = self.notes / 'Daily/review.md'
        request = self.request(None, hashlib.sha256(path.read_bytes()).hexdigest())
        request['changes'][0]['path'] = 'Daily/review.md'
        with self.assertRaises(ValueError):
            self.propose(request)

    def test_complete_before_preview_bound_refuses_before_save(self):
        request = self.request()
        request['changes'] = []
        folder = self.notes / 'Areas'
        folder.mkdir()
        for number in range(16):
            path = folder / (str(number) + '.md')
            path.write_bytes(b'x' * 250000)
            request['changes'].append({'path': 'Areas/' + path.name, 'expected': hashlib.sha256(path.read_bytes()).hexdigest(), 'content': None})
        with self.assertRaisesRegex(ValueError, 'ledger bound'):
            self.propose(request)
        self.assertEqual(list(self.api.root.iterdir()), [])
        self.assertTrue(all(path.stat().st_size == 250000 for path in folder.iterdir()))

    def test_129th_proposal_refuses_and_preserves_readable_ledger(self):
        for _ in range(128):
            self.propose()
        before = {path.name: path.read_bytes() for path in self.api.root.iterdir()}
        with self.assertRaisesRegex(ValueError, 'local archival'):
            self.propose()
        self.assertEqual({path.name: path.read_bytes() for path in self.api.root.iterdir()}, before)
        self.assertEqual(len(self.call('list')['proposals']), 128)

    def test_aggregate_preview_and_edit_refuse_before_write(self):
        for _ in range(11):
            self.propose(self.request('x' * 249000))
        value = self.propose(self.request('x' * 140000))
        before = {path.name: path.read_bytes() for path in self.api.root.iterdir()}
        with self.assertRaisesRegex(ValueError, 'local archival'):
            self.propose(self.request('x' * 249000))
        with self.assertRaisesRegex(ValueError, 'local archival'):
            self.call('edit', id=value['id'], digest=value['digest'], request=self.request('x' * 249000))
        self.assertEqual({path.name: path.read_bytes() for path in self.api.root.iterdir()}, before)
        self.assertEqual(len(self.call('list')['proposals']), 12)


if __name__ == '__main__':
    unittest.main()
