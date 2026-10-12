"""Real note files and reviewed Policy; no model, capture or service starts."""
import hashlib
import ast
import fnmatch
import os
from pathlib import Path
from pathlib import PurePosixPath
import posixpath
import re
import sys
import tempfile
import unittest
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'service'))
from policy import Policy
from entries import project as active
# Execute the actual production reader without importing model catalogs, tokens
# or service runtime. No implementation is copied into this test.
SOURCE = HERE / 'service/index.py'
TREE = ast.parse(SOURCE.read_bytes())
NAMES = {'ordinary', 'image', 'address', 'links', 'capture_passage', 'passage', 'retrieve', 'headings', 'split', 'digest'}
CODE = ast.Module(body=[node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in NAMES], type_ignores=[])
# A conservative default only for isolated split tests; no tokenizer or model imports.
tokens = len
exec(compile(ast.fix_missing_locations(CODE), str(SOURCE), 'exec'), globals())


class Tests(unittest.TestCase):
    def capture(self, key, text):
        return ('## Raya capture ' + key + '\n\nInterpretation of a recorded conversation; not independently verified.\n\n'
                '### p0_cards\n\nOrigin: user_statement\nEvidence: [{"id":"original-user","start":0,"end":94}]\n\n' + text + '\n\n'
                '### p2_memory\n\nOrigin: user_statement\nEvidence: [{"id":"original-user","start":95,"end":177}]\n\n'
                'Inspect and adjust settings.\n\nOriginal user preference: I also prefer the Memory tab to be for manually inspecting and adjusting settings.\n\n'
                'Recorded update: 2026-10-09T18:30:00Z. Source snapshots: [user_statement](System/Changes/original/source-0.txt).\n')

    def test_latest_relevant_capture_is_complete_instead_of_an_early_duplicate_with_a_cut_tail(self):
        old = self.capture('00000000-0000-5000-8000-000000000001', 'For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms.')
        latest = self.capture('00000000-0000-5000-8000-000000000002', 'Concise conversational ask cards.\n\nOriginal user preference: For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms.')
        text = '# Preferences\n\n' + ''.join(old.replace('00000000-0000-5000-8000-000000000001', f'00000000-0000-5000-8000-{number:012x}') for number in range(16, 22)) + '\n' + latest
        query = 'first-time Raya setup preferences and Memory tab settings'
        row = passage('Preferences/Raya.md', text, query, 2000, len, lambda: None)
        self.assertIn('00000000-0000-5000-8000-000000000002', row['heading'])
        self.assertEqual(row['text'], latest.rstrip('\n'))
        self.assertEqual(row['text'], '\n'.join(text.splitlines()[row['line'] - 1:row['end_line']]))
        self.assertIn('Interpretation of a recorded conversation; not independently verified.', row['text'])
        self.assertIn('### p2_memory', row['text'])
        self.assertIn('Memory tab to be for manually inspecting and adjusting settings.', row['text'])
        self.assertLessEqual(row['tokens'], 2000)

    def test_capture_does_not_fallback_to_older_or_partial_text_when_its_complete_record_cannot_fit(self):
        text = self.capture('00000000-0000-5000-8000-000000000001', 'For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms.')
        text += self.capture('00000000-0000-5000-8000-000000000002', 'For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms.\n' + 'extra supported detail ' * 100)
        self.assertIsNone(passage('Preferences/Raya.md', text, 'first-time Raya setup', 2000, len, lambda: None))

    def test_atomic_capture_keeps_general_selection_fences_and_cancellation(self):
        text = '# General\n\nA lunar telescope aperture preference.\n\n'
        text += self.capture('00000000-0000-5000-8000-000000000001', 'Prefer concise forms.')
        row = passage('Preferences/Raya.md', text, 'lunar telescope aperture', 2000, len, lambda: None)
        self.assertEqual(row['line'], 3)
        plain = '# General\n\nA lunar telescope aperture preference.\n\n## Other\n\nAn ordinary fact.'
        self.assertEqual(passage('Preferences/Raya.md', plain, 'lunar telescope', 2000, len, lambda: None)['text'], '\n'.join(plain.splitlines()[2:]))
        fenced = '```md\n' + self.capture('00000000-0000-5000-8000-000000000001', 'For first-time Raya setup, prefer forms.') + '\n```\n'
        self.assertFalse(capture_passage('Preferences/Raya.md', fenced.splitlines(), headings(fenced.splitlines(), lambda: None), {'setup'}, 2000, len, lambda: None)[0])
        def cancel():
            raise TimeoutError('cancelled')
        with self.assertRaisesRegex(TimeoutError, 'cancelled'):
            passage('Preferences/Raya.md', text, 'forms', 2000, len, cancel)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='raya-linked-')
        self.root = Path(self.tmp.name).resolve()
        self.notes = {'INDEX.md': '# Memory\n[Preferences](Preferences/lights.md)\n',
                      'Projects/eden.md': '# Eden\nEden builds workplace tools.\n[Lights](../Preferences/lights.md)\n',
                      'Preferences/lights.md': '# Lights\nPrefer slow warm lighting.\n[Project](../Projects/eden.md)\n[Daily](../Daily/today.md)\n',
                      'Daily/today.md': '# Today\nAn evening walk is planned.\n[Too deep](../People/next.md)\n',
                      'People/next.md': '# Next\nThis is beyond depth two.\n'}
        for name, text in self.notes.items():
            path = self.root / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(text.encode())
        self.policy = Policy({'format': 'raya-general-sources-v1', 'root': str(self.root),
                              'enabled': True, 'revision': 1, 'files': [
                                  {'relative': name, 'sha256': self.sha(text), 'classification': 'general', 'review': 'approved'}
                                  for name, text in self.notes.items()]})

    def tearDown(self):
        self.tmp.cleanup()

    def sha(self, text):
        return hashlib.sha256(text.encode()).hexdigest()

    def recall(self, **opts):
        seed = {'relative': 'Projects/eden.md', 'sha256': self.sha(self.notes['Projects/eden.md'])}
        return retrieve(self.root, self.policy, opts.pop('seeds', [seed]), 'Eden',
                        opts.pop('budget', 1000), opts.pop('measure', len), opts.pop('check', lambda: None), **opts)

    def test_relevant_first_entry_links_cycles_and_depth(self):
        value = self.recall()
        self.assertEqual([row['relative'] for row in value['sources']],
                         ['Projects/eden.md', 'INDEX.md', 'Preferences/lights.md', 'Daily/today.md'])
        self.assertEqual([row['depth'] for row in value['sources']], [0, 0, 1, 2])
        self.assertFalse(value['capture_enabled'])
        for row in value['sources']:
            raw = (self.root / row['relative']).read_bytes()
            self.assertEqual(row['source_sha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(row['text'], '\n'.join(raw.decode().splitlines()[row['line'] - 1:row['end_line']]))

    def test_budget_and_explicit_truncation(self):
        value = self.recall(budget=85)
        self.assertLessEqual(value['tokens'], 85)
        self.assertTrue(value['truncated'])
        self.assertEqual(value['tokens'], sum(row['tokens'] for row in value['sources']))
        self.assertEqual(len(self.recall(count=1)['sources']), 1)

    def test_stale_seed_is_diagnostic_and_not_returned(self):
        value = self.recall(seeds=[{'relative': 'Projects/eden.md', 'sha256': '0' * 64}], depth=0)
        self.assertEqual([row['relative'] for row in value['sources']], ['INDEX.md'])
        self.assertIn('stale', value['diagnostics'][0]['reason'])

    def test_changed_approved_file_is_never_returned(self):
        (self.root / 'Preferences/lights.md').write_text('unreviewed private facts', encoding='utf-8')
        value = self.recall()
        self.assertNotIn('Preferences/lights.md', [row['relative'] for row in value['sources']])
        self.assertIn('revision changed', str(value['diagnostics']))

    def test_excluded_and_unapproved_link(self):
        (self.root / '.rayaignore').write_text('Preferences/\n', encoding='utf-8')
        value = self.recall()
        self.assertNotIn('Preferences/lights.md', [row['relative'] for row in value['sources']])
        self.policy.files['preferences/lights.md']['review'] = 'proposed'
        (self.root / '.rayaignore').unlink()
        self.assertNotIn('Preferences/lights.md', [row['relative'] for row in self.recall()['sources']])

    def test_absolute_encoded_foreign_missing_and_fenced_links(self):
        text = '# Memory\n' + '\n'.join('[bad](' + value + ')' for value in
                                        ('../../secret.md', '/secret.md', 'C:/secret.md',
                                         '%2e%2e/%2e%2e/secret.md', 'https://example.com/a.md',
                                         'missing.md', 'System/private.md'))
        text += '\n```md\n[Example](People/next.md)\n```\n'
        (self.root / 'INDEX.md').write_bytes(text.encode())
        self.policy.files['index.md']['sha256'] = self.sha(text)
        value = self.recall(seeds=[])
        self.assertEqual([row['relative'] for row in value['sources']], ['INDEX.md'])
        self.assertEqual(len(value['diagnostics']), 7)

    def test_links_do_not_bypass_policy_for_same_named_foreign_root(self):
        with tempfile.TemporaryDirectory() as foreign:
            with self.assertRaisesRegex(ValueError, 'different root'):
                retrieve(foreign, self.policy, [], '', 100, len, lambda: None)

    def test_mutation_during_selection_refuses_all_results(self):
        calls = 0
        def measure(text):
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.root / 'Projects/eden.md').write_text('changed', encoding='utf-8')
            return len(text)
        with self.assertRaisesRegex(ValueError, 'revision changed'):
            self.recall(measure=measure)

    def test_cancellation_propagates_without_publication(self):
        before = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob('*.md')}
        def cancel():
            raise TimeoutError('cancelled')
        with self.assertRaisesRegex(TimeoutError, 'cancelled'):
            self.recall(check=cancel)
        self.assertEqual(before, {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob('*.md')})

    def test_hardlinked_source_is_refused(self):
        import os
        path = self.root / 'Preferences/lights.md'
        os.link(path, self.root / 'duplicate.md')
        self.assertNotIn('Preferences/lights.md', [row['relative'] for row in self.recall()['sources']])

    def test_disabled_and_invalid_budgets(self):
        self.policy.enabled = False
        with self.assertRaisesRegex(ValueError, 'disabled'):
            self.recall()
        self.policy.enabled = True
        for opts in ({'budget': True}, {'budget': 12001}, {'count': 13}, {'depth': 3}, {'entry': 2001}):
            with self.assertRaises(ValueError):
                self.recall(**opts)

    def test_navigation_attempts_are_bounded(self):
        text = '# Memory\n' + '\n'.join(f'[link](missing-{index}.md)' for index in range(1000))
        (self.root / 'INDEX.md').write_bytes(text.encode())
        self.policy.files['index.md']['sha256'] = self.sha(text)
        value = self.recall(seeds=[], count=2)
        self.assertLessEqual(len(value['diagnostics']), 16)
        self.assertIn('Navigation attempt budget exhausted', str(value['diagnostics']))

    def test_no_passage_fits_reports_truncation(self):
        value = self.recall(seeds=[], budget=1)
        self.assertEqual(value['sources'], [])
        self.assertEqual(value['tokens'], 0)
        self.assertTrue(value['truncated'])
        self.assertIn('No passage fits', str(value['diagnostics']))

    def test_recall_preserves_preceding_historical_qualifier(self):
        text = '# Preferences\n\nHistorical preference; replaced on 2026-10-05.\nMovie lights used blue and cyan.\n\nCurrent preference: warm amber.\n'
        value = passage('Preferences/lights.md', text, 'movie lights blue cyan', 1000, len, lambda: None)
        self.assertEqual(value['line'], 3)
        self.assertIn('Historical preference; replaced', value['text'])
        self.assertIn('Movie lights used blue and cyan.', value['text'])
        self.assertEqual(value['text'], '\n'.join(text.splitlines()[value['line'] - 1:value['end_line']]))

    def test_recall_labels_indented_current_sections(self):
        for indent in range(4):
            with self.subTest(indent=indent):
                text = '# Historical\nOld preference.\n\n' + ' ' * indent + '## Current preference\n\nPrefer amber movie lights.\n'
                value = passage('Preferences/lights.md', text, 'amber movie lights', 500, len, lambda: None)
                self.assertEqual(value['heading'], 'Current preference')
                self.assertEqual(value['text'], '\n'.join(text.splitlines()[value['line'] - 1:value['end_line']]))

    def test_recall_does_not_label_fenced_examples_as_sections(self):
        for fence in ('```', '~~~~'):
            with self.subTest(fence=fence):
                text = '# Current preference\n\n' + fence + 'md\n# Historical example\n' + fence + '\n\nPrefer amber movie lights.\n'
                value = passage('Preferences/lights.md', text, 'amber movie lights', 500, len, lambda: None)
                self.assertEqual(value['heading'], 'Current preference')

    def test_recall_does_not_label_indented_code_as_a_section(self):
        text = '# Current preference\n\n    # Historical example\n\nPrefer amber movie lights.\n'
        value = passage('Preferences/lights.md', text, 'amber movie lights', 500, len, lambda: None)
        self.assertEqual(value['heading'], 'Current preference')

    def test_recall_strips_only_valid_closing_heading_markers(self):
        for title, expected in (('Current preference ###', 'Current preference'), ('Current preference#', 'Current preference#'), ('Current\tpreference\t##', 'Current\tpreference')):
            with self.subTest(title=title):
                text = '# Historical\n\n## ' + title + '\n\nPrefer amber movie lights.\n'
                value = passage('Preferences/lights.md', text, 'amber movie lights', 500, len, lambda: None)
                self.assertEqual(value['heading'], expected)

    def test_recall_retains_section_until_the_real_fence_closes(self):
        text = '# Current preference\n\n````md\n```\n# Short fence example\n```` invalid closer\n# Still an example\n````\n\nPrefer amber movie lights.\n'
        value = passage('Preferences/lights.md', text, 'amber movie lights', 500, len, lambda: None)
        self.assertEqual(value['heading'], 'Current preference')

    def test_index_and_recall_use_the_same_real_section(self):
        # Conservative character measurement isolates section provenance; this
        # does not assert model tokenization or start an embedding service.
        scope = dict(globals(), tokens=len, remaining=lambda: None)
        exec(compile(ast.fix_missing_locations(CODE), str(SOURCE), 'exec'), scope)
        for title in ('## Current preference', '   ## Current preference ###', '##\tCurrent preference'):
            with self.subTest(title=title):
                text = '# Historical\nOld preference.\n\n' + title + '\n\n```md\n# Historical example\n```\n\nPrefer amber movie lights.\n'
                note = {'text': text, 'hash': self.sha(text)}
                chunks = scope['split']('Preferences/lights.md', note)
                selected = next(row for row in chunks if 'Prefer amber movie lights.' in row['text'])
                value = passage('Preferences/lights.md', text, 'amber movie lights', 500, len, lambda: None)
                self.assertEqual(selected['heading'], 'Current preference')
                self.assertEqual(value['heading'], selected['heading'])
                self.assertEqual(selected['filehash'], self.sha(text))
                self.assertEqual(selected['contenthash'], self.sha(selected['text']))

    def test_heading_scan_cancellation_propagates(self):
        def cancel():
            raise TimeoutError('cancelled during heading scan')
        with self.assertRaisesRegex(TimeoutError, 'heading scan'):
            headings(['# Current preference', 'Prefer amber movie lights.'], cancel)

    def test_corrected_chunk_labels_have_a_new_index_recipe(self):
        node = next(row for row in TREE.body if isinstance(row, ast.Assign) and
                    any(isinstance(target, ast.Name) and target.id == 'SIGNATURE' for target in row.targets))
        scope = {'MODEL': {'revision': 'synthetic-unchanged-model'}, 'SPACE': {'dimensions': 1024}}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(SOURCE), 'exec'), scope)
        self.assertEqual(scope['SIGNATURE'], 'markdown-v5:300tokens:1024:normalized:active-entries:local-link-labels:synthetic-unchanged-model')
        self.assertNotEqual(scope['SIGNATURE'], 'markdown-v3:300tokens:1024:normalized:local-link-labels:synthetic-unchanged-model')

    def test_recall_preserves_following_conflict_qualifier(self):
        text = '# Preferences\n\nMovie lights should be blue and cyan.\nUnconfirmed suggestion, not a user preference.\n\nOther notes.\n'
        prefix = 'Source: Preferences/lights.md\nSection: Preferences\n'
        limit = len(prefix + 'Movie lights should be blue and cyan.')
        self.assertIsNone(passage('Preferences/lights.md', text, 'movie blue cyan', limit, len, lambda: None))
        value = passage('Preferences/lights.md', text, 'movie blue cyan', 1000, len, lambda: None)
        self.assertIn('Unconfirmed suggestion, not a user preference.', value['text'])

    def test_oversized_qualified_paragraph_does_not_return_orphan_fact(self):
        text = '# Preferences\n\n' + 'Historical detail. ' * 80 + '\nMovie lights used blue cyan.\n'
        self.assertIsNone(passage('Preferences/lights.md', text, 'movie lights blue cyan', 150, len, lambda: None))

    def test_paragraph_selection_cancellation_remains_observable(self):
        text = '# Preferences\n\nHistorical detail.\nMovie lights used blue cyan.\n'
        def cancel():
            raise TimeoutError('cancelled')
        with self.assertRaisesRegex(TimeoutError, 'cancelled'):
            passage('Preferences/lights.md', text, 'movie lights blue cyan', 1000, len, cancel)

    def test_reviewed_recall_keeps_qualifiers_hashes_and_diagnostics(self):
        name = 'Preferences/lights.md'
        text = '# Lights\n\nHistorical preference; replaced yesterday.\nMovie lights used blue cyan.\n\nCurrent preference is warm amber.\n'
        raw = text.encode()
        (self.root / name).write_bytes(raw)
        self.policy.files[name.casefold()]['sha256'] = self.sha(text)
        seed = {'relative': name, 'sha256': self.sha(text)}
        value = retrieve(self.root, self.policy, [seed], 'movie lights blue cyan', 1000, len, lambda: None)
        note = next(row for row in value['sources'] if row['relative'] == name)
        self.assertIn('Historical preference; replaced yesterday.', note['text'])
        self.assertIn('Current preference is warm amber.', note['text'])
        self.assertEqual(note['source_sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(note['text'], '\n'.join(text.splitlines()[note['line'] - 1:note['end_line']]))
        self.assertLessEqual(value['tokens'], 1000)
        self.assertFalse(value['capture_enabled'])
        small = retrieve(self.root, self.policy, [seed], 'movie lights blue cyan', 90, len, lambda: None)
        self.assertNotIn(name, [row['relative'] for row in small['sources']])
        self.assertTrue(small['truncated'])
        self.assertIn('No passage fits', str(small['diagnostics']))
        self.assertEqual((self.root / name).read_bytes(), raw)

    def test_exclusions_changed_during_selection_refuses_all_results(self):
        def measure(text):
            (self.root / '.rayaignore').write_text('Projects/\n', encoding='utf-8')
            return len(text)
        with self.assertRaisesRegex(ValueError, 'exclusions changed'):
            self.recall(measure=measure)


if __name__ == '__main__':
    unittest.main()
