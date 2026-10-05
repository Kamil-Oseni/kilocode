"""Read-only CPU embedding/reranking API; does not index or rewrite personal notes."""
import asyncio
import ctypes
import hashlib
import json
import os
import re
import secrets
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, Future
from pathlib import Path
from owner import Owner, selected
from validation import decode, canonical, fingerprint, result as validated
from namespace import Namespace
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse

ROOT = Path(__file__).parent
PORT = int(os.environ.get('RAYA_RETRIEVAL_PORT', '8873'))
TOKEN = Path(os.environ['RAYA_RETRIEVAL_TOKEN_FILE'])
KEY = TOKEN.read_text().strip()
SOURCE = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
          for name in ('server.py', 'owner.py', 'bootstrap.py', 'worker.py', 'models.py', 'validation.py', 'namespace.py')}
EPOCH = uuid.uuid4().hex
NAMESPACE = Namespace(os.environ['RAYA_RETRIEVAL_RECEIPT_ROOT'],
                      os.environ['RAYA_RETRIEVAL_RECEIPT_SID'],
                      decode(os.environ['RAYA_RETRIEVAL_RECEIPT_GENERATIONS'].encode(), 65536))
WORKER = hashlib.sha256((ROOT / 'worker.py').read_bytes()).hexdigest()
RESERVE = max(6, int(os.environ.get('RAYA_RETRIEVAL_MIN_RAM_GIB', '6'))) * 1024 ** 3
DEADLINE = max(1, min(150, int(os.environ.get('RAYA_RETRIEVAL_TIMEOUT', '150'))))
CATALOG = Path(r'D:\Raya\Models\Catalog')
CATALOGS = {'Qwen--Qwen3-Embedding-0.6B.json': '60cae741077a5b3f79f531c139674a1461bda80a5fb8ca767ec1a9ba25975b7d',
            'Qwen--Qwen3-Reranker-0.6B.json': 'ef8b5bbc099e513ad2ddcd0d20e1ce0006a87e1701228631652d278eecb3f0a3'}
IMAGES = {name: selected(CATALOG/name, digest, include=True)[1] for name, digest in CATALOGS.items()}
RELEASE = fingerprint({'source_sha256': SOURCE, 'catalog_sha256': CATALOGS}, 65536)
MODELS = {
    'qwen3-embedding-0.6b': decode(IMAGES['Qwen--Qwen3-Embedding-0.6B.json'], 65536),
    'qwen3-reranker-0.6b': decode(IMAGES['Qwen--Qwen3-Reranker-0.6B.json'], 65536),
}
GUARD = threading.RLock()
SLOTS = threading.BoundedSemaphore(4)
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='retrieval')
STORAGE = ThreadPoolExecutor(max_workers=1, thread_name_prefix='retrieval-receipts')
CACHE = {'kind': None, 'model': None}
ACTIVE = 0
JOBS = {}
RECORDS = {}
UNCERTAIN = any((NAMESPACE.root/'Runs').rglob('*.json')) or any((NAMESPACE.root/'Requests').rglob('*.json'))
DRAIN = {'id': None, 'until': 0}


def fail(code, message, status):
    return JSONResponse({'error': {'code': code, 'message': message}}, status_code=status, headers={'Cache-Control': 'no-store'})


class Cancelled(RuntimeError):
    pass


class PressureError(RuntimeError):
    pass


class Retirement(RuntimeError):
    pass


def publish(key, value):
    folder = NAMESPACE.folder('Requests', EPOCH)
    raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode()
    if len(raw) > 65536:
        raise ValueError('request_receipt_bound')
    NAMESPACE.publish(folder, key+'-'+uuid.uuid4().hex+'.json', raw)


def view(key):
    record = RECORDS[key]
    owner = record.get('owner')
    state = owner.state if owner is not None else {}
    summary = record.get('terminal')
    if summary is None:
        summary = {'phase': 'uncertain' if record.get('uncertain') else ('joining' if owner is not None else 'queued'),
                   'worker_created': owner.created if owner is not None else False,
                   'cleanup_outcome': 'uncertain' if record.get('uncertain') else 'not_started',
                   'joins_observed': state.get('joins_observed', False)}
    return dict(summary, format='raya.retrieval.retirement', version=1, request=key,
                owner_epoch=EPOCH, selected_release_sha256=RELEASE,
                request_sha256=record['request_sha256'])


def fence(key):
    global UNCERTAIN
    with GUARD:
        UNCERTAIN = True
        RECORDS[key]['observation_expired'] = True


def integrity():
    NAMESPACE.check()
    for name, digest in SOURCE.items():
        selected(ROOT/name, digest)
    for name, digest in CATALOGS.items():
        selected(CATALOG/name, digest)


async def observe(future, publication, cancel, key):
    primary = None
    value = None
    try:
        value = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(future)), timeout=180)
    except BaseException as error:
        primary = error
        cancel.set()
        if isinstance(error, (asyncio.TimeoutError, asyncio.CancelledError)):
            fence(key)
    try:
        await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(publication)), timeout=30)
    except BaseException as error:
        fence(key)
        if primary is not None:
            raise BaseExceptionGroup('Inference and original publication observation failed.', [primary, error])
        raise Retirement('Original publication remains unconfirmed.') from error
    if primary is not None:
        raise primary
    return value


def available():
    class Status(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in ('total', 'free', 'paging', 'available_paging', 'virtual', 'available_virtual', 'extended')]
    state = Status()
    state.length = ctypes.sizeof(state)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(state)):
        raise OSError('Unable to read Windows memory status.')
    return state.free


def infer(key, kind, body, until, cancel):
    cancel = cancel or threading.Event()
    if cancel.is_set():
        raise Cancelled('Retrieval was cancelled before worker startup.')
    if time.monotonic() >= until:
        raise TimeoutError('Retrieval expired in the queue.')
    if available() < RESERVE:
        raise PressureError('Available RAM is below the configured retrieval reserve.')
    with GUARD:
        if UNCERTAIN:
            raise Retirement('Supervisor admission is closed on retained ownership uncertainty.')
        integrity()
        CACHE['kind'] = kind
        RECORDS[key]['admission_entered'] = True
    owner = Owner(key, EPOCH, kind, body, cancel, until, lambda: fence(key), NAMESPACE)
    owner.state['selected_release_sha256'] = RELEASE
    with GUARD:
        RECORDS[key]['owner'] = owner
    state = owner.run()
    if state['cleanup_outcome'] != 'joined' or state['ownership_retained']:
        if owner.causes:
            raise Retirement('Original request ownership and cleanup remain unconfirmed.') from BaseExceptionGroup('Original operation and cleanup causes.', owner.causes)
        raise Retirement('Original request ownership and cleanup remain unconfirmed.')
    if cancel.is_set():
        raise Cancelled('Retrieval cancellation joined.')
    if state['operation_outcome'] != 'completed':
        if owner.causes:
            raise RuntimeError('Selected inference failed after joined cleanup.') from BaseExceptionGroup('Original operation and cleanup causes.', owner.causes)
        raise RuntimeError('Selected inference failed after joined cleanup.')
    raw = bytes(owner.readers['output']['data'])
    reply = decode(raw, 2097152)
    if not isinstance(reply, dict):
        raise RuntimeError('Selected inference reply must be an object.')
    if reply.get('type') == 'validation':
        raise ValueError('Selected model input validation failed.')
    if not isinstance(reply, dict) or set(reply) != {'result'}:
        raise RuntimeError('Selected inference reply schema differs.')
    model = 'qwen3-embedding-0.6b' if kind == 'embeddings' else 'qwen3-reranker-0.6b'
    value = validated(reply['result'], kind, body, MODELS[model]['revision'])
    with GUARD:
        RECORDS[key]['result_sha256'] = fingerprint(value, 2097152)
    return value


def complete(key, record, summary, receipt, digest, joined):
    global ACTIVE, UNCERTAIN
    try:
        publish(key, dict(receipt, receipt_sha256=digest))
    except Exception as error:
        with GUARD:
            record['uncertain'] = True
            UNCERTAIN = True
            fault = Retirement('Original terminal publication failed.')
            fault.__cause__ = error
            record['publication'].set_exception(fault)
            record['publication_running'] = False
        print(json.dumps({'receipt_error_type': type(error).__name__}), flush=True)
        return
    with GUARD:
        record['terminal'] = dict(summary, receipt_sha256=digest)
        record['publication_running'] = False
        record['owner'] = None
        ACTIVE -= 1
        if joined:
            CACHE['kind'] = None
        SLOTS.release()
        record['publication'].set_result(dict(record['terminal']))


def release(future, key):
    global UNCERTAIN
    with GUARD:
        JOBS.pop(key, None)
        record = RECORDS[key]
        owner = record.get('owner')
        joined = owner is not None and owner.state.get('cleanup_outcome') == 'joined' and not owner.handles
        never = owner is None and not record.get('admission_entered')
        if not joined and not never:
            record['uncertain'] = True
            UNCERTAIN = True
            record['publication'].set_exception(Retirement('Original family cleanup is unconfirmed.'))
            return
        summary = {'phase': 'retired', 'worker_created': owner.created if owner is not None else False,
                   'cleanup_outcome': 'joined' if joined else 'not_started',
                   'joins_observed': joined, 'queued_never_created': never}
        summary['inference_outcome'] = 'cancelled' if future.cancelled() or record['cancel'].is_set() else ('failed' if future.exception() is not None else 'completed')
        if summary['inference_outcome'] == 'completed':
            summary['result_sha256'] = record['result_sha256']
        if joined:
            summary.update(root_exit=owner.state['root_exit'], job_active=owner.state['job_active'],
                           input_closed=True, control_closed=True,
                           output_eof=owner.state['outputs']['output']['eof'],
                           error_eof=owner.state['outputs']['error']['eof'], readers_joined=True,
                           original_handles_closed=True, writer_joined=owner.state['writer_joined'])
        receipt = dict(summary, format='raya.retrieval.retirement', version=1,
                       request=key, owner_epoch=EPOCH, selected_release_sha256=RELEASE,
                       request_sha256=record['request_sha256'])
        digest = hashlib.sha256(json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        record['publication_running'] = True
        try:
            record['terminal_write'] = STORAGE.submit(complete, key, record, summary, receipt, digest, joined)
        except Exception as error:
            record['uncertain'] = True
            UNCERTAIN = True
            fault = Retirement('Original terminal storage could not be scheduled.')
            fault.__cause__ = error
            record['publication'].set_exception(fault)
            record['publication_running'] = False
            print(json.dumps({'terminal_schedule_error_type': type(error).__name__}), flush=True)


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.api_route('/{path:path}', methods=['GET', 'POST', 'DELETE'])
async def handle(request: Request, path: str):
    global ACTIVE, UNCERTAIN
    if request.headers.get('host') not in {f'127.0.0.1:{PORT}', f'localhost:{PORT}'} or request.headers.get('origin'):
        return fail('forbidden_origin', 'Use the extension host on loopback without a browser Origin.', 403)
    if not secrets.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + KEY):
        return fail('unauthorized', 'A local service token is required.', 401)
    if request.method == 'GET' and path == 'health':
        with GUARD:
            try:
                integrity()
            except Exception as error:
                UNCERTAIN = True
                print(json.dumps({'integrity_error_type': type(error).__name__}), flush=True)
            return JSONResponse({'ready': not UNCERTAIN, 'retirement_unconfirmed': bool(UNCERTAIN),
                                 'draining': DRAIN['until'] > time.monotonic(), 'device': 'cpu',
                                 'active': ACTIVE, 'loaded': CACHE['kind'], 'source_sha256': SOURCE,
                                 'catalog_sha256': CATALOGS,
                                 'selected_release_sha256': RELEASE, 'owner_epoch': EPOCH,
                                 'ownership_protocol': 'raya.retrieval.retirement.v1',
                                 'lifecycle': 'owned_request_job', 'worker_timeout_seconds': DEADLINE,
                                 'worker_sha256': WORKER, 'available_ram_bytes': available(),
                                 'minimum_available_ram_bytes': RESERVE}, headers={'Cache-Control': 'no-store'})
    if request.method in ('GET', 'DELETE') and path.startswith('v1/requests/'):
        key = path.removeprefix('v1/requests/')
        if not re.fullmatch('[a-f0-9]{32}', key):
            return fail('invalid_request_id', 'Supply a lowercase hexadecimal request ID.', 400)
        if request.headers.get('x-raya-owner-epoch') != EPOCH:
            return fail('owner_epoch_changed', 'Use the same selected supervisor epoch; no replay.', 409)
        with GUARD:
            if key not in RECORDS:
                return fail('request_unknown', 'Original request provenance is unavailable.', 404)
            if request.method == 'GET':
                return JSONResponse(view(key), headers={'Cache-Control': 'no-store'})
            record = RECORDS[key] if RECORDS[key].get('terminal') is None else None
            cancel = record['cancel'] if record is not None else None
            if cancel is not None:
                cancel.set()
            future = record['future'] if record is not None else None
            active = key in JOBS
        if future is not None:
            future.cancel()
        return JSONResponse({'cancel_requested': True, 'active': active,
                             'request': key, 'owner_epoch': EPOCH,
                             'retirement_acknowledged': False}, headers={'Cache-Control': 'no-store'})
    if request.method == 'POST' and path in {'v1/runtime/drain', 'v1/runtime/resume'}:
        key = request.headers.get('x-raya-drain-id', '')
        if not re.fullmatch('[a-f0-9]{32}', key):
            return fail('invalid_drain_id', 'Provide a lowercase hexadecimal drain ID.', 400)
        with GUARD:
            if DRAIN['until'] > time.monotonic() and DRAIN['id'] != key:
                return fail('drain_conflict', 'Another lifecycle owner holds the drain lease.', 409)
            DRAIN.update(id=key, until=time.monotonic() + 60 if path.endswith('/drain') else 0)
            return JSONResponse({'draining': DRAIN['until'] > time.monotonic(), 'active': ACTIVE, 'lease_seconds': 60}, headers={'Cache-Control': 'no-store'})
    if request.method == 'GET' and path == 'v1/models':
        return JSONResponse({'data': [{'id': key, 'revision': model['revision'], 'device': 'cpu', 'max_tokens': 512} for key, model in MODELS.items()]}, headers={'Cache-Control': 'no-store'})
    if request.method != 'POST' or path not in {'v1/embeddings', 'v1/rerank'}:
        return fail('not_found', 'Route not found.', 404)
    if request.headers.get('x-raya-owner-epoch') != EPOCH:
        return fail('owner_epoch_changed', 'Retain the selected supervisor epoch before submission.', 409)
    if request.headers.get('content-type', '').split(';')[0] != 'application/json':
        return fail('unsupported_media', 'Use application/json.', 415)
    async def read():
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 300000:
                raise ValueError('Request exceeds 300 KB.')
        return decode(bytes(raw), 300000)
    try:
        body = await asyncio.wait_for(read(), timeout=15)
    except (ValueError, UnicodeDecodeError) as err:
        return fail('invalid_request', str(err), 400)
    except asyncio.TimeoutError:
        return fail('request_timeout', 'Request body timed out.', 408)
    if not isinstance(body, dict):
        return fail('invalid_request', 'Expected a JSON object.', 400)
    kind = 'embeddings' if path == 'v1/embeddings' else 'rerank'
    allowed = {'model', 'input', 'input_type'} if kind == 'embeddings' else {'model', 'query', 'documents', 'top_n'}
    if set(body)-allowed:
        return fail('invalid_request', 'Unsupported model input fields.', 422)
    expected = 'qwen3-embedding-0.6b' if kind == 'embeddings' else 'qwen3-reranker-0.6b'
    if body.get('model', expected) != expected:
        return fail('unsupported_model', 'Use ' + expected + '.', 422)
    values = body.get('input') if kind == 'embeddings' else body.get('documents')
    if kind == 'embeddings' and isinstance(values, str):
        values = [values]
        body['input'] = values
    limit = 32 if kind == 'embeddings' else 16
    if not isinstance(values, list) or not 1 <= len(values) <= limit or any(not isinstance(text, str) or not 0 < len(text.strip()) <= 8000 for text in values):
        return fail('invalid_input', f'Supply 1Ã¢â‚¬â€œ{limit} nonempty strings, each at most 8000 characters.', 422)
    if kind == 'embeddings' and body.get('input_type', 'document') not in ('document', 'query'):
        return fail('invalid_input', 'input_type must be document or query.', 422)
    if kind == 'rerank':
        query = body.get('query')
        top = body.get('top_n', len(values))
        if not isinstance(query, str) or not 0 < len(query.strip()) <= 2000 or type(top) is not int or not 1 <= top <= len(values):
            return fail('invalid_input', 'Provide a query and a valid integer top_n.', 422)
    budget = request.headers.get('x-raya-timeout-ms', str(DEADLINE * 1000))
    if not re.fullmatch('[0-9]{1,6}', budget) or not 1 <= int(budget) <= DEADLINE * 1000:
        return fail('invalid_timeout', 'Supply a worker budget from 1 ms to the configured deadline.', 400)
    until = time.monotonic() + int(budget) / 1000
    key = request.headers.get('x-raya-request-id', '')
    if not re.fullmatch('[a-f0-9]{32}', key):
        return fail('invalid_request_id', 'Supply a lowercase hexadecimal request ID.', 400)
    cancel = threading.Event()
    try:
        canonical({'kind': kind, 'body': body}, 300000)
        digest = fingerprint(body)
    except (ValueError, UnicodeError, TypeError):
        return fail('invalid_request', 'Canonical bounded model input is required.', 422)
    with GUARD:
        try:
            integrity()
        except Exception as error:
            UNCERTAIN = True
            print(json.dumps({'integrity_error_type': type(error).__name__}), flush=True)
            return fail('integrity_unconfirmed', 'Selected source or receipt namespace changed.', 503)
        if UNCERTAIN:
            return fail('retirement_unconfirmed', 'Original ownership debt closes admission.', 503)
        if key in RECORDS:
            return fail('request_reserved', 'This request ID is already active, retired or cancelled.', 409)
        if len(RECORDS) >= 256:
            return fail('reservation_full', 'Retrieval identity reservations are full.', 429)
        if DRAIN['until'] > time.monotonic():
            return fail('service_draining', 'Retrieval admission is temporarily closed.', 503)
        if not SLOTS.acquire(blocking=False):
            return fail('queue_full', 'Retrieval queue is full; retry later.', 429)
        ACTIVE += 1
        RECORDS[key] = {'cancel': cancel, 'future': None, 'publication': Future(),
                        'admission_entered': False, 'owner': None, 'request_sha256': digest}
        JOBS[key] = RECORDS[key]
        reservation = view(key)
    try:
        write = STORAGE.submit(publish, key, reservation)
        with GUARD:
            RECORDS[key]['reservation_write'] = write
        await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(write)), timeout=15)
    except BaseException as error:
        with GUARD:
            RECORDS[key]['uncertain'] = True
            UNCERTAIN = True
            RECORDS[key]['publication'].set_exception(Retirement('Request reservation publication failed.'))
        cancel.set()
        print(json.dumps({'reservation_error_type': type(error).__name__}), flush=True)
        if isinstance(error, asyncio.CancelledError):
            raise
        return fail('retirement_unconfirmed', 'Original reservation storage remains retained for inspection.', 503)
    try:
        future = POOL.submit(infer, key, kind, body, until, cancel)
    except Exception as error:
        with GUARD:
            RECORDS[key]['uncertain'] = True
            UNCERTAIN = True
            RECORDS[key]['publication'].set_exception(Retirement('Queued request submission failed.'))
        print(json.dumps({'submission_error_type': type(error).__name__}), flush=True)
        return fail('retirement_unconfirmed', 'Queued request submission is unconfirmed.', 503)
    with GUARD:
        JOBS[key]['future'] = future
        cancelling = cancel.is_set()
    if cancelling:
        future.cancel()
    future.add_done_callback(lambda future: release(future, key))
    try:
        result = await observe(future, RECORDS[key]['publication'], cancel, key)
        with GUARD:
            receipt = view(key)
        if receipt['phase'] != 'retired' or not receipt.get('receipt_sha256'):
            return fail('retirement_unconfirmed', 'Original terminal publication is not acknowledged.', 503)
        if cancel.is_set() or receipt['inference_outcome'] != 'completed' or receipt.get('result_sha256') != fingerprint(result, 2097152):
            return fail('cancelled_or_result_changed', 'Completed cleanup does not acknowledge this model result.', 499)
        return JSONResponse(dict(result, retirement=receipt), headers={'Cache-Control': 'no-store'})
    except (Cancelled, asyncio.CancelledError):
        cancel.set()
        return fail('cancelled', 'Retrieval request was cancelled.', 499)
    except Retirement:
        return fail('retirement_unconfirmed', 'Original request ownership remains available for inspection.', 503)
    except PressureError as err:
        return fail('memory_pressure', str(err), 503)
    except ValueError as err:
        return fail('invalid_input', str(err), 422)
    except asyncio.TimeoutError:
        cancel.set()
        return fail('timeout', 'Retrieval request timed out.', 504)
    except Exception as err:
        print(json.dumps({'inference_error_type': type(err).__name__}), flush=True)
        return fail('inference_failed', 'Local retrieval inference failed.', 500)


if __name__ == '__main__':
    import uvicorn
    try:
        uvicorn.run(app, host='127.0.0.1', port=PORT, access_log=False)
    finally:
        POOL.shutdown(wait=True, cancel_futures=True)
        STORAGE.shutdown(wait=True, cancel_futures=False)
        for record in RECORDS.values():
            if record.get('future') is not None:
                # Original callbacks/storage writes remain owned even after inference future settles.
                record['publication'].result()
        if UNCERTAIN:
            raise Retirement('Shutdown has retained original ownership or publication debt.')
