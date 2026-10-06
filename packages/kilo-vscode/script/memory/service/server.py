"""Selected-root Memory API with retained request and publication ownership."""
import asyncio
import contextlib
import hashlib
import os
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse
from index import Index, execute, Cancelled
from admission import Retirement, failures
from operations import Journal
from dispatch import prepare, submit
from proposals import Proposals
from retirement import decode, canonical, fingerprint, hex

ROOT = Path(__file__).parent
PORT = int(os.environ.get('RAYA_MEMORY_PORT', '8874'))
NOTES = Path(os.environ['RAYA_MEMORY_ROOT'])
if not NOTES.is_absolute():
    raise ValueError('An explicit absolute Memory root is required.')
TOKEN = Path(os.environ['RAYA_MEMORY_TOKEN_FILE'])
if not TOKEN.is_absolute():
    raise ValueError('An explicit absolute token file is required.')
KEY = TOKEN.read_text(encoding='utf-8').strip()
if not KEY:
    raise ValueError('An existing token is required.')
SOURCE = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in
          ('server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py', 'host.py',
           'operations.py', 'retirement.py', 'namespace.py', 'historical.py', 'dispatch.py', 'proposals.py')}
RELEASE = fingerprint(SOURCE)
EPOCH = secrets.token_hex(16)
JOURNAL = Journal(os.environ['RAYA_MEMORY_OPERATION_ROOT'],
                  os.environ['RAYA_MEMORY_OPERATION_SID'],
                  decode(os.environ['RAYA_MEMORY_OPERATION_GENERATIONS'].encode()), EPOCH, RELEASE)
GENERATIONS = decode(os.environ['RAYA_MEMORY_NOTE_GENERATIONS'].encode())
if not isinstance(GENERATIONS, dict) or set(GENERATIONS) != {'root', 'system'} or any(not isinstance(value, list) or len(value) != 3 or any(type(item) is not int for item in value) for value in GENERATIONS.values()):
    raise ValueError('Explicit existing note namespace generations are required.')
INDEX = Index(NOTES, existing=True, generation={NOTES: tuple(GENERATIONS['root']),
              NOTES/'System': tuple(GENERATIONS['system'])})
POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix='memory')
STORAGE = ThreadPoolExecutor(max_workers=1, thread_name_prefix='memory-receipts')
SLOTS = threading.BoundedSemaphore(1)
GUARD = threading.Lock()
RECORDS = {}
PROPOSALS = Proposals(NOTES)
REVIEWS = set()
REVIEW_ERRORS = []
ACTIVE = 0
UNCERTAIN = False
DRAIN = {'id': None, 'until': 0}
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def search(body):
    if not isinstance(body, dict) or set(body)-{'query', 'top', 'context_budget'} or not isinstance(body.get('query'), str) or not body['query'].strip() or type(body.get('top', 5)) is not int or not 1 <= body.get('top', 5) <= 10:
        raise ValueError('Provide a query and integer top between 1 and 10.')
    budget = body.get('context_budget')
    if 'context_budget' in body and (type(budget) is not int or not 1 <= budget <= 12000):
        raise ValueError('Provide an explicit integer linked-context budget from 1 to 12000.')
    return {'query': body['query'], 'top': body.get('top', 5), **({'context_budget': budget} if budget is not None else {})}


async def admit(record, key, kind, body, work):
    def reserve():
        if integrity():
            raise Retirement('A prior downstream request remains pending.')
        return prepare(JOURNAL, key, kind, body, SOURCE)
    reservation = STORAGE.submit(reserve)
    with GUARD:
        record['reservation'] = reservation
    prepared = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(reservation)), 15)
    with GUARD:
        record['pending'] = prepared['pending']
        record['phase'] = 'pending'
    if record['cancel'].is_set():
        raise Cancelled('Cancelled before inference submission.')
    until = time.monotonic()+170
    future = submit(JOURNAL, prepared, SOURCE, POOL,
                    lambda _: execute(work, until, record['cancel'], key, record['proofs']),
                    record['cancel'])
    with GUARD:
        record['future'] = future
    future.add_done_callback(lambda value: settled(record, value))
    return future


def fail(code, message, status):
    return JSONResponse({'error': {'code': code, 'message': message}}, status_code=status,
                        headers={'Cache-Control': 'no-store'})


def fence(record, error):
    global UNCERTAIN
    with GUARD:
        UNCERTAIN = True
        record['faults'].append(error)
        record['phase'] = 'uncertain'
    record['cancel'].set()


def integrity():
    JOURNAL.namespace.check()
    if any(hashlib.sha256((ROOT/name).read_bytes()).hexdigest() != digest for name, digest in SOURCE.items()):
        raise ValueError('Selected Memory source changed.')
    return INDEX.store.pending() or PROPOSALS.pending()


def finish(record, future):
    # Runs on STORAGE after the original inference Future has settled.
    pending = record['pending']
    error = None if future.cancelled() else future.exception()
    if error is not None and any(isinstance(item, Retirement) for item in failures(error)):
        raise Retirement('Downstream retirement remains unconfirmed.') from error
    if integrity():
        raise Retirement('A downstream request has no terminal ownership certificate.')
    outcome = 'cancelled' if future.cancelled() or record['cancel'].is_set() else 'failed' if error is not None else 'completed'
    result = future.result() if outcome == 'completed' else None
    return JOURNAL.complete(pending, result, outcome, record['proofs'])


def published(record, future):
    global ACTIVE
    try:
        value = future.result()
    except BaseException as error:
        fence(record, error)
        return
    # Future settlement, guarded publication readback and original inference settlement
    # are required separately. No disk/native work occurs in this callback.
    with GUARD:
        if record['faults']:
            return
        record['terminal'] = value
        record['phase'] = 'terminal'
        ACTIVE -= 1
    SLOTS.release()


def settled(record, future):
    try:
        publication = STORAGE.submit(finish, record, future)
        with GUARD:
            record['publication'] = publication
        publication.add_done_callback(lambda value: published(record, value))
    except BaseException as error:
        fence(record, error)


@app.api_route('/{path:path}', methods=['GET', 'POST', 'DELETE'])
async def handle(request: Request, path: str):
    global ACTIVE
    if request.headers.get('host') not in {f'127.0.0.1:{PORT}', f'localhost:{PORT}'} or request.headers.get('origin'):
        return fail('forbidden_origin', 'Use the local extension host.', 403)
    if not secrets.compare_digest(request.headers.get('authorization', ''), 'Bearer '+KEY):
        return fail('unauthorized', 'A local service token is required.', 401)
    if request.method == 'GET' and path == 'health':
        check = STORAGE.submit(integrity)
        try:
            pending = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(check)), 15)
        except Exception:
            return fail('inspection_required', 'Memory identity or ownership is unconfirmed.', 503)
        with GUARD:
            value = {'ready': not (UNCERTAIN or pending), 'namespace_valid': True, 'retirement_unconfirmed': UNCERTAIN or (pending and ACTIVE == 0),
                     'retirement_pending': pending, 'active': ACTIVE,
                     'draining': DRAIN['until'] > time.monotonic(), 'capture_enabled': False,
                     'admission_required': True, 'root': str(NOTES), 'source_sha256': SOURCE,
                     'owner_epoch': EPOCH, 'selected_release_sha256': RELEASE,
                     'operation_protocol': 'raya.memory.operation.v1'}
        return JSONResponse(value, headers={'Cache-Control': 'no-store'})
    if request.headers.get('x-raya-memory-owner-epoch') != EPOCH:
        return fail('owner_epoch_changed', 'Select the original Memory owner epoch.', 409)
    if request.method == 'POST' and path == 'v1/memory/proposals':
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            return fail('unsupported_media', 'Use application/json.', 415)
        with GUARD:
            if UNCERTAIN or ACTIVE or DRAIN['until'] > time.monotonic() or not SLOTS.acquire(blocking=False):
                return fail('admission_closed', 'Memory is busy or requires reconciliation.', 409)
        try:
            async def read():
                raw = bytearray()
                async for part in request.stream():
                    raw.extend(part)
                    if len(raw) > 2100000:
                        raise ValueError('Proposal exceeds the bounded review size.')
                return decode(bytes(raw), 2100000)
            body = await asyncio.wait_for(read(), 15)
        except (ValueError, UnicodeDecodeError):
            SLOTS.release()
            return fail('invalid_proposal', 'Proposal input is invalid.', 422)
        except asyncio.TimeoutError:
            SLOTS.release()
            return fail('request_timeout', 'Proposal body timed out before submission.', 408)
        except BaseException:
            SLOTS.release()
            raise
        def work():
            if integrity():
                raise Retirement('Memory has pending retirement.')
            return PROPOSALS.execute(body)
        try:
            future = STORAGE.submit(work)
        except BaseException:
            SLOTS.release()
            raise
        with GUARD:
            REVIEWS.add(future)
            ACTIVE += 1
        def complete(value):
            global ACTIVE, UNCERTAIN
            with GUARD:
                ACTIVE -= 1
                # Business validation errors are closed; interrupted writes remain sticky.
                if not value.cancelled() and value.exception() is not None and not isinstance(value.exception(), ValueError):
                    UNCERTAIN = True
                    REVIEW_ERRORS.append(value.exception())
                REVIEWS.discard(value)
            SLOTS.release()
        future.add_done_callback(complete)
        try:
            value = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(future)), 30)
            return JSONResponse(value, headers={'Cache-Control': 'no-store'})
        except ValueError:
            return fail('proposal_conflict', 'Proposal or source changed; review the current proposal.', 409)
        except BaseException:
            # Never cancel or retry the original write on lost transport.
            return fail('proposal_unconfirmed', 'Inspect the original proposal before any further write.', 503)
    if path.startswith('v1/memory/requests/') and request.method in ('GET', 'DELETE'):
        key = path.removeprefix('v1/memory/requests/')
        if not hex(key, 32):
            return fail('invalid_request_id', 'Request identity is invalid.', 400)
        with GUARD:
            record = RECORDS.get(key)
            if record is None:
                return fail('request_unknown', 'No original request is retained by this owner.', 404)
            value = record['terminal'] if record['phase'] == 'terminal' else dict(record['pending'] or
                     {'request': key, 'owner_epoch': EPOCH, 'selected_release_sha256': RELEASE}, status=record['phase'])
            future = record['future']
        if request.method == 'DELETE':
            record['cancel'].set()
            if future is not None:
                future.cancel()
            return JSONResponse({'request': key, 'owner_epoch': EPOCH, 'retirement_acknowledged': False}, headers={'Cache-Control': 'no-store'})
        return JSONResponse(value, headers={'Cache-Control': 'no-store'})
    if request.method == 'POST' and path in ('v1/runtime/drain', 'v1/runtime/resume'):
        key = request.headers.get('x-raya-drain-id')
        if not hex(key, 32):
            return fail('invalid_drain_id', 'Provide a lowercase hexadecimal drain ID.', 400)
        with GUARD:
            if DRAIN['until'] > time.monotonic() and DRAIN['id'] != key:
                return fail('drain_conflict', 'Another owner holds the drain lease.', 409)
            DRAIN.update(id=key, until=time.monotonic()+60 if path.endswith('/drain') else 0)
            value = {'draining': DRAIN['until'] > time.monotonic(), 'active': ACTIVE, 'lease_seconds': 60}
        return JSONResponse(value, headers={'Cache-Control': 'no-store'})
    if request.method != 'POST' or path not in ('v1/memory/search', 'v1/memory/sync'):
        return fail('not_found', 'Route not found.', 404)
    key = request.headers.get('x-raya-memory-request-id')
    if not hex(key, 32):
        return fail('invalid_request_id', 'Provide the original request identity.', 400)
    if request.headers.get('content-type', '').split(';')[0] != 'application/json':
        return fail('unsupported_media', 'Use application/json.', 415)
    async def read():
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 16000:
                raise ValueError('Request exceeds 16 KB.')
        return decode(bytes(raw), 16000)
    try:
        body = await asyncio.wait_for(read(), 15)
        if not isinstance(body, dict):
            raise ValueError('Expected an object.')
        kind = path.rsplit('/', 1)[1]
        if kind == 'search':
            body = search(body)
            budget = body.get('context_budget')
            work = (lambda: {'results': [], 'context': INDEX.context(body['query'], budget, body['top']), 'capture_enabled': False}) if budget is not None else (lambda: {'results': INDEX.search(body['query'], body['top']), 'capture_enabled': False})
        else:
            if set(body)-{'force_rebuild', 'expected_policy_sha256'} or type(body.get('force_rebuild', False)) is not bool or not hex(body.get('expected_policy_sha256'), 64):
                raise ValueError('Provide the exact confirmed policy fingerprint and boolean rebuild flag.')
            body = {'force_rebuild': body.get('force_rebuild', False), 'expected_policy_sha256': body['expected_policy_sha256']}
            work = lambda: INDEX.sync(force=body['force_rebuild'], expected=body['expected_policy_sha256'])
        if len(canonical(body)) > 16000:
            raise ValueError('Canonical request exceeds 16 KB.')
    except (ValueError, UnicodeDecodeError) as error:
        return fail('invalid_request', str(error), 422)
    except asyncio.TimeoutError:
        return fail('request_timeout', 'Request body timed out.', 408)
    with GUARD:
        if UNCERTAIN or DRAIN['until'] > time.monotonic():
            return fail('admission_closed', 'Memory admission is closed.', 503)
        if key in RECORDS:
            return fail('duplicate_request', 'Inspect the original request; do not resubmit it.', 409)
        if len(RECORDS) >= 256 or not SLOTS.acquire(blocking=False):
            return fail('queue_full', 'Memory owner has no admission capacity.', 429)
        record = {'request': key, 'phase': 'reserving', 'cancel': threading.Event(), 'proofs': [],
                  'pending': None, 'terminal': None, 'future': None, 'publication': None,
                  'reservation': None, 'faults': []}
        RECORDS[key] = record
        ACTIVE += 1
    try:
        future = await admit(record, key, kind, body, work)
    except BaseException as error:
        fence(record, error)
        return fail('inspection_required', 'Memory reservation/submission is unconfirmed; inspect this original request.', 503)
    async def observe():
        while not future.done():
            if await request.is_disconnected():
                record['cancel'].set()
                future.cancel()
                return
            await asyncio.sleep(0.05)
    observer = asyncio.create_task(observe())
    try:
        result = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(future)), 180)
        # Callback scheduling is distinct from inference settlement.
        until = time.monotonic()+30
        while record['publication'] is None:
            if record['faults'] or time.monotonic() >= until:
                raise Retirement('Original publication was not observed.')
            await asyncio.sleep(0.01)
        terminal = await asyncio.wait_for(asyncio.shield(asyncio.wrap_future(record['publication'])), max(0.01, until-time.monotonic()))
        if record['cancel'].is_set() or terminal['operation_outcome'] != 'completed' or terminal.get('result_sha256') != fingerprint(result):
            raise Retirement('Completed operation/result correlation is unconfirmed.')
        return JSONResponse(dict(result, operation=terminal), headers={'Cache-Control': 'no-store'})
    except (Cancelled, asyncio.CancelledError):
        record['cancel'].set()
        return fail('cancelled', 'Inspect the original request for its terminal publication.', 499)
    except asyncio.TimeoutError as error:
        fence(record, error)
        return fail('timeout', 'Original work/publication remains retained; inspect the same request.', 504)
    except Exception:
        return fail('memory_failed', 'Memory failed; inspect the original request outcome and ownership.', 503)
    finally:
        if not future.done():
            record['cancel'].set()
            future.cancel()
        observer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await observer


if __name__ == '__main__':
    import uvicorn
    try:
        uvicorn.run(app, host='127.0.0.1', port=PORT, access_log=False)
    finally:
        POOL.shutdown(wait=True, cancel_futures=True)
        with GUARD:
            reviews = tuple(REVIEWS)
        STORAGE.shutdown(wait=True, cancel_futures=False)
        for future in reviews:
            if future.exception() is not None and not isinstance(future.exception(), ValueError):
                raise Retirement('Proposal storage publication remains unconfirmed.') from future.exception()
        if REVIEW_ERRORS:
            raise BaseExceptionGroup('Proposal storage publication remains unconfirmed.', REVIEW_ERRORS)
        errors = [error for record in RECORDS.values() for error in record['faults']]
        for record in RECORDS.values():
            for name in ('reservation', 'publication'):
                future = record[name]
                if future is None:
                    if name == 'publication' and not record['faults']:
                        errors.append(Retirement('Original publication Future is missing.'))
                    continue
                try:
                    future.result()
                except BaseException as error:
                    errors.append(error)
        if errors:
            raise BaseExceptionGroup('Memory ownership remains unconfirmed.', errors)
