"""Real pinned tokenizer and personal-size note reconstruction; no model or live notes."""
import hashlib
import json
import shutil
import sys
import threading
import time
import unittest
import index_http_test as support


class Tokenizer(support.HTTP):
    def test_recall_reconstruction_reuses_one_pinned_counter(self):
        target = self.notes / 'Preferences/Raya.md'
        target.parent.mkdir()
        text = '# Build preferences\n' + ('Prefer precise build delivery with relevant tests and clear evidence.\n' * 100)
        target.write_text(text, encoding='utf-8')
        sha = hashlib.sha256(target.read_bytes()).hexdigest()
        self.policy(files=[dict(relative='Preferences/Raya.md', sha256=sha, classification='general', review='approved')])
        module = sys.modules['index']
        calls = []
        def profile(frame, event, arg):
            if event == 'call' and frame.f_code is module.measure.__code__:
                calls.append(event)
        started = time.monotonic()
        sys.setprofile(profile)
        try:
            with module.operation(), self.server.INDEX.store.lease() as lease:
                token = module.LEASE.set(lease)
                try:
                    count = module.measure()
                    snapshot = module.scan(self.notes, lease.policy)
                    chunks = module.split('Preferences/Raya.md', snapshot['Preferences/Raya.md'], count)
                    rows = [tuple(row[key] for key in ('path', 'start', 'end', 'heading', 'text', 'filehash')) for row in chunks]
                    self.server.INDEX.rows(rows, snapshot, count)
                    self.server.INDEX.rows(rows, snapshot, count)
                    result = module.retrieve(self.notes, lease.policy,
                        [dict(relative='Preferences/Raya.md', sha256=sha)], 'build delivery testing', 3000, count, module.remaining)
                    self.assertTrue(result['sources'])
                    self.assertEqual(result['sources'][0]['source_sha256'], sha)
                    self.assertGreater(len(chunks), 1)
                finally:
                    module.LEASE.reset(token)
        finally:
            sys.setprofile(None)
        self.assertEqual(len(calls), 1)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), sha)
        self.assertFalse(self.server.INDEX.db.exists())
        self.assertFalse(any(name in sys.modules for name in ('torch', 'transformers', 'scipy', 'sklearn')))

    def test_retained_counter_refuses_changed_identity_pin_and_cancellation(self):
        module = sys.modules['index']
        model = dict(module.MODEL, path=str(self.root / 'tokenizer'))
        folder = self.root / 'tokenizer'
        folder.mkdir()
        file = folder / 'tokenizer.json'
        shutil.copyfile(module.Path(module.MODEL['path']) / 'tokenizer.json', file)
        with module.operation():
            count = module.measure(model)
            self.assertGreater(count('precise build testing'), 0)
            with file.open('ab') as held:
                held.write(b' ')
            with self.assertRaisesRegex(module.Refused, 'identity changed'):
                count('precise build testing')
            with self.assertRaisesRegex(module.Refused, 'bytes or identity changed'):
                module.measure(model)
        cancel = threading.Event()
        with module.operation(cancel=cancel):
            count = module.measure()
            cancel.set()
            with self.assertRaises(module.Cancelled):
                count('precise build testing')


if __name__ == '__main__':
    unittest.main()
