"""Disposable actual authenticated publications; historical review never writes or runs a model."""
import asyncio
import copy
import hashlib
import json
import unittest
import uuid
import sys
from pathlib import Path
import os
import importlib.util
import subprocess
import gzip
import tempfile
import shutil
import httpx
from capture_recovery_test import Recovery
from capture_recovery import review as original
from capture_revision import review, diagnostic


class Revisions(Recovery):
    def test_current_marker_reference_review_binds_original_predecessor_dependencies(self):
        self.body['entries'][0]['text'] += '\n\nOriginal user preference: ' + self.body['source']['user']['text']
        first, _ = self.later('exact-preference-first')
        second, _ = self.later('exact-preference-repeat')
        stamps = [json.loads((self.notes / 'System/Changes' / body['id'] / 'manifest.json').read_bytes())['observed_utc']
                  for body in [first, second]]
        self.assertNotEqual(stamps[0], stamps[1])
        path = self.notes / 'Preferences/Raya.md'
        self.assertIn('No new preference is added.', path.read_text())
        before = self.inventory()
        result = review(self.cfg)
        self.assertEqual(len(result['chain']), 2)
        expected = self.notes / 'System/Capture' / first['id'] / 'input.json'
        self.assertIn(str(expected), [row['path'] for row in result['witnesses']])
        self.assertEqual(self.inventory(), before)
        marker = self.notes / 'System/Capture' / second['id'] / 'render.json'
        raw = marker.read_bytes()
        value = json.loads(raw)
        value['input_sha256'] = '0' * 64
        marker.write_bytes(json.dumps(value).encode())
        with self.assertRaises(AssertionError):
            review(self.cfg)
        marker.write_bytes(raw)
        marker.unlink()
        with self.assertRaises(AssertionError):
            review(self.cfg)
        marker.write_bytes(raw)
        self.assertEqual(review(self.cfg)['effect'], self.anchor)

    def test_current_absent_marker_preserves_legacy_full_fact_rendering(self):
        marker = self.notes / 'System/Capture' / self.body['id'] / 'render.json'
        raw = marker.read_bytes()
        marker.unlink()
        before = self.inventory()
        self.assertEqual(review(self.cfg)['effect'], self.anchor)
        self.assertEqual(self.inventory(), before)
        marker.write_bytes(raw)

    def test_legacy_capture_renderer_reviews_real_duplicate_full_facts_without_git_history(self):
        folder = Path(tempfile.mkdtemp(prefix='raya-revision-legacy-')).resolve()
        try:
            source = folder / 'service'
            shutil.copytree(Path(self.server.__file__).parent, source, ignore=shutil.ignore_patterns('__pycache__'))
            fixtures = Path(__file__).resolve().parents[2] / 'tests/fixtures/memory-90c-predecessor'
            for name, sha in [('capture.py', 'b059c9bb84a176c86e5ff7b7e35b1470cba30fdfec5fb7dcdef4d829298b0dfe'),
                              ('entries.py', '20b59cdc4a4ea3b5124ee81c0950ffbb6429ba05dcd6f0ac8d9d8656c2a13472')]:
                raw = gzip.decompress((fixtures / (name + '.gz')).read_bytes())
                self.assertEqual(hashlib.sha256(raw).hexdigest(), sha)
                (source / name).write_bytes(raw)
            child = subprocess.run([sys.executable, '-B', str(Path(__file__).resolve()), '--prepare', '--source',
                                    str(source), '--count', '2', '--preferences', 'true'],
                                   capture_output=True, timeout=20)
            self.assertEqual(child.returncode, 0, child.stderr.decode())
            prepared = json.loads(child.stdout)
            try:
                cfg = prepared['cfg']
                result = subprocess.run([sys.executable, '-I', '-S', '-B', str(Path(__file__).with_name('capture_revision.py')),
                                         json.dumps(cfg)], capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(len(json.loads(result.stdout)['chain']), 2)
                note = Path(prepared['notes']) / 'Preferences/Raya.md'
                self.assertEqual(note.read_text().count('Original user preference: I prefer warm lights.'), 2)
                self.assertNotIn('No new preference is added.', note.read_text())
            finally:
                disposable = Path(prepared['root']).resolve()
                self.assertEqual(disposable.parent, Path(tempfile.gettempdir()).resolve())
                self.assertTrue(disposable.name.startswith('raya-namespace-test-'))
                shutil.rmtree(disposable)
        finally:
            self.assertEqual(folder.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(folder.name.startswith('raya-revision-legacy-'))
            shutil.rmtree(folder)
    def test_actual_helper_failure_diagnostics_do_not_print_private_input(self):
        helper = Path(__file__).with_name('capture_revision.py')
        result = subprocess.run([sys.executable, '-I', '-S', '-B', str(helper), '{"private-note-secret":'], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b'')
        self.assertRegex(result.stderr.decode(), r'^Historical capture revision refused; stage=main; line=[1-9]\d*; class=Exception\.\r?\n$')
        self.assertNotIn(b'private-note-secret', result.stderr)
        self.assertNotIn(str(helper).encode(), result.stderr)

    def test_diagnostics_expose_only_static_stage_line_and_exception_class(self):
        cfg = copy.deepcopy(self.cfg)
        cfg['pins'] = {'private-path-and-note-secret': 'private-exception-secret'}
        try:
            review(cfg)
        except Exception as err:
            text = diagnostic(err)
        else:
            self.fail('Wrong selected pins must refuse')
        self.assertRegex(text, r'^Historical capture revision refused; stage=review; line=\d+; class=AssertionError\.$')
        self.assertNotIn('private', text)
        self.assertNotIn(str(self.notes), text)
        class Secret(Exception):
            pass
        self.assertEqual(diagnostic(Secret('private-exception-secret')), 'Historical capture revision refused; stage=main; line=0; class=Exception.')

    def setUp(self):
        super().setUp()
        self.anchor = original(self.cfg)
        self.cfg['history'] = {name: self.anchor[name] for name in ['policySHA', 'previousPolicySHA', 'journalSHA']}
        self.cfg['history']['rows'] = []
        self.cfg['history']['operations'] = []
        self.originalpolicy = (self.notes / 'System/general-admission.json').read_bytes()
        self.originalnote = (self.notes / 'Preferences/Raya.md').read_bytes()

    def later(self, label, category='Preferences'):
        from capture import refresh
        from admission import image
        body = copy.deepcopy(self.body)
        body['message'] = label
        body['source']['assistant']['id'] = label
        body['entries'][0]['category'] = category
        raw = json.dumps([body['project'], body['session'], body['message']], separators=(',', ':')).encode()
        body['id'] = str(uuid.UUID(hex=hashlib.sha256(raw).hexdigest()[:32], version=5))
        raw = json.dumps([body['observed_utc'], body['source']['user']['id'], body['source']['user']['text'], body['source']['assistant']['id'], body['source']['assistant']['text'], []], separators=(',', ':')).encode()
        body['source_sha256'] = hashlib.sha256(raw).hexdigest()
        policy = hashlib.sha256(image(self.notes / 'System/general-admission.json')).hexdigest()
        async def publish():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.server.app), base_url='http://127.0.0.1:8874') as client:
                headers = {'Authorization': 'Bearer ' + self.key, 'X-Raya-Memory-Request-ID': uuid.uuid4().hex, 'X-Raya-Memory-Owner-Epoch': self.server.EPOCH}
                response = await client.post('/v1/memory/capture', json=dict(publication=body, expected_policy_sha256=policy), headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
                return response.json()
        result = asyncio.run(publish())
        refresh(self.notes, body['id'], result['input_sha256'], policy, lambda: None)
        row = dict(id=body['id'], project=body['project'], sessionID=body['session'], messageID=body['message'], source_sha256=body['source_sha256'], root=str(self.notes), phase='published', receipt=result['input_sha256'], release=self.server.RELEASE)
        self.cfg['history']['rows'].append(row)
        pending = self.server.JOURNAL.folder / (result['operation']['request'] + '-pending.json')
        terminal = pending.with_name(result['operation']['request'] + '-terminal.json')
        self.cfg['history']['operations'].append(dict(capture=body['id'], root=str(pending.parent.parent), epoch=result['operation']['owner_epoch'], request=result['operation']['request'], bodySHA=result['operation']['request_sha256'], pendingSHA=hashlib.sha256(pending.read_bytes()).hexdigest(), terminalSHA=hashlib.sha256(terminal.read_bytes()).hexdigest()))
        return body, result

    def test_ordinary_and_three_later_accepted_publications_keep_original_effect_exact(self):
        self.assertEqual(review(self.cfg)['effect'], self.anchor)
        for label in ['later-one', 'later-two', 'later-three']:
            self.later(label)
        before = self.inventory()
        value = review(self.cfg)
        self.assertEqual(value['effect'], self.anchor)
        self.assertEqual(len(value['chain']), 3)
        self.assertNotEqual(value['policySHA'], self.anchor['policySHA'])
        self.assertEqual(self.inventory(), before)
        with self.assertRaises(ValueError):
            original(self.cfg)

    def test_later_snapshots_source_request_policy_and_note_drift_are_refused(self):
        body, _ = self.later('later-drift')
        folder = self.notes / 'System/Changes' / body['id']
        files = [folder / name for name in ['manifest.json', 'before-0.md', 'after-0.md', 'source-0.txt']]
        files += [self.notes / 'System/Capture' / body['id'] / name for name in ['input.json', 'request.json']]
        files += [self.notes / 'Preferences/Raya.md', self.notes / 'System/general-admission.json']
        for file in files:
            raw = file.read_bytes()
            file.write_bytes(raw + b'changed')
            with self.assertRaises(Exception):
                review(self.cfg)
            file.write_bytes(raw)
        self.assertEqual(review(self.cfg)['effect'], self.anchor)

    def test_missing_unpublished_and_wrong_receipt_later_rows_are_refused(self):
        self.later('later-ledger')
        for change in [[], [dict(self.cfg['history']['rows'][0], phase='saving')], [dict(self.cfg['history']['rows'][0], receipt='0' * 64)]]:
            cfg = copy.deepcopy(self.cfg)
            cfg['history']['rows'] = change
            with self.assertRaises(AssertionError):
                review(cfg)

    def test_disjoint_scopes_are_ordered_by_original_native_policy_body_hash(self):
        self.later('disjoint-areas', 'Areas')
        self.later('later-preferences')
        before = self.inventory()
        value = review(self.cfg)
        self.assertEqual(value['effect'], self.anchor)
        self.assertEqual(value['chain'], [row['id'] for row in self.cfg['history']['rows']])
        self.assertEqual(self.inventory(), before)
        cfg = copy.deepcopy(self.cfg)
        cfg['history']['rows'].reverse()
        cfg['history']['operations'].reverse()
        self.assertEqual(review(cfg), value)
        for operation in self.cfg['history']['operations']:
            file = self.server.JOURNAL.folder / (operation['request'] + '-pending.json')
            raw = file.read_bytes()
            file.write_bytes(raw + b' ')
            with self.assertRaises(AssertionError):
                review(self.cfg)
            file.write_bytes(raw)
        cfg = copy.deepcopy(self.cfg)
        cfg['history']['operations'][0]['bodySHA'] = '0' * 64
        with self.assertRaises(AssertionError):
            review(cfg)

    def test_unknown_connected_manifest_and_policy_revision_drift_are_refused(self):
        body, _ = self.later('later-unknown')
        folder = self.notes / 'System/Changes' / body['id']
        extra = folder.parent / str(uuid.uuid4())
        extra.mkdir()
        manifest = json.loads((folder / 'manifest.json').read_bytes())
        manifest['id'] = extra.name
        (extra / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaises(Exception):
            review(self.cfg)
        (extra / 'manifest.json').unlink()
        extra.rmdir()
        file = self.notes / 'System/general-admission.json'
        raw = file.read_bytes()
        policy = json.loads(raw)
        policy['revision'] += 1
        from admission import serialize
        file.write_bytes(serialize(policy))
        with self.assertRaises(AssertionError):
            review(self.cfg)
        file.write_bytes(raw)
        self.assertEqual(review(self.cfg)['effect'], self.anchor)

    def test_restoring_original_note_and_policy_cannot_hide_later_published_captures(self):
        self.later('later-before-rollback')
        policy = self.notes / 'System/general-admission.json'
        note = self.notes / 'Preferences/Raya.md'
        rawpolicy, rawnote = policy.read_bytes(), note.read_bytes()
        policy.write_bytes(self.originalpolicy)
        note.write_bytes(self.originalnote)
        self.assertEqual(original(self.cfg), self.anchor)
        with self.assertRaises(AssertionError):
            review(self.cfg)
        policy.write_bytes(rawpolicy)
        note.write_bytes(rawnote)
        self.assertEqual(review(self.cfg)['effect'], self.anchor)

    def test_disjoint_future_publication_cannot_be_hidden_by_original_policy_rollback(self):
        self.later('disjoint-before-rollback', 'Areas')
        policy = self.notes / 'System/general-admission.json'
        raw = policy.read_bytes()
        policy.write_bytes(self.originalpolicy)
        self.assertEqual(original(self.cfg), self.anchor)
        with self.assertRaises(AssertionError):
            review(self.cfg)
        cfg = copy.deepcopy(self.cfg)
        cfg['history']['operations'] = []
        with self.assertRaises(AssertionError):
            review(cfg)
        policy.write_bytes(raw)
        self.assertEqual(review(self.cfg)['effect'], self.anchor)

    def test_unrelated_published_predecessor_without_descendant_namespace_operation_is_allowed(self):
        predecessor = dict(self.cfg['turn'], root=str(self.notes), phase='published', receipt=self.anchor['inputSHA'], release=self.server.RELEASE)
        body, result = self.later('new-anchor', 'Areas')
        self.cfg.update(bodySHA=result['operation']['request_sha256'], resultSHA=result['operation']['result_sha256'], turn=dict(id=body['id'], project=body['project'], sessionID=body['session'], messageID=body['message'], source_sha256=body['source_sha256']))
        anchor = original(self.cfg)
        self.cfg['history'] = {name: anchor[name] for name in ['policySHA', 'previousPolicySHA', 'journalSHA']}
        self.cfg['history'].update(rows=[predecessor], operations=[])
        self.assertEqual(review(self.cfg)['effect'], anchor)
        self.later('after-new-anchor')
        self.assertEqual(review(self.cfg)['effect'], anchor)
        self.assertEqual(len(review(self.cfg)['chain']), 1)

    def test_actual_non_capture_journal_before_anchor_is_not_a_backward_capture_candidate(self):
        from notes import Store
        from admission import Store as Admission
        source = self.notes / 'System/manual-source.txt'
        source.write_bytes(b'Actual explicit non-capture source')
        change = str(uuid.uuid4())
        result = Store(self.notes).apply(dict(id=change, changes=[dict(path='Projects/Manual.md', expected=None, content='# Explicit manual note\n')], sources=[dict(path=str(source), sha256=hashlib.sha256(source.read_bytes()).hexdigest(), kind='document', event_time=None)]))
        self.assertEqual(result['status'], 'committed')
        file = self.notes / 'System/general-admission.json'
        policy = json.loads(file.read_bytes())
        policy['revision'] += 1
        policy['files'].append(dict(relative='Projects/Manual.md', sha256=result['note_sha256']['Projects/Manual.md'], classification='general', review='approved'))
        Admission(self.notes, existing=True).replace(policy, hashlib.sha256(file.read_bytes()).hexdigest())
        predecessor = dict(self.cfg['turn'], root=str(self.notes), phase='published', receipt=self.anchor['inputSHA'], release=self.server.RELEASE)
        body, result = self.later('anchor-after-real-journal', 'Areas')
        self.cfg.update(bodySHA=result['operation']['request_sha256'], resultSHA=result['operation']['result_sha256'], turn=dict(id=body['id'], project=body['project'], sessionID=body['session'], messageID=body['message'], source_sha256=body['source_sha256']))
        anchor = original(self.cfg)
        self.cfg['history'] = {name: anchor[name] for name in ['policySHA', 'previousPolicySHA', 'journalSHA']}
        self.cfg['history'].update(rows=[predecessor], operations=[])
        later, _ = self.later('later-after-real-journal')
        before = self.inventory()
        self.assertEqual(review(self.cfg)['effect'], anchor)
        self.assertEqual(self.inventory(), before)
        self.assertFalse((self.notes / 'System/Capture' / change).exists())
        input = self.notes / 'System/Capture' / later['id'] / 'input.json'
        raw = input.read_bytes()
        input.unlink()
        with self.assertRaises(FileNotFoundError):
            review(self.cfg)
        input.write_bytes(raw)
        self.assertEqual(review(self.cfg)['effect'], anchor)
        cfg = copy.deepcopy(self.cfg)
        cfg['history']['operations'] = []
        with self.assertRaises(AssertionError):
            review(cfg)
        note = self.notes / 'Projects/Manual.md'
        raw = note.read_bytes()
        note.write_bytes(raw + b'Unexplained current drift')
        with self.assertRaises(Exception):
            review(self.cfg)
        note.write_bytes(raw)
        self.assertEqual(review(self.cfg)['effect'], anchor)
        future = Store(self.notes).apply(dict(id=str(uuid.uuid4()), changes=[dict(path='Projects/Manual.md', expected=hashlib.sha256(raw).hexdigest(), content='# Later explicit manual change\n')], sources=[dict(path=str(source), sha256=hashlib.sha256(source.read_bytes()).hexdigest(), kind='document', event_time=None)]))
        policy = json.loads(file.read_bytes())
        policy['revision'] += 1
        for row in policy['files']:
            if row['relative'] == 'Projects/Manual.md':
                row['sha256'] = future['note_sha256']['Projects/Manual.md']
        Admission(self.notes, existing=True).replace(policy, hashlib.sha256(file.read_bytes()).hexdigest())
        with self.assertRaises(AssertionError):
            review(self.cfg)

    def test_same_bytes_policy_replacement_during_review_is_refused(self):
        from policy import Policy
        file = self.notes / 'System/general-admission.json'
        raw = file.read_bytes()
        originalverify = Policy.verify
        replaced = []
        def verify(instance, relative, data):
            value = originalverify(instance, relative, data)
            if not replaced:
                temporary = file.with_name('replacement.json')
                temporary.write_bytes(raw)
                os.replace(temporary, file)
                replaced.append(True)
            return value
        Policy.verify = verify
        try:
            with self.assertRaises(AssertionError):
                review(self.cfg)
            self.assertEqual(file.read_bytes(), raw)
            self.assertEqual(replaced, [True])
        finally:
            Policy.verify = originalverify
        self.assertEqual(review(self.cfg)['effect'], self.anchor)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--append']:
        assert len(sys.argv) == 3
        cfg = json.loads(sys.argv[2])
        from namespace_publication_test import MODULE
        root, notes, namespace = [Path(cfg[name]).resolve(strict=True) for name in ['root', 'notes', 'namespace']]
        assert root.name.startswith('raya-namespace-test-') and notes.is_relative_to(root) and namespace.is_relative_to(root)
        token = root / 'credential.private'
        env = dict(RAYA_MEMORY_PORT='8874', RAYA_MEMORY_ROOT=str(notes), RAYA_MEMORY_TOKEN_FILE=str(token),
                   RAYA_MEMORY_RETRIEVAL_TOKEN_FILE=str(token), RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256='0'*64,
                   RAYA_MEMORY_RETRIEVAL_PROTOCOL='raya.retrieval.request.settlement.v2',
                   RAYA_MEMORY_OPERATION_ROOT=str(namespace), RAYA_MEMORY_OPERATION_SID=cfg['sid'],
                   RAYA_MEMORY_OPERATION_GENERATIONS=json.dumps({name: MODULE.generation(namespace if name == 'root' else namespace/name) for name in ('root', 'Runs', 'Requests')}),
                   RAYA_MEMORY_NOTE_GENERATIONS=json.dumps({name: MODULE.generation(notes if name == 'root' else notes/'System') for name in ('root', 'system')}))
        os.environ.update(env)
        source = Path(cfg['source']).resolve(strict=True)
        sys.path.insert(0, str(source))
        spec = importlib.util.spec_from_file_location('appended_server', source / 'server.py')
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        fixture = Revisions('test_ordinary_and_three_later_accepted_publications_keep_original_effect_exact')
        fixture.root, fixture.notes, fixture.server, fixture.key = root, notes, server, token.read_text()
        fixture.body = json.loads((notes/'System/Capture'/cfg['capture']/'input.json').read_bytes())
        fixture.cfg = dict(history=dict(rows=[], operations=[]))
        count = cfg.get('count', 2)
        assert isinstance(count, int) and 1 <= count <= 64
        try:
            for number in range(count):
                fixture.later('appended-' + uuid.uuid4().hex, 'Areas' if number == 0 else 'Preferences')
            print(json.dumps(fixture.cfg['history']))
        finally:
            server.POOL.shutdown(wait=True)
            server.STORAGE.shutdown(wait=True)
        sys.exit(0)
    if sys.argv[1:2] == ['--prepare']:
        fixture = Revisions('test_ordinary_and_three_later_accepted_publications_keep_original_effect_exact')
        args = sys.argv[2:]
        assert len(args) % 2 == 0
        options = dict(zip(args[::2], args[1::2]))
        assert set(options) <= {'--source', '--count', '--preferences'}
        if '--source' in options:
            fixture.source = Path(options['--source'])
        count = int(options.get('--count', '2'))
        assert 0 <= count <= 64
        fixture.setUp()
        if '--preferences' in options:
            assert options['--preferences'] == 'true'
            fixture.body['entries'][0]['text'] += '\n\nOriginal user preference: ' + fixture.body['source']['user']['text']
        for number in range(count):
            fixture.later('prepared-' + str(number), 'Areas' if number == 0 and '--preferences' not in options else 'Preferences')
        fixture.server.POOL.shutdown(wait=True)
        fixture.server.STORAGE.shutdown(wait=True)
        fixture._cleanups.clear()
        print(json.dumps(dict(cfg=fixture.cfg, anchor=fixture.anchor, root=str(fixture.root), notes=str(fixture.notes), result=fixture.result, operations=str(fixture.server.JOURNAL.folder))))
        sys.exit(0)
    unittest.main()
