"""Actual isolated capsule entry construction and ACL namespace; no service/model."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest
import retrieval_reuse_native_test as native
fixture = native.fixture


class Tests(unittest.TestCase):
    cleanup = native.Tests.cleanup
    restore = native.Tests.restore
    retire = native.Tests.retire
    fence = native.Tests.fence

    def setUp(self):
        native.Tests.setUp(self)
        receipts = self.capsule/'receipts'
        receipts.mkdir()
        child = subprocess.Popen([r'C:\Windows\System32\icacls.exe', str(receipts), '/inheritance:r',
                '/grant:r', '*'+self.sid+':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/q'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=0x08000000)
        out, err = child.communicate()
        self.assertEqual(child.returncode, 0, (out+err).decode())
        for name in ('Runs', 'Requests'):
            (receipts/name).mkdir()
        generations = {name: fixture.MODULE.generation(receipts if name == 'root' else receipts/name)
                       for name in ('root', 'Runs', 'Requests')}
        # Compute the independently selected test release before entry import.
        sources = {path.relative_to(self.capsule/'source').as_posix():
                   hashlib.sha256(path.read_bytes()).hexdigest()
                   for folder in ('retrieval', 'retrieval_reuse')
                   for path in (self.capsule/'source'/folder).glob('*.py')}
        catalogs = {'Qwen--Qwen3-Embedding-0.6B.json': '60cae741077a5b3f79f531c139674a1461bda80a5fb8ca767ec1a9ba25975b7d',
                    'Qwen--Qwen3-Reranker-0.6B.json': 'ef8b5bbc099e513ad2ddcd0d20e1ce0006a87e1701228631652d278eecb3f0a3',
                    'google--embeddinggemma-2.json': '7f28a34d9d8e9cc67372be2bc8d1c5ad4e386914e59aa18ae7351e1e95646f54'}
        raw = json.dumps({'source_sha256': sources, 'catalog_sha256': catalogs},
                         sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
        token = self.capsule/'synthetic-token.txt'
        token.write_text('synthetic-entry-token-'+'x'*32, encoding='ascii')
        self.env = {'RAYA_RETRIEVAL_RELEASE_SHA256': hashlib.sha256(raw).hexdigest(),
                    'RAYA_RETRIEVAL_TOKEN_FILE': str(token),
                    'RAYA_RETRIEVAL_RECEIPT_ROOT': str(receipts),
                    'RAYA_RETRIEVAL_RECEIPT_SID': self.sid,
                    'RAYA_RETRIEVAL_RECEIPT_GENERATIONS': json.dumps(generations)}
        self.probe = self.capsule/'probe.py'
        self.probe.write_text('''import json,sys
from pathlib import Path
root=Path(__file__).parent
sys.path[:0]=[str(root/'source'/'retrieval_reuse'),str(root/'source'/'retrieval')]
from entry import build
try:
    runtime=build(json.loads(sys.argv[1]))
except ValueError as err:
    print(json.dumps({'error':str(err)}))
else:
    print(json.dumps({'ready':runtime.health()['ready'],'source_count':len(runtime.sources),
                      'models':list(runtime.pool.revisions),'closure':runtime.close()}))
''', encoding='utf-8')

    def runentry(self, env):
        child = subprocess.Popen([str(self.capsule/'python'/'python.exe'), '-I', '-S', '-B',
                                  str(self.probe), json.dumps(env)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 creationflags=0x08000000)
        out, err = child.communicate()
        self.assertEqual(child.returncode, 0, err.decode())
        self.assertEqual(err, b'')
        return json.loads(out)

    def test_actual_selected_capsule_builds_without_starting_inference(self):
        value = self.runentry(self.env)
        self.assertFalse(value['ready'])
        self.assertEqual(value['source_count'], 16)
        self.assertEqual(set(value['models']), {'qwen3-embedding-0.6b', 'qwen3-reranker-0.6b', 'embeddinggemma-2'})
        self.assertTrue(value['closure']['closed'])
        self.assertFalse(value['closure']['ownership_retained'])
        self.assertTrue(value['closure']['request_admissions_joined'])

    def test_stale_release_and_foreign_token_refused_before_scheduler(self):
        self.assertEqual(self.runentry(dict(self.env, RAYA_RETRIEVAL_RELEASE_SHA256='f'*64)),
                         {'error': 'reuse_selected_release_differs'})
        self.assertEqual(self.runentry(dict(self.env, RAYA_RETRIEVAL_TOKEN_FILE=str(self.root/'foreign-token'))),
                         {'error': 'reuse_private_input_path'})

    def test_input_bounds_and_prior_journal_are_not_silently_adopted(self):
        self.assertEqual(self.runentry(dict(self.env, RAYA_RETRIEVAL_MIN_RAM_GIB='2')),
                         {'error': 'reuse_bounded_port_or_reserve'})
        token = Path(self.env['RAYA_RETRIEVAL_TOKEN_FILE'])
        token.write_bytes(b'x'*1025)
        self.assertEqual(self.runentry(self.env), {'error': 'reuse_token_bound'})
        token.write_text('synthetic-entry-token-'+'x'*32, encoding='ascii')
        (Path(self.env['RAYA_RETRIEVAL_RECEIPT_ROOT'])/'Requests'/'prior.json').write_text('{}', encoding='utf-8')
        self.assertEqual(self.runentry(self.env), {'error': 'reuse_runtime_prior_receipts'})


if __name__ == '__main__':
    unittest.main()
