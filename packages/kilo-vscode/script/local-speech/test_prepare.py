"""Exercise real request validation, tombstones and optionally the installed Nano model."""
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
import time
import unittest
import uuid

temp = tempfile.TemporaryDirectory(prefix='raya-speech-prepare-')
os.environ['RAYA_SPEECH_ROOT'] = temp.name
spec = importlib.util.spec_from_file_location('speech_server', Path(__file__).with_name('server.py'))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class Prepare(unittest.TestCase):
    def test_capability(self):
        api = server.Api('/health', 'GET', {'Host': f'127.0.0.1:{server.PORT}', 'Authorization': 'Bearer ' + server.KEY})
        result = api.dispatch()
        self.assertEqual(result.status_code, 200)
        self.assertIn('prepare', json.loads(result.body)['capabilities'])
        self.assertEqual(server.RUNTIME, {})

    def test_selection(self):
        data = server.validate({'kind': 'prepare'})
        self.assertEqual(data['chunks'], [])
        self.assertEqual(data['model'], 'chatterbox-nano')
        self.assertEqual(data['voice'], server.PREFS['voice'])
        for extra in ({'input': 'hello'}, {'audio': 'AA=='}, {'model': 'kokoro'}, {'voice': 'foreign'}, {'allow_fallback': True}):
            with self.assertRaises(server.Fault):
                server.validate({'kind': 'prepare', **extra})

    def test_auth(self):
        api = server.Api('/v1/jobs', 'POST', {'Host': f'127.0.0.1:{server.PORT}'})
        with self.assertRaises(server.Fault) as failure:
            api.authorize()
        self.assertEqual(failure.exception.status, 401)
        api.headers['Authorization'] = 'Bearer ' + server.KEY
        api.authorize()
        api.headers['Origin'] = 'https://example.invalid'
        with self.assertRaises(server.Fault) as failure:
            api.authorize()
        self.assertEqual(failure.exception.status, 403)

    def test_cancel_before_submit(self):
        key = uuid.uuid4().hex
        api = server.Api('/v1/jobs/' + key, 'DELETE', {'Host': f'127.0.0.1:{server.PORT}', 'Authorization': 'Bearer ' + server.KEY})
        result = api.dispatch()
        self.assertEqual(result.status_code, 200)
        with self.assertRaises(server.Fault) as failure:
            server.submit(server.validate({'kind': 'prepare'}), key)
        self.assertEqual(failure.exception.code, 'cancelled')
        self.assertNotIn(key, server.JOBS)
        self.assertNotIn('speech', server.RUNTIME)

    @unittest.skipUnless(os.environ.get('RAYA_SPEECH_REAL_TEST') == '1', 'Explicit real-model slot required')
    def test_real_preparation(self):
        self.assertGreaterEqual(server.psutil.virtual_memory().available, 7 * 1024**3)
        start = time.perf_counter()
        job = server.submit(server.validate({'kind': 'prepare'}), uuid.uuid4().hex)
        deadline = start + 180
        while job['finished'] is None and time.perf_counter() < deadline:
            time.sleep(.02)
        self.assertEqual(job['status'], 'completed', server.view(job))
        self.assertEqual(job['chunks'], [])
        self.assertEqual(job['audio'], [])
        self.assertIsNone(job['text'])
        worker = server.RUNTIME['speech']['process']
        self.assertIsNone(worker.poll())
        prepared = time.perf_counter() - start
        start = time.perf_counter()
        reply = server.submit(server.validate({'kind': 'speech', 'input': "You're welcome!"}), uuid.uuid4().hex)
        first = None
        while reply['finished'] is None and time.perf_counter() < deadline:
            if reply['audio'] and first is None:
                first = time.perf_counter() - start
            time.sleep(.02)
        self.assertEqual(reply['status'], 'completed', server.view(reply))
        if first is None and reply['audio']:
            first = reply['timing']['first_audio_seconds']
        self.assertIsNotNone(first)
        self.assertTrue(reply['audio'][0].startswith(b'RIFF'))
        self.assertIs(server.RUNTIME['speech']['process'], worker)
        self.assertEqual(reply['model'], 'chatterbox-nano')
        self.assertEqual(reply['voice'], server.PREFS['voice'])
        self.assertIsNone(reply['fallback'])
        server.retire()
        self.assertEqual(worker.returncode, 0)
        self.assertNotIn('speech', server.RUNTIME)
        print(json.dumps({'prepareSeconds': prepared, 'firstAudioSeconds': first, 'workerPID': worker.pid, 'workerExitCode': worker.returncode, 'audioPlayed': False, 'microphoneUsed': False}), flush=True)


if __name__ == '__main__':
    try:
        result = unittest.main(exit=False)
    finally:
        server.POOL.shutdown(wait=True, cancel_futures=True)
        server.retire()
        temp.cleanup()
    sys.exit(0 if result.result.wasSuccessful() else 1)
