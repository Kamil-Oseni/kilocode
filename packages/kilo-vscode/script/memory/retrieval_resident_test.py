"""Real pre-inference refusal paths; model residency needs the checkpoint test."""
import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent / 'retrieval'))
sys.path.insert(0, str(Path(__file__).parent / 'retrieval_reuse'))
from lease import Lease, write
from resident import Resident, run
from validation import fingerprint


def lease():
    return Lease('1' * 32, '2' * 32, 'a' * 64, 'embeddings', 'embeddinggemma-2')


class Tests(unittest.TestCase):
    def test_empty_input_never_loads_a_model(self):
        model = Resident('embeddings', 'embeddinggemma-2')
        run(io.BytesIO(), io.BytesIO(), lease(), model)
        self.assertIsNone(model.model)

    def test_selection_mismatch_before_read_or_load(self):
        model = Resident('embeddings', 'qwen3-embedding-0.6b')
        with self.assertRaisesRegex(ValueError, 'resident_lease_selection'):
            run(io.BytesIO(), io.BytesIO(), lease(), model)
        self.assertIsNone(model.model)
        for kind, name in [('unknown', 'embeddinggemma-2'), ('rerank', 'embeddinggemma-2')]:
            with self.assertRaisesRegex(ValueError, 'resident_selection'):
                Resident(kind, name)

    def test_input_refusals_before_model_import(self):
        model = Resident('embeddings', 'embeddinggemma-2')
        valid = {'model': 'embeddinggemma-2', 'input': ['hello']}
        for body in [None, {**valid, 'extra': True}, {**valid, 'model': 'qwen3-embedding-0.6b'},
                     {**valid, 'input': []}, {**valid, 'input': [' ']}, {**valid, 'input': ['a'] * 33},
                     {**valid, 'input': ['a' * 8001]}, {**valid, 'input_type': 'other'}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                model.infer(body)
        self.assertIsNone(model.model)
        self.assertNotIn('models', sys.modules)

    def test_framed_invalid_input_produces_no_completion(self):
        body = {'model': 'embeddinggemma-2', 'input': []}
        frame = {'format': 'raya.retrieval.lease.request', 'version': 2, 'lease': '1' * 32,
                 'owner_epoch': '2' * 32, 'selected_release_sha256': 'a' * 64,
                 'sequence': 1, 'request': '3' * 32, 'request_sha256': fingerprint(body),
                 'kind': 'embeddings', 'body': body}
        source = io.BytesIO()
        write(source, frame)
        source.seek(0)
        sink = io.BytesIO()
        model = Resident('embeddings', 'embeddinggemma-2')
        with self.assertRaisesRegex(ValueError, 'resident_input_bound'):
            run(source, sink, lease(), model)
        self.assertEqual(sink.getvalue(), b'')
        self.assertIsNone(model.model)

    def test_rerank_refuses_invalid_query_and_top_before_load(self):
        model = Resident('rerank', 'qwen3-reranker-0.6b')
        valid = {'model': model.name, 'documents': ['hello'], 'query': 'hello'}
        for body in [{**valid, 'query': ''}, {**valid, 'query': 'a' * 2001},
                     {**valid, 'top_n': True}, {**valid, 'top_n': 0}, {**valid, 'top_n': 2}]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                model.infer(body)
        self.assertIsNone(model.model)


if __name__ == '__main__':
    unittest.main()
