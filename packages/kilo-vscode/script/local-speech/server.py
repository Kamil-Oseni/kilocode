"""Loopback speech adapter. No assistant, tools, persistent memory or GPU inference."""
import base64
import psutil
import sys
import asyncio
import binascii
import io
import hashlib
import json
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
from fastapi import FastAPI, Request
from starlette.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HOME'] = r'D:\Raya\Models\Cache\chatterbox-nano'
os.environ['TORCH_HOME'] = r'D:\Raya\Models\Cache\torch'
SOURCE_ROOT = Path(__file__).parent
ROOT = Path(os.environ.get('RAYA_SPEECH_ROOT', str(SOURCE_ROOT))).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
CATALOG = Path(os.environ.get('RAYA_SPEECH_CATALOG', r'D:\Raya\Models\Catalog'))
PORT = int(os.environ.get('RAYA_SPEECH_PORT', '8770'))
TOKEN = ROOT / 'access-token.txt'
if not TOKEN.exists():
    with TOKEN.open('x', encoding='utf-8') as file:
        file.write(secrets.token_urlsafe(32))
KEY = TOKEN.read_text(encoding='utf-8').strip()
PREFS = json.loads((CATALOG / 'speech-preferences.json').read_text(encoding='utf-8-sig'))
MODELS = {
    'whisper-small.en': json.loads((CATALOG / 'Systran--faster-whisper-small.en.json').read_text(encoding='utf-8-sig')),
    'chatterbox-nano': json.loads((CATALOG / 'ResembleAI--chatterbox-nano.json').read_text(encoding='utf-8-sig')),
    'kokoro': json.loads((CATALOG / 'hexgrad--Kokoro-82M.json').read_text(encoding='utf-8-sig')),
}
MIMES = {'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'}
GUARD = threading.RLock()
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='speech')
SLOTS = threading.BoundedSemaphore(4)
JOBS = {}
TOMBS = {}
DRAIN = {'id': None, 'until': 0}
RUNTIME = {}
IDLE = max(5, int(os.environ.get('RAYA_SPEECH_IDLE_SECONDS', '120')))
EXPIRE = max(5, int(os.environ.get('RAYA_SPEECH_QUEUE_SECONDS', '60')))
LAST = {'used': time.monotonic()}
STOP = threading.Event()
SOURCE = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
WORKERS = {name: hashlib.sha256((SOURCE_ROOT / name).read_bytes()).hexdigest() for name in ('nano-worker.py', 'kokoro-worker.py')}


def prune():
    with GUARD:
        now = time.monotonic()
        for key in list(TOMBS):
            if now - TOMBS[key] > 600:
                del TOMBS[key]
        for key in list(JOBS):
            job = JOBS[key]
            if job['finished'] is not None and now - job['finished'] > 600:
                del JOBS[key]


def maintain():
    while not STOP.wait(min(15, IDLE)):
        prune()
        with GUARD:
            if RUNTIME.get('speech') and all(job['finished'] is not None for job in JOBS.values()) and time.monotonic() - LAST['used'] >= IDLE:
                try:
                    retire()
                except Exception as err:
                    print(json.dumps({'idle_retirement_error': type(err).__name__}), flush=True)


class Fault(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.status = code, status
        super().__init__(message)


class WorkspaceTemp(tempfile.TemporaryDirectory):
    def cleanup(self):
        # Windows can briefly retain inherited stdio handles after child exit.
        for attempt in range(50):
            try:
                return super().cleanup()
            except PermissionError:
                if attempt == 49:
                    raise
                time.sleep(0.1)


def chunks(text):
    # Bounded sentences; no fabricated math conversions or emotional annotations.
    text = re.sub(r'\[([^\]]*)\]', lambda match: match[0] if match[1] in {'chuckle', 'laugh', 'sigh'} else '', text)
    words = re.split(r'(?<=[.!?])\s+|\n+', text.strip())
    result = []
    for sentence in words:
        terms = sentence.split()
        part = []
        size = 0
        for term in terms:
            if len(term) > 100:
                raise Fault('invalid_text', 'Individual words must not exceed 100 characters.')
            if part and (len(part) == 45 or size + len(term) > 400):
                result.append(' '.join(part))
                part, size = [], 0
            part.append(term)
            size += len(term) + 1
        if part:
            result.append(' '.join(part))
    return result


def validate(data):
    if not isinstance(data, dict):
        raise Fault('invalid_request', 'Expected a JSON object.')
    kind = data.get('kind')
    if kind == 'prepare':
        if data.get('model', 'chatterbox-nano') != 'chatterbox-nano':
            raise Fault('unsupported_model', 'Preparation requires chatterbox-nano.', 422)
        if data.get('voice', PREFS['voice']) != PREFS['voice']:
            raise Fault('unsupported_voice', 'Use the catalog voice.', 422)
        if set(data) - {'kind', 'model', 'voice'}:
            raise Fault('invalid_request', 'Preparation does not accept text or audio.')
        return {'kind': kind, 'model': 'chatterbox-nano', 'voice': PREFS['voice'], 'chunks': []}
    if kind == 'speech':
        model = data.get('model', 'chatterbox-nano')
        if model not in {'chatterbox-nano', 'kokoro'}:
            raise Fault('unsupported_model', 'Use chatterbox-nano or kokoro.', 422)
        voice = PREFS['voice'] if model == 'chatterbox-nano' else 'am_onyx'
        if data.get('voice', voice) != voice:
            raise Fault('unsupported_voice', 'Use the catalog voice for the selected model.', 422)
        if 'allow_fallback' in data and not isinstance(data['allow_fallback'], bool):
            raise Fault('invalid_request', 'allow_fallback must be boolean.')
        text = data.get('input')
        if not isinstance(text, str) or not 0 < len(text.strip()) <= 4000:
            raise Fault('invalid_text', 'Input must contain 1–4000 characters.')
        parts = chunks(text)
        if not parts:
            raise Fault('invalid_text', 'Input must contain speakable text.')
        if model == 'kokoro':
            parts = [re.sub(r'\[[^\]]*\]', '', part).strip() for part in parts]
            parts = [part for part in parts if part]
            if not parts:
                raise Fault('invalid_text', 'Kokoro requires words, not vocal tags alone.')
        return {'kind': kind, 'model': model, 'voice': voice, 'input': text, 'chunks': parts, 'allow_fallback': data.get('allow_fallback', False)}
    if kind == 'transcription':
        if data.get('model', 'whisper-small.en') != 'whisper-small.en':
            raise Fault('unsupported_model', 'Use whisper-small.en.', 422)
        if data.get('mime') not in MIMES:
            raise Fault('unsupported_audio', 'Unsupported audio MIME type.', 415)
        if not isinstance(data.get('audio'), str):
            raise Fault('invalid_audio', 'Provide base64 audio.')
        try:
            audio = base64.b64decode(data['audio'], validate=True)
        except (ValueError, binascii.Error) as err:
            raise Fault('invalid_audio', 'Audio must be valid base64.') from err
        if not 0 < len(audio) <= 12000000:
            raise Fault('invalid_audio', 'Audio must contain 1 byte–12 MB.', 413)
        return {'kind': kind, 'audio': audio}
    raise Fault('invalid_kind', 'Use speech or transcription.')


def retire():
    worker = RUNTIME.get('speech')
    if worker is None:
        return
    child = worker['process']
    worker['retiring'] = True
    try:
        child.stdin.close()
    except BrokenPipeError:
        print('Retired speech worker pipe was already closed.', flush=True)
    if child.poll() is None:
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            print(json.dumps({'speech_worker_forced_retirement': child.pid}), flush=True)
            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True, check=True)
    child.wait(timeout=10)
    RUNTIME.pop('speech', None)
    worker['log'].close()


def load(kind):
    LAST['used'] = time.monotonic()
    if kind in RUNTIME:
        if kind == 'speech' and RUNTIME[kind].get('retiring'):
            raise Fault('worker_retiring', 'The previous speech worker is still retiring; retry after it exits.', 503)
        return RUNTIME[kind]
    if psutil.virtual_memory().available < 4 * 1024**3:
        raise Fault('memory_pressure', 'Not enough available RAM to load speech; retry after background work finishes.', 503)
    if kind == 'transcription':
        from faster_whisper import WhisperModel
        model = WhisperModel(MODELS['whisper-small.en']['path'], device='cpu', compute_type='int8', cpu_threads=6, num_workers=1)
    else:
        log = (ROOT / 'nano-worker.log').open('ab')
        try:
            child = subprocess.Popen(
                [getattr(sys, '_base_executable', sys.executable), '-c',
                 "import json,runpy,sys; sys.path=json.loads(sys.argv[1]); runpy.run_path(sys.argv[2],run_name='__main__')",
                 json.dumps(sys.path), str(SOURCE_ROOT / 'nano-worker.py')],
                stdin=subprocess.PIPE, stdout=log, stderr=log,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception:
            log.close()
            raise
        model = {'process': child, 'log': log}
    with GUARD:
        RUNTIME[kind] = model
    return model


def nano(job, parts):
    folder = ROOT / 'temp'
    folder.mkdir(exist_ok=True)
    with WorkspaceTemp(prefix='nano-', dir=folder) as name:
        path = Path(name)
        worker = load('speech')
        child = worker['process']
        complete = False
        try:
            child.stdin.write((json.dumps({'path': str(path), 'chunks': parts}) + '\n').encode())
            child.stdin.flush()
            deadline = time.monotonic() + 180
            for index in range(len(parts) + 1):
                file = path / (f'{index}.json' if index < len(parts) else 'done.json')
                while not file.exists():
                    if job['cancel'].wait(.1):
                        return
                    if (path / 'error.json').exists():
                        raise Fault('inference_failed', json.loads((path / 'error.json').read_text())['message'], 500)
                    if child.poll() is not None:
                        raise Fault('inference_failed', 'Speech worker exited before completion.', 500)
                    if time.monotonic() > deadline:
                        raise Fault('inference_timeout', 'Speech worker timed out.', 504)
                if index < len(parts):
                    meta = json.loads(file.read_text())
                    yield (path / f'{index}.wav').read_bytes(), meta['seconds']
            complete = True
        finally:
            LAST['used'] = time.monotonic()
            if not complete:
                retire()


def view(job):
    # A snapshot prevents inference/cancellation from mutating a response during I/O.
    return json.loads(json.dumps({key: job[key] for key in ('id', 'kind', 'model', 'voice', 'fallback', 'status', 'chunks', 'text', 'error', 'timing')}))


def fallback(job, parts):
    if not parts:
        raise Fault('invalid_text', 'Kokoro fallback requires speakable words.', 422)
    folder = ROOT / 'temp'
    folder.mkdir(exist_ok=True)
    temp = WorkspaceTemp(prefix='kokoro-', dir=folder)
    assert Path(temp.name).resolve().parent == folder.resolve()
    with temp as name:
        path = Path(name)
        with (path / 'worker.log').open('wb') as log:
            child = subprocess.Popen(['D:\\Raya\\Services\\Packaging\\Environments\\KokoroSnapshot\\Scripts\\python.exe', str(SOURCE_ROOT / 'kokoro-worker.py'), str(path)], stdin=subprocess.PIPE, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                child.stdin.write(json.dumps({'chunks': parts}).encode())
                child.stdin.close()
                deadline = time.monotonic() + 180
                for index in range(len(parts)):
                    while not (path / f'{index}.json').exists():
                        if job['cancel'].wait(0.1):
                            return
                        if (path / 'error.json').exists():
                            raise Fault('fallback_failed', json.loads((path / 'error.json').read_text())['message'], 500)
                        if child.poll() is not None:
                            raise Fault('fallback_failed', 'Kokoro worker exited before producing its result.', 500)
                        if time.monotonic() > deadline:
                            raise Fault('fallback_timeout', 'Kokoro worker timed out.', 504)
                    meta = json.loads((path / f'{index}.json').read_text())
                    yield (path / f'{index}.wav').read_bytes(), meta['seconds']
            finally:
                if child.poll() is None and job['cancel'].is_set():
                    child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=10)


def synthesize(job, data):
    if data['model'] == 'kokoro':
        yield from fallback(job, data['chunks'])
        return
    try:
        yield from nano(job, data['chunks'])
    except Exception:
        # Do not mix two voices mid-response or fall back after cancellation.
        if not data['allow_fallback'] or job['chunks'] or job['cancel'].is_set():
            raise
        with GUARD:
            job['model'], job['voice'] = 'kokoro', 'am_onyx'
            job['fallback'] = {'from': 'chatterbox-nano', 'reason': 'primary_synthesis_failed'}
        parts = [re.sub(r'\[[^\]]*\]', '', text).strip() for text in data['chunks']]
        yield from fallback(job, [text for text in parts if text])


def run(job, data):
    start = time.perf_counter()
    try:
        with GUARD:
            if job['cancel'].is_set():
                return
            if time.perf_counter() - job['created'] >= EXPIRE:
                raise Fault('queue_expired', 'Speech request expired while waiting; start a fresh request.', 503)
            job['status'] = 'running'
        if data['kind'] == 'prepare':
            if 'speech' not in RUNTIME and psutil.virtual_memory().available < 7 * 1024**3:
                raise Fault('memory_pressure', 'Preparation requires 7 GiB available RAM.', 503)
            # Empty chunks load the genuine model and catalog conditioning only.
            for _ in nano(job, []):
                raise Fault('unexpected_audio', 'Preparation produced audio.', 500)
        elif data['kind'] == 'transcription':
            model = load('transcription')
            if job['cancel'].is_set():
                return
            import av
            with av.open(io.BytesIO(data['audio'])) as media:
                stream = next((stream for stream in media.streams if stream.type == 'audio'), None)
                if stream is None:
                    raise Fault('invalid_audio', 'No audio stream found.', 422)
                if stream.duration is not None and stream.time_base is not None and float(stream.duration * stream.time_base) > 120:
                    raise Fault('audio_too_long', 'Audio duration must not exceed 120 seconds.', 422)
                duration = 0
                for frame in media.decode(stream):
                    duration += frame.samples / frame.sample_rate
                    if duration > 120:
                        raise Fault('audio_too_long', 'Audio duration must not exceed 120 seconds.', 422)
                    if job['cancel'].is_set():
                        return
            segments, info = model.transcribe(io.BytesIO(data['audio']), language='en', beam_size=5, initial_prompt='Names and terms: Kamil, Raya, Eden. Home Assistant, movie mode.', vad_filter=True, condition_on_previous_text=False)
            text = ' '.join(segment.text.strip() for segment in segments)
            if not text:
                raise Fault('empty_transcript', 'No speech detected.', 422)
            with GUARD:
                if not job['cancel'].is_set():
                    job['text'] = text
        else:
            for audio, seconds in synthesize(job, data):
                if job['cancel'].is_set():
                    return
                with GUARD:
                    if job['cancel'].is_set():
                        return
                    index = len(job['audio'])
                    job['audio'].append(audio)
                    job['chunks'].append({'index': index, 'url': f"/v1/jobs/{job['id']}/audio/{index}", 'seconds': seconds, 'mime': 'audio/wav', 'bytes': len(audio), 'sha256': hashlib.sha256(audio).hexdigest()})
                    if index == 0:
                        job['timing']['first_audio_seconds'] = round(time.perf_counter() - job['created'], 3)
        with GUARD:
            if not job['cancel'].is_set():
                job['status'] = 'completed'
    except Exception as err:
        with GUARD:
            if not job['cancel'].is_set():
                job['status'] = 'failed'
                job['error'] = {'code': err.code if isinstance(err, Fault) else 'inference_failed', 'message': str(err)}
        print(json.dumps({'job': job['id'], 'error_type': type(err).__name__}), flush=True)
    finally:
        with GUARD:
            job['timing']['processing_seconds'] = round(time.perf_counter() - start, 3)
            job['finished'] = time.monotonic()
            LAST['used'] = time.monotonic()
        SLOTS.release()


def submit(data, key=None):
    if key is not None and (not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{32}', key)):
        raise Fault('invalid_job_id', 'Use a 32-character lowercase hexadecimal job ID.')
    fingerprint = hashlib.sha256(json.dumps({name: hashlib.sha256(value).hexdigest() if isinstance(value, bytes) else value for name, value in data.items()}, sort_keys=True).encode()).hexdigest()
    with GUARD:
        prune()
        if key in TOMBS:
            raise Fault('cancelled', 'This job ID was cancelled before creation.', 409)
        if key in JOBS:
            job = JOBS[key]
            if job['fingerprint'] != fingerprint:
                raise Fault('job_id_conflict', 'This job ID belongs to different input.', 409)
            return job
        if DRAIN['until'] > time.monotonic():
            raise Fault('service_draining', 'Speech admission is temporarily closed.', 503)
        if len(TOMBS) >= 256:
            raise Fault('cancel_capacity', 'Cancellation retention is full; retry later.', 429)
        if not SLOTS.acquire(blocking=False):
            raise Fault('queue_full', 'Speech queue is full; retry later.', 429)
        now = time.monotonic()
        stale = [key for key, job in JOBS.items() if job['finished'] is not None and now - job['finished'] > 600]
        for prior in stale:
            del JOBS[prior]
        # Keep result memory bounded even under a high rate of completed requests.
        for prior in list(JOBS):
            if len(JOBS) < 32:
                break
            if JOBS[prior]['finished'] is not None:
                del JOBS[prior]
        key = key or uuid.uuid4().hex
        job = {'id': key, 'kind': data['kind'], 'model': data.get('model', 'whisper-small.en'), 'voice': data.get('voice'), 'fallback': None, 'status': 'queued', 'chunks': [], 'audio': [], 'text': None, 'error': None, 'timing': {}, 'cancel': threading.Event(), 'created': time.perf_counter(), 'finished': None}
        JOBS[key] = job
        job['fingerprint'] = fingerprint
        POOL.submit(run, job, data)
        return job


class Api:
    def __init__(self, path, command, headers, raw=b''):
        self.path, self.command, self.headers = path, command, headers
        self.rfile = io.BytesIO(raw)

    def send(self, status, data, mime='application/json'):
        body = data if isinstance(data, bytes) else json.dumps(data).encode('utf-8')
        headers = {'Cache-Control': 'no-store'}
        if mime == 'audio/wav':
            headers['X-Raya-AI-Generated'] = 'true'
            headers['X-Content-SHA256'] = hashlib.sha256(body).hexdigest()
            headers['Content-Length'] = str(len(body))
            async def parts():
                for index in range(0, len(body), 32768):
                    yield body[index:index + 32768]
                    await asyncio.sleep(0)
            return StreamingResponse(parts(), status_code=status, media_type=mime, headers=headers)
        return Response(body, status_code=status, media_type=mime, headers=headers)

    def authorize(self):
        if self.headers.get('Host') not in {f'127.0.0.1:{PORT}', f'localhost:{PORT}'} or self.headers.get('Origin'):
            raise Fault('forbidden_origin', 'Use the extension host on loopback, without a browser Origin.', 403)
        if not secrets.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + KEY):
            raise Fault('unauthorized', 'A local service token is required.', 401)

    def body(self):
        if self.headers.get('Transfer-Encoding'):
            raise Fault('invalid_request', 'Use Content-Length.')
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError as err:
            raise Fault('invalid_request', 'Invalid Content-Length.') from err
        if not 0 < size <= 17000000:
            raise Fault('request_too_large', 'Request must contain 1 byte–17 MB.', 413)
        data = self.rfile.read(size)
        if len(data) != size:
            raise Fault('invalid_request', 'Incomplete request body.')
        return data

    def route(self):
        self.authorize()
        if self.command == 'GET' and self.path == '/health':
            with GUARD:
                state = {'ready': True, 'draining': DRAIN['until'] > time.monotonic(), 'loaded': list(RUNTIME), 'active': sum(job['finished'] is None for job in JOBS.values()), 'device': 'cpu', 'version': 2, 'source_sha256': SOURCE, 'workers_sha256': WORKERS}
            return self.send(200, state)
        if self.command == 'POST' and self.path in {'/v1/runtime/drain', '/v1/runtime/resume'}:
            key = self.headers.get('X-Raya-Drain-ID', '')
            if not re.fullmatch('[a-f0-9]{32}', key):
                raise Fault('invalid_drain_id', 'Provide a lowercase hexadecimal drain ID.', 400)
            with GUARD:
                if DRAIN['until'] > time.monotonic() and DRAIN['id'] != key:
                    raise Fault('drain_conflict', 'Another lifecycle owner holds the drain lease.', 409)
                DRAIN.update(id=key, until=time.monotonic() + 60 if self.path.endswith('/drain') else 0)
                state = {'draining': DRAIN['until'] > time.monotonic(), 'active': sum(job['finished'] is None for job in JOBS.values()), 'lease_seconds': 60}
            return self.send(200, state)
        if self.command == 'GET' and self.path == '/v1/models':
            return self.send(200, {'data': [{'id': key, 'revision': value['revision'], 'capability': 'transcription' if key.startswith('whisper') else 'speech', 'device': 'cpu'} for key, value in MODELS.items()], 'voice': PREFS['voice'], 'AI_generated': True})
        match = re.fullmatch(r'/v1/jobs/([a-f0-9]{32})(?:/audio/(\d+))?', self.path)
        if match:
            with GUARD:
                prune()
                job = JOBS.get(match[1])
                if self.command == 'DELETE' and match[2] is None:
                    if match[1] not in TOMBS and len(TOMBS) >= 256 and not job:
                        raise Fault('cancel_capacity', 'Cancellation retention is full; retry later.', 429)
                    TOMBS[match[1]] = time.monotonic()
                    if not job:
                        return self.send(200, {'id': match[1], 'status': 'cancelled'})
                if job and job['finished'] is not None and time.monotonic() - job['finished'] > 600:
                    del JOBS[match[1]]
                    job = None
                if not job:
                    raise Fault('not_found', 'Job not found or expired.', 404)
                if self.command == 'DELETE' and match[2] is None:
                    job['cancel'].set()
                    job['status'] = 'cancelled'
                    job['audio'].clear()
                    job['chunks'].clear()
                    job['text'] = None
                    result, mime = view(job), 'application/json'
                if self.command == 'GET' and match[2] is None:
                    result, mime = view(job), 'application/json'
                if self.command == 'GET' and match[2] is not None:
                    index = int(match[2])
                    if index < len(job['audio']):
                        result, mime = job['audio'][index], 'audio/wav'
                    else:
                        raise Fault('not_found', 'Audio chunk unavailable.', 404)
                if self.command not in {'GET', 'DELETE'} or (self.command == 'DELETE' and match[2] is not None):
                    raise Fault('not_found', 'Route not found.', 404)
            return self.send(200, result, mime)
        if self.command != 'POST':
            raise Fault('not_found', 'Route not found.', 404)
        if self.path not in {'/v1/jobs', '/v1/audio/transcriptions', '/v1/audio/speech'}:
            raise Fault('not_found', 'Route not found.', 404)
        raw = self.body()
        if self.path == '/v1/audio/transcriptions':
            mime = self.headers.get('Content-Type', '')
            if not mime.startswith('multipart/form-data;'):
                raise Fault('invalid_request', 'Use multipart form-data.')
            form = BytesParser(policy=default).parsebytes(('Content-Type: ' + mime + '\r\nMIME-Version: 1.0\r\n\r\n').encode() + raw)
            fields = {part.get_param('name', header='content-disposition'): part for part in form.iter_parts()}
            if 'file' not in fields:
                raise Fault('invalid_request', 'Missing file field.')
            data = {'kind': 'transcription', 'audio': base64.b64encode(fields['file'].get_payload(decode=True)).decode(), 'mime': fields['file'].get_content_type(), 'model': fields['model'].get_payload(decode=True).decode() if 'model' in fields else 'whisper-small.en'}
        else:
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise Fault('unsupported_media', 'Use application/json.', 415)
            try:
                data = json.loads(raw)
            except (ValueError, UnicodeDecodeError) as err:
                raise Fault('invalid_json', 'Invalid JSON body.') from err
            if isinstance(data, dict) and self.path == '/v1/audio/speech':
                data['kind'] = 'speech'
                if data.get('response_format', 'wav') != 'wav':
                    raise Fault('unsupported_format', 'Use WAV.', 422)
        data = validate(data)
        if data['kind'] == 'prepare' and self.path != '/v1/jobs':
            raise Fault('invalid_request', 'Preparation requires the cancellable jobs route.')
        job = submit(data, self.headers.get('X-Raya-Job-ID') if self.path == '/v1/jobs' else None)
        if self.path == '/v1/jobs':
            with GUARD:
                result = view(job)
            return self.send(202, result)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            with GUARD:
                status = job['status']
                error, text, audio = job['error'], job['text'], list(job['audio']) if status == 'completed' else []
            if status == 'failed':
                return self.send(422, {'error': error})
            if status == 'cancelled':
                raise Fault('cancelled', 'Speech request cancelled.', 409)
            if status == 'completed':
                if data['kind'] == 'transcription':
                    return self.send(200, {'text': text})
                import soundfile as sf
                import numpy as np
                arrays = [sf.read(io.BytesIO(chunk), dtype='int16')[0] for chunk in audio]
                file = io.BytesIO()
                # Current Nano and Kokoro voices both emit 24 kHz PCM.
                sf.write(file, np.concatenate(arrays), 24000, format='WAV', subtype='PCM_16')
                return self.send(200, file.getvalue(), 'audio/wav')
            time.sleep(0.05)
        with GUARD:
            job['cancel'].set()
            job['status'] = 'cancelled'
            job['audio'].clear()
            job['chunks'].clear()
        raise Fault('timeout', 'Speech request timed out.', 504)

    def dispatch(self):
        try:
            return self.route()
        except Fault as err:
            return self.send(err.status, {'error': {'code': err.code, 'message': str(err)}})
        except Exception as err:
            print(json.dumps({'request_error_type': type(err).__name__}), flush=True)
            return self.send(500, {'error': {'code': 'internal_error', 'message': 'Local speech request failed.'}})


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.api_route('/{path:path}', methods=['GET', 'POST', 'DELETE'])
async def handle(request: Request, path: str):
    api = Api('/' + path, request.method, request.headers)
    try:
        api.authorize()
        if request.method == 'POST':
            async def read():
                raw = bytearray()
                async for part in request.stream():
                    raw.extend(part)
                    if len(raw) > 17000000:
                        raise Fault('request_too_large', 'Request exceeds 17 MB.', 413)
                return bytes(raw)
            api.rfile = io.BytesIO(await asyncio.wait_for(read(), timeout=15))
        return await run_in_threadpool(api.dispatch)
    except Fault as err:
        return api.send(err.status, {'error': {'code': err.code, 'message': str(err)}})
    except asyncio.TimeoutError:
        return api.send(408, {'error': {'code': 'request_timeout', 'message': 'Request body timed out.'}})


if __name__ == '__main__':
    print(f'Local speech API listening on 127.0.0.1:{PORT}; models load on demand.', flush=True)
    retention = threading.Thread(target=maintain, daemon=True, name='result-retention')
    retention.start()
    owner = None
    try:
        import uvicorn
        service = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=PORT, access_log=False))
        if os.environ.get('RAYA_SPEECH_OWNED_STDIN') == '1':
            def joined():
                # The launching owner retains this pipe; its EOF ends this service.
                for _ in sys.stdin:
                    pass
                service.should_exit = True
            owner = threading.Thread(target=joined, daemon=True, name='service-owner')
            owner.start()
        service.run()
    finally:
        STOP.set()
        for job in JOBS.values():
            job['cancel'].set()
        POOL.shutdown(wait=True, cancel_futures=True)
        retire()
        retention.join(timeout=10)
        if retention.is_alive():
            raise RuntimeError('Speech retention thread did not retire.')
        if owner is not None and service.should_exit:
            owner.join(timeout=10)
            if owner.is_alive():
                raise RuntimeError('Speech owner pipe did not retire.')
