"""Exercise actual source-bound evidence decisions with temporary media files."""
import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, sys.argv[1])
from library import Library, MODEL, REVISION, DIMENSIONS
from verification import review
from evaluator import Evaluator


class Verification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='raya-media-verification-')
        self.root = Path(self.temp.name)
        (self.root / 'selected').mkdir()
        self.library = Library(self.root / 'selected')
        self.source = self.root / 'image.png'
        self.source.write_bytes(b'\x89PNG\r\n\x1a\nselected-bytes')
        self.item = self.library.add(self.source, 'Selected attachment')
        vector = [1.0] + [0.0] * (DIMENSIONS - 1)
        space = dict(model=MODEL, revision=REVISION, dimensions=DIMENSIONS)
        self.library.publish([dict(id=self.item['id'], sha256=self.item['sha256'], vector=vector)], space)
        self.rows = self.library.search(vector, space)
        self.query = 'A red circle'

    def tearDown(self):
        self.temp.cleanup()

    def decision(self, request, raw, status='supported'):
        self.assertEqual(hashlib.sha256(raw).hexdigest(), request['source_sha256'])
        self.assertEqual(request['query'], self.query)
        return dict({key: request[key] for key in ('format', 'query_sha256', 'id', 'source_sha256', 'start', 'end')},
                    status=status, evidence='Selected observation', model='recorded-verifier-test')

    def test_supported_and_rejected_are_separate(self):
        result = review(self.library, self.query, self.rows, self.decision)
        self.assertEqual(result['matches'][0]['verification'], 'supported')
        result = review(self.library, self.query, self.rows, lambda request, raw: self.decision(request, raw, 'rejected'))
        self.assertEqual(result['matches'], [])
        self.assertEqual(len(result['rejected']), 1)

    def test_uncertain_never_enters_context(self):
        result = review(self.library, self.query, self.rows, lambda request, raw: self.decision(request, raw, 'uncertain'))
        self.assertEqual(result['matches'], [])
        self.assertEqual(len(result['uncertain']), 1)

    def test_unavailable_is_uncertain(self):
        def unavailable(request, raw):
            raise TimeoutError('Unavailable')
        result = review(self.library, self.query, self.rows, unavailable)
        self.assertEqual(result['matches'], [])
        self.assertEqual(result['uncertain'][0]['verification'], 'uncertain')

    def test_replayed_query_is_refused(self):
        def replay(request, raw):
            return dict(self.decision(request, raw), query_sha256='0' * 64)
        with self.assertRaisesRegex(ValueError, 'different query'):
            review(self.library, self.query, self.rows, replay)

    def test_filename_or_score_cannot_authorize_a_match(self):
        def unsupported(request, raw):
            return dict(self.decision(request, raw), evidence='')
        with self.assertRaisesRegex(ValueError, 'observation'):
            review(self.library, self.query, self.rows, unsupported)

    def test_changed_source_during_verification_is_refused(self):
        def changed(request, raw):
            verdict = self.decision(request, raw)
            (self.library.root / self.item['relative']).write_bytes(b'\x89PNG\r\n\x1a\nchanged')
            return verdict
        with self.assertRaises(ValueError):
            review(self.library, self.query, self.rows, changed)

    def test_forgotten_source_during_verification_is_refused(self):
        def forgotten(request, raw):
            verdict = self.decision(request, raw)
            self.library.forget(self.item['id'])
            return verdict
        with self.assertRaisesRegex(ValueError, 'forgotten'):
            review(self.library, self.query, self.rows, forgotten)

    def test_wrong_span_and_duplicate_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'timestamp'):
            review(self.library, self.query, [dict(self.rows[0], start=0, end=1)], self.decision)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            review(self.library, self.query, self.rows * 2, self.decision)

    def test_ambiguous_verifier_json_is_refused(self):
        request = dict(format='raya.media.verify.v1', query=self.query,
                       query_sha256='0' * 64, id=self.item['id'], source_sha256=self.item['sha256'],
                       kind='audio', start=0, end=1)
        evaluator = Evaluator('recorded-verifier-test',
                              lambda payload: '{"status":"rejected","status":"supported","evidence":"red circle"}',
                              lambda request, raw: 'The speaker describes a red circle.')
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b'\x00\x00' * 16000)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            evaluator(request, output.getvalue())

    def test_transcription_receives_only_the_selected_recording_span(self):
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b'\x64\x00' * 16000 + b'\xc8\x00' * 16000)
        raw = output.getvalue()
        request = dict(format='raya.media.verify.v1', query='selected second',
                       query_sha256='0' * 64, id='recording', source_sha256=hashlib.sha256(raw).hexdigest(),
                       kind='audio', start=1, end=2)
        def transcribe(selected, clip):
            self.assertEqual(selected['source_sha256'], request['source_sha256'])
            self.assertEqual(selected['evidence_sha256'], hashlib.sha256(clip).hexdigest())
            with wave.open(io.BytesIO(clip), 'rb') as audio:
                self.assertEqual(audio.getnframes(), 16000)
                self.assertEqual(audio.readframes(16000), b'\xc8\x00' * 16000)
            return 'Selected second only.'
        evaluator = Evaluator('recorded-verifier-test',
                              lambda payload: dict(status='supported', evidence=payload['transcript']), transcribe)
        self.assertEqual(evaluator(request, raw)['status'], 'supported')


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], verbosity=2)
