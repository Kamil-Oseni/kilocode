"""Actual codec/state tests; no models, service, native admission or device actions."""
import io
from pathlib import Path
import struct
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent / 'retrieval'))
sys.path.insert(0, str(Path(__file__).parent / 'retrieval_reuse'))
from lease import Lease, INPUT, read, write
from validation import fingerprint


def frame(sequence=1, request='3' * 32):
    body = {'model': 'embeddinggemma-2', 'input': ['Eden launch 🌈'], 'input_type': 'document'}
    return {'format': 'raya.retrieval.lease.request', 'version': 2, 'lease': '1' * 32,
            'owner_epoch': '2' * 32, 'selected_release_sha256': 'a' * 64,
            'sequence': sequence, 'request': request, 'request_sha256': fingerprint(body),
            'kind': 'embeddings', 'body': body}


def lease(limit=32):
    return Lease('1' * 32, '2' * 32, 'a' * 64, 'embeddings', 'embeddinggemma-2', limit)


class Tests(unittest.TestCase):
    def test_roundtrip_and_sequential_frames(self):
        stream = io.BytesIO()
        write(stream, frame())
        write(stream, frame(2, '4' * 32))
        stream.seek(0)
        self.assertEqual(read(stream), frame())
        self.assertEqual(read(stream), frame(2, '4' * 32))
        self.assertIsNone(read(stream))

    def test_refuses_incomplete_oversized_and_ambiguous_frames(self):
        for raw in (b'\x00', struct.pack('!I', INPUT + 1), struct.pack('!I', 0),
                    struct.pack('!I', 10) + b'{}', struct.pack('!I', 13) + b'{"a":1,"a":2}',
                    struct.pack('!I', 9) + b'{"x":NaN}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                read(io.BytesIO(raw))
        with self.assertRaises(ValueError):
            write(io.BytesIO(), {'text': 'x' * (INPUT + 1)}, INPUT)

    def test_binds_exact_selection_and_body_before_admission(self):
        changes = {'version': True, 'lease': '0' * 32, 'owner_epoch': '0' * 32,
                   'selected_release_sha256': 'b' * 64, 'sequence': True,
                   'request_sha256': '0' * 64, 'kind': 'rerank', 'extra': 'refused'}
        for key, value in changes.items():
            with self.subTest(key=key), self.assertRaises(ValueError):
                lease().request({**frame(), key: value})
        changed = frame()
        changed['body'] = {**changed['body'], 'model': 'qwen3-embedding-0.6b'}
        changed['request_sha256'] = fingerprint(changed['body'])
        with self.assertRaises(ValueError):
            lease().request(changed)

    def test_one_request_at_a_time_and_identity_snapshot(self):
        owner = lease()
        request = frame()
        self.assertEqual(owner.request(request), request['body'])
        with self.assertRaises(ValueError):
            owner.request(frame(2, '4' * 32))
        request['owner_epoch'] = '9' * 32
        reply = owner.completion({'fixture': True})
        self.assertEqual(reply['owner_epoch'], '2' * 32)
        self.assertNotIn('joins_observed', reply)
        self.assertNotIn('cleanup_outcome', reply)
        with self.assertRaises(ValueError):
            owner.completion({})
        with self.assertRaises(ValueError):
            owner.request(frame(2))
        self.assertEqual(owner.request(frame(2, '4' * 32)), frame()['body'])

    def test_capacity_and_sequence_replay(self):
        owner = lease(2)
        for sequence in (1, 2):
            owner.request(frame(sequence, str(sequence + 2) * 32))
            owner.completion({})
        with self.assertRaises(ValueError):
            owner.request(frame(3, '5' * 32))
        for limit in (0, 33, True):
            with self.assertRaises(ValueError):
                lease(limit)
        with self.assertRaises(ValueError):
            lease().request(frame(2))


if __name__ == '__main__':
    unittest.main()
