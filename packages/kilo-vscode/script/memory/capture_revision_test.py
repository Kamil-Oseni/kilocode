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
import httpx
from capture_recovery_test import Recovery
from capture_recovery import review as original
from capture_revision import review


class Revisions(Recovery):
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
        assert set(options) <= {'--source', '--count'}
        if '--source' in options:
            fixture.source = Path(options['--source'])
        count = int(options.get('--count', '2'))
        assert 0 <= count <= 64
        fixture.setUp()
        for number in range(count):
            fixture.later('prepared-' + str(number), 'Areas' if number == 0 else 'Preferences')
        fixture.server.POOL.shutdown(wait=True)
        fixture.server.STORAGE.shutdown(wait=True)
        fixture._cleanups.clear()
        print(json.dumps(dict(cfg=fixture.cfg, anchor=fixture.anchor, root=str(fixture.root), notes=str(fixture.notes), result=fixture.result, operations=str(fixture.server.JOURNAL.folder))))
        sys.exit(0)
    unittest.main()
