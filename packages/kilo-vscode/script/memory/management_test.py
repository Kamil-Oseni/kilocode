"""Disposable real journals/notes and production readers; no models or services."""
import ast
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'service'))
from entries import project as active, records, render
from management import Management, publish, source
from notes import RecoveryNeeded
from capture import publish as capture, refresh as admit

# Execute the original reader functions without catalog/token/runtime imports.
TREE = ast.parse((HERE / 'service/index.py').read_bytes())
NAMES = {'headings', 'split', 'links', 'capture_passage', 'passage'}
CODE = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in NAMES], type_ignores=[])
tokens = len
remaining = lambda: None
digest = lambda raw: hashlib.sha256(raw).hexdigest()
exec(compile(ast.fix_missing_locations(CODE), str(HERE / 'service/index.py'), 'exec'), globals())


class Personal(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='raya-personal-entries-')
        root = Path(self.tmp.name).resolve()
        self.notes = root / 'notes'
        self.notes.mkdir()
        self.project = root / 'project'
        self.project.mkdir()
        self.api = Management(self.notes)
        self.policy = self.api.store.admission.replace({'format': 'raya-general-sources-v1', 'root': str(self.notes),
                'enabled': True, 'revision': 1, 'files': []}, None)

    def tearDown(self):
        self.tmp.cleanup()

    def original(self, text):
        value = {'sessionID': 'ses_fixture', 'messageID': 'msg_' + uuid.uuid4().hex,
                 'created_utc': '2026-10-12T00:00:00.000Z', 'text': text}
        value['source_sha256'] = digest(json.dumps([value['sessionID'], value['messageID'], value['created_utc'], text], ensure_ascii=False, separators=(',', ':')).encode())
        return value

    def preview(self, mode, text='I prefer tea.', **fields):
        original = self.original(text)
        body = {'action': 'preview', 'project': str(self.project), 'id': str(uuid.uuid4()), 'mode': mode,
                'source': original, 'expected_policy_sha256': self.policy, **fields}
        if mode != 'forget':
            body['fact'] = {'start': 0, 'end': len(text.encode('utf-16-le')) // 2}
        return self.api.execute(body)

    def candidates(self, query):
        return self.api.execute({'action': 'candidates', 'project': str(self.project), 'query': query,
                                 'expected_policy_sha256': self.policy})['candidates']

    def apply(self, value):
        admitted = publish(self.notes, value['id'], value['digest'], self.policy, lambda: None)
        self.policy = admitted['policy_sha256']
        self.assertTrue(admitted['publication_confirmed'])
        self.assertFalse(admitted['index_confirmed'])
        self.assertEqual(admitted['journal_id'], value['id'])
        self.assertEqual(self.api.load(value['id'])['status'], 'applied')
        return self.notes / value['changes'][0]['path']

    def test_remember_correct_forget_preserve_history_and_all_recall_paths(self):
        for category in ['Preferences', 'Daily']:
            remembered = self.preview('remember', 'My drink is tea.', category=category)
            path = self.apply(remembered)
            before = path.read_bytes()
            candidates = [row for row in self.candidates('drink tea') if row['relative'] == remembered['changes'][0]['path']]
            self.assertEqual(len(candidates), 1)
            corrected = self.preview('correct', 'My drink is coffee.', candidate=candidates[0]['id'])
            self.apply(corrected)
            self.assertTrue(path.read_bytes().startswith(before))
            text = path.read_text(encoding='utf8')
            name = path.relative_to(self.notes).as_posix()
            self.assertNotIn('My drink is tea.', active(name, text))
            self.assertIn('My drink is coffee.', active(name, text))
            chunks = split(name, {'text': text, 'hash': digest(path.read_bytes())}, len)
            self.assertNotIn('My drink is tea.', '\n'.join(row['text'] for row in chunks))
            row = passage(name, text, 'coffee', 2000, len, lambda: None)
            self.assertNotIn('My drink is tea.', row['text'])
            selected = [row for row in self.candidates('coffee') if row['relative'] == name]
            forgotten = self.preview('forget', 'Forget my drink.', candidate=selected[0]['id'])
            prior = path.read_bytes()
            self.apply(forgotten)
            self.assertTrue(path.read_bytes().startswith(prior))
            self.assertNotIn('My drink is coffee.', active(name, path.read_text(encoding='utf8')))
            self.assertEqual([row for row in self.candidates('coffee') if row['relative'] == name], [])
            self.assertEqual(self.api.store.state(forgotten['id'])['status'], 'committed')

    def test_curated_unrelated_bytes_and_forgotten_links_are_preserved_but_not_followed(self):
        name = 'Preferences/curated.md'
        path = self.notes / name
        path.parent.mkdir()
        original = b'# Preferences\r\n\r\nTea habit with [old link](../Projects/old.md).\r\n\r\nUnrelated blue preference.\r\n'
        path.write_bytes(original)
        old = json.loads(self.api.store.admission.file.read_bytes())
        self.policy = self.api.store.admission.replace(dict(old, revision=old['revision'] + 1,
            files=[{'relative': name, 'sha256': digest(original), 'classification': 'general', 'review': 'approved'}]), self.policy)
        candidate = self.candidates('Tea habit')[0]
        forgotten = self.preview('forget', 'Forget tea habit.', candidate=candidate['id'])
        self.apply(forgotten)
        self.assertTrue(path.read_bytes().startswith(original))
        projected = active(name, path.read_bytes().decode())
        self.assertIn('Unrelated blue preference.', projected)
        self.assertNotIn('Tea habit', projected)
        self.assertNotIn('../Projects/old.md', list(links(path.read_bytes().decode(), name)))

    def test_stale_revision_and_foreign_candidate_refuse_without_a_journal(self):
        value = self.preview('remember', category='Preferences')
        path = self.apply(value)
        candidate = self.candidates('tea')[0]
        pending = self.preview('correct', 'I prefer coffee.', candidate=candidate['id'])
        path.write_bytes(path.read_bytes() + b'\nExternal newer edit.\n')
        with self.assertRaises(ValueError):
            self.api.execute({'action': 'apply', 'project': str(self.project), 'id': pending['id'], 'digest': pending['digest']})
        self.assertFalse((self.api.store.journal / pending['id']).exists())
        self.assertIn(b'External newer edit', path.read_bytes())

    def test_utf16_original_fact_boundaries_and_source_hash(self):
        value = self.original('😀 tea')
        self.assertEqual(source(value, {'start': 3, 'end': 6}, 'remember'), 'tea')
        with self.assertRaises(UnicodeDecodeError):
            source(value, {'start': 1, 'end': 2}, 'remember')
        with self.assertRaises(ValueError):
            source(dict(value, text='substituted'), {'start': 0, 'end': 3}, 'remember')

    def test_approved_people_entry_is_selectable_without_admitting_private_sources(self):
        value = self.preview('remember', 'Alice prefers tea.', category='People')
        path = self.apply(value)
        candidates = self.candidates('Alice')
        self.assertEqual([row['relative'] for row in candidates], ['People/Raya.md'])
        self.assertEqual(candidates[0]['excerpt_sha256'], digest(candidates[0]['excerpt'].encode('utf8')))
        self.assertIn('Alice prefers tea.', active('People/Raya.md', path.read_text(encoding='utf8')))
        with self.assertRaises(ValueError):
            self.preview('remember', 'A private fixture.', category='Private')

    def test_duplicate_active_identity_refuses_and_fenced_examples_remain_unrelated(self):
        entry = render(str(uuid.uuid4()), 'a' * 64, 'A bounded fixture fact.')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            active('Preferences/Raya.md', entry + entry)
        example = '\n```html\n<!-- raya.memory.entry.v1 example -->\n```\n'
        self.assertIn('<!-- raya.memory.entry.v1 example -->', active('Preferences/Raya.md', entry + example))

    def test_actual_captured_entry_mutation_preserves_original_receipts_and_all_readers(self):
        text = 'My captured drink preference is tea.'
        stamp = '2026-10-12T00:00:00.000Z'
        user = {'id': 'msg_capture_user', 'text': text}
        assistant = {'id': 'msg_capture_reply', 'text': 'Understood.'}
        framed = json.dumps([str(self.project), 'ses_capture', assistant['id']], ensure_ascii=False, separators=(',', ':'))
        key = str(uuid.UUID(hex=digest(framed.encode())[:32], version=5))
        proof = [stamp, user['id'], user['text'], assistant['id'], assistant['text'], []]
        body = {'format': 'raya.memory.capture.v3', 'id': key, 'project': str(self.project), 'session': 'ses_capture',
                'message': assistant['id'], 'observed_utc': stamp, 'day': '2026-10-12', 'zone': 'UTC',
                'source': {'user': user, 'assistant': assistant, 'tools': []},
                'source_sha256': digest(json.dumps(proof, ensure_ascii=False, separators=(',', ':')).encode()),
                'entries': [{'category': 'Preferences', 'key': 'drink', 'text': text, 'origin': 'user_statement',
                             'evidence': [{'id': user['id'], 'start': 0, 'end': len(text.encode('utf-16-le')) // 2}]}]}
        saved = capture(self.notes, body, expected=self.policy)
        self.policy = admit(self.notes, key, saved['input_sha256'], self.policy, lambda: None)['policy_sha256']
        folders = [self.api.store.system / 'Capture' / key, self.api.store.journal / key]
        original = {file: file.read_bytes() for folder in folders for file in folder.iterdir()}
        candidate = self.candidates('captured drink tea')[0]
        self.assertEqual(candidate['kind'], 'capture')
        corrected = self.preview('correct', 'My captured drink preference is coffee.', candidate=candidate['id'])
        path = self.apply(corrected)
        note = 'Preferences/Raya.md'
        raw = path.read_bytes()
        self.assertNotIn(text, active(note, raw.decode()))
        self.assertNotIn(text, '\n'.join(row['text'] for row in split(note, {'text': raw.decode(), 'hash': digest(raw)}, len)))
        self.assertNotIn(text, passage(note, raw.decode(), 'coffee', 2000, len, lambda: None)['text'])
        candidate = self.candidates('coffee')[0]
        forgotten = self.preview('forget', 'Forget the captured drink preference.', candidate=candidate['id'])
        self.apply(forgotten)
        self.assertNotIn('My captured drink preference is coffee.', active(note, path.read_bytes().decode()))
        self.assertEqual(self.candidates('captured drink'), [])
        self.assertEqual({file: file.read_bytes() for file in original}, original)

    def test_interrupted_publication_remains_original_id_unconfirmed_without_replay(self):
        value = self.preview('remember', category='Daily')
        def interrupt():
            if (self.api.store.journal / value['id'] / 'manifest.json').exists():
                raise RuntimeError('Disposable publication interruption')
        self.api.gate = interrupt
        with self.assertRaises(RecoveryNeeded):
            self.api.execute({'action': 'apply', 'project': str(self.project), 'id': value['id'], 'digest': value['digest']})
        self.api.gate = None
        observed = self.api.execute({'action': 'read', 'project': str(self.project), 'id': value['id']})
        self.assertEqual(observed['status'], 'applying')
        self.assertFalse(observed['publication_confirmed'])
        with self.assertRaises(RecoveryNeeded):
            self.api.execute({'action': 'apply', 'project': str(self.project), 'id': value['id'], 'digest': value['digest']})
        self.assertEqual(self.api.store.state(value['id'])['status'], 'preparing')


if __name__ == '__main__':
    unittest.main()
