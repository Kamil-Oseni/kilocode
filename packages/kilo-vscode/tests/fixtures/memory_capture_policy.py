"""Actual Windows publication and journal-bound policy succession; no models."""
import hashlib
import json
from pathlib import Path
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_capture as support

from capture import authorize, publish, refresh
from admission import Store as Admission
from notes import Store, RecoveryNeeded


class Tests(unittest.TestCase):
    setUp = support.Tests.setUp
    tearDown = support.Tests.tearDown
    structured = support.Tests.structured

    def policy(self, files=None, enabled=True):
        Store(self.root)
        admission = Admission(self.root, existing=True)
        prior = json.loads(admission.file.read_bytes()) if admission.file.exists() else None
        return admission.replace(dict(format='raya-general-sources-v1', root=str(self.root), enabled=enabled,
            revision=prior['revision'] + 1 if prior else 1, files=files or []),
            hashlib.sha256(admission.file.read_bytes()).hexdigest() if prior else None)

    def row(self, name, review='approved'):
        path = self.root / name
        path.parent.mkdir(exist_ok=True)
        path.write_text('Preserve my original text.\n', encoding='utf-8')
        return dict(relative=name, sha256=hashlib.sha256(path.read_bytes()).hexdigest(), classification='general', review=review)

    def test_existing_preference_new_diary_and_unrelated_decisions_are_preserved(self):
        body = self.structured()
        body['entries'][0]['category'] = 'Preferences'
        body['entries'].append(dict(body['entries'][0], category='Daily', key='original-day'))
        prior = self.row('Preferences/Raya.md')
        other = self.row('Projects/Unrelated.md', 'proposed')
        sha = self.policy([prior, other])
        authorize(self.root, body, sha)
        effect = publish(self.root, body)
        calls = []
        result = refresh(self.root, body['id'], effect['input_sha256'], sha, lambda: calls.append('actual-gate'))
        saved = json.loads(Admission(self.root, existing=True).file.read_bytes())
        records = {row['relative']: row for row in saved['files']}
        self.assertEqual(records['Projects/Unrelated.md'], other)
        for name in ['Preferences/Raya.md', 'Daily/' + body['day'] + '.md']:
            self.assertEqual(records[name]['review'], 'approved')
            self.assertEqual(records[name]['sha256'], hashlib.sha256((self.root / name).read_bytes()).hexdigest())
            self.assertIn('Recorded update:', (self.root / name).read_text())
        self.assertTrue((self.root / 'Preferences/Raya.md').read_text().startswith('Preserve my original text.'))
        self.assertGreater(len(calls), 0)
        self.assertEqual(result['revision'], 2)
        self.assertEqual(hashlib.sha256(Admission(self.root, existing=True).file.read_bytes()).hexdigest(), result['policy_sha256'])

    def test_existing_unapproved_note_cannot_be_admitted(self):
        body = self.structured()
        self.row('Areas/Raya.md')
        sha = self.policy()
        with self.assertRaisesRegex(ValueError, 'unapproved'):
            authorize(self.root, body, sha)
        effect = publish(self.root, body)
        before = Admission(self.root, existing=True).file.read_bytes()
        with self.assertRaisesRegex(ValueError, 'unapproved'):
            refresh(self.root, body['id'], effect['input_sha256'], sha, lambda: None)
        self.assertEqual(Admission(self.root, existing=True).file.read_bytes(), before)

    def test_changed_input_or_newer_edit_cannot_refresh_policy(self):
        body = self.structured()
        sha = self.policy()
        effect = publish(self.root, body)
        with self.assertRaisesRegex(ValueError, 'fingerprint'):
            refresh(self.root, body['id'], '0'*64, sha, lambda: None)
        path = self.root / 'Areas/Raya.md'
        path.write_text(path.read_text() + 'Later human edit.', encoding='utf-8')
        before = Admission(self.root, existing=True).file.read_bytes()
        with self.assertRaisesRegex(ValueError, 'different note'):
            refresh(self.root, body['id'], effect['input_sha256'], sha, lambda: None)
        self.assertEqual(Admission(self.root, existing=True).file.read_bytes(), before)

    def test_disabled_changed_or_revoked_authority_leaves_policy_unchanged(self):
        body = self.structured()
        sha = self.policy()
        effect = publish(self.root, body)
        def revoked():
            raise ValueError('Original consent revoked')
        before = Admission(self.root, existing=True).file.read_bytes()
        with self.assertRaisesRegex(ValueError, 'revoked'):
            refresh(self.root, body['id'], effect['input_sha256'], sha, revoked)
        self.assertEqual(Admission(self.root, existing=True).file.read_bytes(), before)
        paused = self.policy(enabled=False)
        before = Admission(self.root, existing=True).file.read_bytes()
        with self.assertRaises(ValueError):
            refresh(self.root, body['id'], effect['input_sha256'], paused, lambda: None)
        self.assertEqual(Admission(self.root, existing=True).file.read_bytes(), before)

    def test_uncommitted_or_damaged_original_journal_never_admits_sources(self):
        body = self.structured()
        sha = self.policy()
        effect = publish(self.root, body)
        path = Store(self.root).journal / body['id'] / 'manifest.json'
        state = json.loads(path.read_bytes())
        state['status'] = 'prepared'
        path.write_text(json.dumps(state), encoding='utf-8')
        before = Admission(self.root, existing=True).file.read_bytes()
        with self.assertRaises(RecoveryNeeded):
            refresh(self.root, body['id'], effect['input_sha256'], sha, lambda: None)
        self.assertEqual(Admission(self.root, existing=True).file.read_bytes(), before)

    def test_capacity_refuses_before_publication_without_dropping_rows(self):
        body = self.structured()
        rows = [self.row('Projects/source-' + str(index) + '.md') for index in range(128)]
        sha = self.policy(rows)
        before = Admission(self.root, existing=True).file.read_bytes()
        with self.assertRaisesRegex(ValueError, '128 notes'):
            authorize(self.root, body, sha)
        self.assertEqual(Admission(self.root, existing=True).file.read_bytes(), before)
        self.assertFalse((self.root / 'Areas/Raya.md').exists())


if __name__ == '__main__':
    unittest.main()
