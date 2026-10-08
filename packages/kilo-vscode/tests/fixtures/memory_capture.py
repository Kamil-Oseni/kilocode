"""Real Windows Markdown Store publication in disposable directories; no models."""
import copy
import hashlib
import json
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
    def structured(self):
        body = copy.deepcopy(self.body)
        body['format'] = 'raya.memory.capture.v3'
        body['source'] = {'user': {'id': 'user-original', 'text': 'We are out of eggs.'},
                          'assistant': {'id': body['message'], 'text': 'I added eggs.'},
                          'tools': [{'id': 'tool-original', 'name': 'shopping', 'status': 'error', 'text': 'List unavailable'}]}
        framed = [body['observed_utc'], body['source']['user']['id'], body['source']['user']['text'],
                  body['message'], body['source']['assistant']['text'],
                  [[row['id'], row['name'], row['status'], row['text']] for row in body['source']['tools']]]
        body['source_sha256'] = hashlib.sha256(json.dumps(framed, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        digest = hashlib.sha256(json.dumps([body['project'], body['session'], body['message']],
                                          ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        body['id'] = str(uuid.UUID(hex=digest[:32], version=5))
        body['entries'][0].update(origin='user_statement', evidence=[{'id': 'user-original', 'start': 0, 'end': 19}])
        return body

    def test_structured_publication_preserves_source_classes_and_failed_tools(self):
        body = self.structured()
        result = publish(self.root, body)
        state = Store(self.root).state(body['id'])
        self.assertEqual(result['status'], 'committed')
        self.assertEqual({row['kind'] for row in state['sources']},
                         {'user_statement', 'assistant_interpretation', 'tool_observation'})
        self.assertIn('Origin: user_statement', (self.root / 'Areas/Raya.md').read_text())
        source = self.root / 'System/Capture' / body['id'] / 'tool_observation.md'
        self.assertEqual(json.loads(source.read_text())['sources'][0]['status'], 'error')
        self.assertTrue(publish(self.root, body)['duplicate'])

    def test_structured_assistant_claim_cannot_be_tool_evidence(self):
        body = self.structured()
        body['entries'][0].update(origin='tool_observation', evidence=[{'id': body['message'], 'start': 0, 'end': 5}])
        with self.assertRaisesRegex(ValueError, 'original source'):
            publish(self.root, body)
        self.assertFalse((self.root / 'Areas/Raya.md').exists())

    def test_structured_changed_source_and_foreign_turn_refuse_before_publication(self):
        body = self.structured()
        body['source']['tools'][0]['status'] = 'completed'
        with self.assertRaisesRegex(ValueError, 'digest differs'):
            publish(self.root, body)
        body = self.structured()
        body['message'] = 'another-reply'
        with self.assertRaisesRegex(ValueError, 'original turn'):
            publish(self.root, body)
        self.assertFalse((self.root / 'Areas/Raya.md').exists())

    def test_structured_evidence_uses_bounded_original_spans(self):
        body = self.structured()
        body['entries'][0]['evidence'][0]['end'] = 200
        with self.assertRaisesRegex(ValueError, 'span differs'):
            publish(self.root, body)
        body = self.structured()
        body['entries'][0]['origin'] = ['invented']
        with self.assertRaisesRegex(ValueError, 'attribution differs'):
            publish(self.root, body)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='raya-capture-')).resolve()
        self.body = {'format': 'raya.memory.capture.v2', 'id': str(uuid.uuid4()), 'project': str(self.root),
                     'session': 'session-original', 'message': 'reply-original',
                     'observed_utc': '2026-10-08T19:00:00+00:00', 'day': '2026-10-08', 'zone': 'America/Toronto',
                     'source': 'User: We are out of eggs.',
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

    def test_daily_uses_original_date_and_preserves_existing_note(self):
        # Toronto evening falls on the following UTC date; the caller stamps its diary day.
        self.body['observed_utc'] = '2026-10-09T02:00:00+00:00'
        target = self.root / 'Daily' / '2026-10-08.md'
        target.parent.mkdir()
        target.write_text('# My day\nKeep my original entry.\n', encoding='utf-8')
        self.body['entries'].append({'category': 'Daily', 'key': 'groceries-request',
                                     'text': 'Requested eggs for the shopping list.'})
        result = publish(self.root, self.body)
        self.assertEqual(result['status'], 'committed')
        self.assertTrue(target.read_text(encoding='utf-8').startswith('# My day\nKeep my original entry.\n'))
        self.assertIn('groceries-request', target.read_text(encoding='utf-8'))
        self.assertFalse((target.parent / 'Raya.md').exists())
        self.assertFalse((target.parent / '2026-10-09.md').exists())
        self.assertTrue((self.root / 'Areas' / 'Raya.md').exists())
        original = target.read_bytes()
        self.assertTrue(publish(self.root, self.body)['duplicate'])
        self.assertEqual(target.read_bytes(), original)
        state = Store(self.root).state(self.body['id'])
        self.assertEqual({entry['path'] for entry in state['changes']}, {'Daily/2026-10-08.md', 'Areas/Raya.md'})
        snapshot = self.root / 'System' / 'Changes' / self.body['id'] / 'source-0.txt'
        self.assertIn('"day": "2026-10-08"', snapshot.read_text(encoding='utf-8'))
        self.assertIn('"zone": "America/Toronto"', snapshot.read_text(encoding='utf-8'))
        target.write_text('Later diary edit', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'newer note edit'):
            publish(self.root, self.body)
        self.assertEqual(target.read_text(encoding='utf-8'), 'Later diary edit')

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
                             ('observed_utc', '2026-10-08T19:00:00'), ('source', 'x' * 65537),
                             ('format', 'raya.memory.capture.v1'), ('day', '2026-02-30'),
                             ('day', '20261008'), ('day', '../2026-10-08'), ('day', None),
                             ('zone', ''), ('zone', '../Toronto'), ('zone', 'x' * 256), ('zone', None)]:
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
