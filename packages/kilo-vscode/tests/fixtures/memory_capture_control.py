"""Actual isolated private bridge and original capture journal, without models."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_capture_policy as support


class Tests(support.Tests):
    def bridge(self, capture=True):
        source = Path(__file__).resolve().parents[2] / 'script/memory/service'
        names = ['server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py', 'host.py',
                 'operations.py', 'retirement.py', 'namespace.py', 'dispatch.py', 'historical.py', 'proposals.py']
        if capture:
            names.append('capture.py')
        cfg = self.root / 'control.json'
        cfg.write_text(json.dumps(dict(format='raya.memory.control.setup', version=2, root=str(self.root),
            source_dir=str(source), source_sha256={name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in names})), encoding='utf-8')
        child = subprocess.Popen([sys.executable, '-I', '-S', '-B', str(source.parent / 'control.py'), '--config', str(cfg)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.close, child)
        return child

    def close(self, child):
        child.stdin.close()
        output = child.stdout.read()
        error = child.stderr.read()
        self.assertEqual(child.wait(timeout=10), 0, error.decode())
        self.assertEqual(output, b'')
        self.assertEqual(error, b'')
        child.stdout.close()
        child.stderr.close()

    def call(self, child, seq, op, args):
        child.stdin.write((json.dumps(dict(format='raya.memory.control.request', version=1, seq=seq, op=op, args=args)) + '\n').encode())
        child.stdin.flush()
        raw = child.stdout.readline()
        row = json.loads(raw)
        print(json.dumps(dict(root=str(self.root), op=op, seq=seq, raw=raw.decode(), ok=row['ok'])))
        self.assertEqual(row['seq'], seq)
        return row

    def test_original_bridge_preflight_publication_admission(self):
        body = self.structured()
        sha = self.policy()
        child = self.bridge()
        prior = self.call(child, 1, 'capture_authorize', dict(publication=body, expected_policy_sha256=sha))
        self.assertTrue(prior['ok'], prior)
        self.assertEqual(prior['result']['root'], str(self.root))
        self.assertEqual(prior['result']['expected_policy_sha256'], sha)
        self.assertEqual(set(prior['result']['namespace']), {'root', 'system'})
        effect = support.publish(self.root, body)
        args = dict(id=body['id'], input_sha256=effect['input_sha256'], expected_policy_sha256=sha)
        saved = self.call(child, 2, 'capture_admit', args)
        self.assertTrue(saved['ok'], saved)
        self.assertEqual(saved['result']['capture'], body['id'])
        self.assertTrue(saved['result']['source_policy_refreshed'])
        self.assertEqual(saved['result']['revision'], 2)
        duplicate = self.call(child, 3, 'capture_admit', args)
        self.assertFalse(duplicate['ok'])
        self.assertEqual(duplicate['error']['publication'], 'may_have_happened')

    def test_legacy_bridge_refuses_capture_without_policy_effect(self):
        body = self.structured()
        sha = self.policy()
        child = self.bridge(capture=False)
        refused = self.call(child, 1, 'capture_authorize', dict(publication=body, expected_policy_sha256=sha))
        self.assertFalse(refused['ok'])
        self.assertEqual(refused['error']['publication'], 'none')
        self.assertEqual(hashlib.sha256(support.Admission(self.root, existing=True).file.read_bytes()).hexdigest(), sha)

    def test_policy_change_after_preflight_refuses_before_note_writes(self):
        body = self.structured()
        sha = self.policy()
        def observe(stage):
            if stage == 'captured':
                self.policy(enabled=False)
        with self.assertRaisesRegex(ValueError, 'disabled|policy changed'):
            support.publish(self.root, body, expected=sha, observe=observe)
        self.assertFalse((self.root / 'Areas/Raya.md').exists())
        self.assertEqual(support.Store(self.root).state(body['id'])['status'], 'preparing')


if __name__ == '__main__':
    unittest.main()
