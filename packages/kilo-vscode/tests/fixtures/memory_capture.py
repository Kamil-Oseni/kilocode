"""Real Windows Markdown Store publication in disposable directories; no models."""
import copy
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'script' / 'memory' / 'service'))
from capture import publish
from notes import RecoveryNeeded, Store


class Tests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='raya-capture-')).resolve()
        self.body = {'format': 'raya.memory.capture.v1', 'id': str(uuid.uuid4()), 'project': str(self.root),
                     'session': 'session-original', 'message': 'reply-original',
                     'observed_utc': '2026-10-08T19:00:00+00:00', 'source': 'User: We are out of eggs.',
                     'entries': [{'category': 'Areas', 'key': 'groceries', 'text': 'Add eggs to the shopping list.'}]}

    def tearDown(self):
        # Only the exact disposable directory created in setUp is removed.
        if self.root.parent != Path(tempfile.gettempdir()).resolve() or not self.root.name.startswith('raya-capture-'):
            raise ValueError('Capture fixture cleanup escaped its disposable root.')
        shutil.rmtree(self.root)

    def test_publication_preserves_user_text_and_provenance(self):
        target = self.root / 'Areas' / 'Raya.md'
        target.parent.mkdir()
        target.write_text('# My notes\nKeep this exactly.\n', encoding='utf-8')
        result = publish(self.root, self.body)
        self.assertEqual(result['status'], 'committed')
        self.assertFalse(result['duplicate'])
        self.assertTrue(target.read_text(encoding='utf-8').startswith('# My notes\nKeep this exactly.\n'))
        self.assertIn('groceries', target.read_text(encoding='utf-8'))
        state = Store(self.root).state(self.body['id'])
        self.assertEqual(state['sources'][0]['kind'], 'assistant_interpretation')
        snapshot = self.root / 'System' / 'Changes' / self.body['id'] / 'source-0.txt'
        self.assertIn('reply-original', snapshot.read_text(encoding='utf-8'))
        self.assertIn(self.body['source'], snapshot.read_text(encoding='utf-8'))

    def test_exact_duplicate_never_appends_and_changed_input_refuses(self):
        publish(self.root, self.body)
        target = self.root / 'Areas' / 'Raya.md'
        original = target.read_bytes()
        self.assertTrue(publish(self.root, self.body)['duplicate'])
        self.assertEqual(target.read_bytes(), original)
        changed = copy.deepcopy(self.body)
        changed['entries'][0]['text'] = 'Different interpretation.'
        with self.assertRaisesRegex(ValueError, 'another original'):
            publish(self.root, changed)
        self.assertEqual(target.read_bytes(), original)

    def test_excluded_and_linked_targets_refuse(self):
        (self.root / '.rayaignore').write_text('Areas/\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'excluded'):
            publish(self.root, self.body)
        self.assertFalse((self.root / 'System' / 'Capture' / self.body['id']).exists())
        (self.root / '.rayaignore').unlink()
        external = self.root / 'external'
        external.mkdir()
        (external / 'Raya.md').write_text('Untouched', encoding='utf-8')
        import subprocess
        subprocess.run(['cmd.exe', '/d', '/c', 'mklink', '/J', str(self.root / 'Areas'), str(external)],
                       capture_output=True, check=True)
        try:
            with self.assertRaisesRegex(ValueError, 'Linked'):
                publish(self.root, self.body)
            self.assertEqual((external / 'Raya.md').read_text(), 'Untouched')
        finally:
            (self.root / 'Areas').rmdir()

    def test_interrupted_journal_retained_and_retry_refused(self):
        def observe(stage):
            if stage == 'prepared':
                raise RuntimeError('Interrupted publication')
        with self.assertRaisesRegex(RuntimeError, 'Interrupted'):
            publish(self.root, self.body, observe=observe)
        state = Store(self.root).state(self.body['id'])
        self.assertEqual(state['status'], 'prepared')
        self.assertFalse((self.root / 'Areas' / 'Raya.md').exists())
        with self.assertRaises(RecoveryNeeded):
            publish(self.root, self.body)
        self.assertEqual(Store(self.root).state(self.body['id'])['status'], 'prepared')

    def test_external_edit_before_apply_and_after_commit_refuses(self):
        target = self.root / 'Areas' / 'Raya.md'
        target.parent.mkdir()
        target.write_text('User original', encoding='utf-8')
        def observe(stage):
            if stage == 'captured':
                target.write_text('New user edit', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'revision changed'):
            publish(self.root, self.body, observe=observe)
        self.assertEqual(target.read_text(), 'New user edit')
        self.body['id'] = str(uuid.uuid4())
        publish(self.root, self.body)
        target.write_text('Later user edit', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'newer note edit'):
            publish(self.root, self.body)
        self.assertEqual(target.read_text(), 'Later user edit')

    def test_cancel_before_write_and_after_preparation(self):
        with self.assertRaisesRegex(ValueError, 'cancelled'):
            publish(self.root, self.body, cancel=lambda: True)
        self.assertFalse((self.root / 'System' / 'Capture').exists())
        state = {'cancel': False}
        def observe(stage):
            state['cancel'] = stage == 'captured'
        with self.assertRaises(RecoveryNeeded):
            publish(self.root, self.body, observe=observe, cancel=lambda: state['cancel'])
        self.assertTrue((self.root / 'System' / 'Capture' / self.body['id'] / 'input.json').exists())
        self.assertFalse((self.root / 'Areas' / 'Raya.md').exists())
        with self.assertRaises(RecoveryNeeded):
            publish(self.root, self.body)

    def test_invalid_payload_never_creates_store_files(self):
        invalid = []
        for field, value in [('extra', True), ('id', 'not-a-uuid'), ('project', 'relative'),
                             ('observed_utc', '2026-10-08T19:00:00'), ('source', 'x' * 65537)]:
            body = copy.deepcopy(self.body)
            body[field] = value
            invalid.append(body)
        for entry in [{'category': 'System', 'key': 'foo', 'text': 'bar'},
                      {'category': 'Areas', 'key': 'bank-token', 'text': 'bar'},
                      {'category': 'Areas', 'key': '../foo', 'text': 'bar'}]:
            body = copy.deepcopy(self.body)
            body['entries'] = [entry]
            invalid.append(body)
        body = copy.deepcopy(self.body)
        body['entries'] *= 2
        invalid.append(body)
        for body in invalid:
            with self.subTest(body=body['id']):
                with self.assertRaises(ValueError):
                    publish(self.root, body)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_cancel_at_final_journal_boundary_keeps_notes_unchanged(self):
        state = {'cancel': False}
        def observe(stage):
            if stage == 'prepared':
                state['cancel'] = True
        with self.assertRaises(RecoveryNeeded):
            publish(self.root, self.body, observe=observe, cancel=lambda: state['cancel'])
        self.assertFalse((self.root / 'Areas' / 'Raya.md').exists())
        self.assertEqual(Store(self.root).state(self.body['id'])['status'], 'prepared')


    def test_duplicate_refuses_damaged_retained_source_and_note_evidence(self):
        publish(self.root, self.body)
        target = self.root / 'Areas' / 'Raya.md'
        original = target.read_bytes()
        journal = self.root / 'System' / 'Changes' / self.body['id']
        for name in ('source-0.txt', 'after-0.md'):
            path = journal / name
            saved = path.read_bytes()
            path.write_bytes(b'damaged evidence')
            with self.assertRaisesRegex(ValueError, 'snapshot is damaged'):
                publish(self.root, self.body)
            self.assertEqual(target.read_bytes(), original)
            path.write_bytes(saved)
        self.assertTrue(publish(self.root, self.body)['duplicate'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
