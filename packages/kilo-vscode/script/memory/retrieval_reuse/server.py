"""Unselected v2 API factory; caller must admit the complete protected cohort."""
import asyncio
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
import re
import secrets
import threading
import time
import uuid

from owner import selected
from pool import Pool, available
from receipts import completion, failure
from validation import canonical, decode, fingerprint

ROOT = Path(__file__).resolve().parent.parent
IMAGES = {'retrieval/'+name+'.py' for name in ('bootstrap', 'models', 'namespace', 'owner', 'server', 'validation', 'worker')}
IMAGES |= {'retrieval_reuse/'+name+'.py' for name in ('bootstrap', 'lease', 'living', 'pool', 'receipts', 'resident', 'server', 'session')}
CATALOGS = {'Qwen--Qwen3-Embedding-0.6B.json': '60cae741077a5b3f79f531c139674a1461bda80a5fb8ca767ec1a9ba25975b7d',
            'Qwen--Qwen3-Reranker-0.6B.json': 'ef8b5bbc099e513ad2ddcd0d20e1ce0006a87e1701228631652d278eecb3f0a3',
            'google--embeddinggemma-2.json': '7f28a34d9d8e9cc67372be2bc8d1c5ad4e386914e59aa18ae7351e1e95646f54'}


class Runtime:
    def __init__(self, pool, namespace, images, catalogs, token, port=8873):
        if (not isinstance(pool, Pool) or pool.namespace is not namespace or
                not isinstance(images, dict) or not images or not isinstance(catalogs, dict) or not catalogs or
                not isinstance(token, str) or not 32 <= len(token) <= 1024 or
                type(port) is not int or not 1024 <= port <= 65535):
            raise ValueError('reuse_runtime_selection')
        self.pool = pool
        self.namespace = namespace
        self.images = dict(images)
        self.catalogs = dict(catalogs)
        self.sources = {name: digest for name, (_, digest) in self.images.items()}
        self.manifests = {name: digest for name, (_, digest) in self.catalogs.items()}
        if (set(self.sources) != IMAGES or self.manifests != CATALOGS or
                any(path.resolve() != (ROOT/name).resolve() for name, (path, _) in self.images.items()) or
                any(path.resolve() != (Path('D:/Raya/Models/Catalog')/name).resolve()
                    for name, (path, _) in self.catalogs.items())):
            raise ValueError('reuse_runtime_inventory')
        if fingerprint({'source_sha256': self.sources, 'catalog_sha256': self.manifests}, 65536) != pool.release:
            raise ValueError('reuse_runtime_release')
        self.token = token
        self.port = port
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(4)
        self.admissions = 0
        self.records = {}
        self.errors = deque(maxlen=16)
        self.fenced = False
        self.draining = False
        self.integrity()
        if any(any((namespace.root/kind).rglob('*.json')) for kind in ('Runs', 'Requests')):
            raise ValueError('reuse_runtime_prior_receipts')

    def integrity(self):
        self.namespace.check()
        for path, digest in (*self.images.values(), *self.catalogs.values()):
            selected(path, digest)

    def fence(self):
        self.fenced = True
        self.pool.fence()

    def publish(self, key, row):
        self.integrity()
        folder = self.namespace.folder('Requests', self.pool.epoch)
        self.namespace.publish(folder, key+'-'+uuid.uuid4().hex+'.json', canonical(row, 65536))

    def settle(self, record):
        with self.lock:
            ticket = record.get('ticket')
            if record.get('settlement') is not None or ticket is None or not ticket.done.is_set():
                return
            try:
                if ticket.result is not None:
                    output, observation = ticket.result
                    proof = completion(record['identity'], output, observation)
                else:
                    proof = failure(record['identity'], 'cancelled' if ticket.cancel.is_set() else 'failed', ticket.owner)
                self.publish(ticket.request, proof)
                record['settlement'] = proof
                record['ticket'] = None
                self.release()
            except Exception:
                self.fence()
                raise

    def reap(self):
        with self.lock:
            for record in self.records.values():
                self.settle(record)

    def release(self):
        with self.lock:
            if self.admissions <= 0:
                self.fence()
                raise ValueError('reuse_admission_ownership')
            self.slots.release()
            self.admissions -= 1

    def pause(self):
        with self.lock:
            self.integrity()
            self.reap()
            if self.fenced or self.pool.fenced:
                raise ValueError('reuse_drain_unavailable')
            self.draining = True
            self.pool.pause()

    def quiet(self):
        with self.lock:
            self.integrity()
            self.reap()
            return (self.draining and self.pool.quiet() and self.admissions == 0 and not self.fenced and
                    all(record.get('settlement') is not None for record in self.records.values()))

    def resume(self):
        with self.lock:
            if not self.quiet():
                raise ValueError('reuse_original_drain_unconfirmed')
            self.pool.resume()
            self.draining = False

    def health(self):
        try:
            self.integrity()
            self.reap()
        except Exception:
            self.fence()
        running = self.pool.thread is not None and self.pool.thread.is_alive() and not self.pool.stop.is_set()
        return {'ready': running and not self.fenced and not self.pool.fenced and not self.draining,
                'retirement_unconfirmed': self.fenced or self.pool.fenced,
                'draining': self.draining, 'ownership_protocol': 'raya.retrieval.request.settlement.v2',
                'owner_epoch': self.pool.epoch, 'selected_release_sha256': self.pool.release,
                'source_sha256': self.sources, 'catalog_sha256': self.manifests, 'device': 'cpu',
                'errors': list(self.errors),
                'active': sum(record.get('settlement') is None for record in self.records.values()),
                'available_ram_bytes': available(), 'minimum_available_ram_bytes': self.pool.reserve}

    def close(self):
        self.draining = True
        value = self.pool.close()
        try:
            self.reap()
        except Exception:
            self.fence()
        if not value['closed'] or value['fenced'] or value['ownership_retained'] or self.admissions != 0:
            self.fence()
        return dict(value, request_publications_confirmed=not self.fenced,
                    request_admissions_joined=self.admissions == 0)


def create(runtime):
    # Framework imports occur only after the caller admits the dependency cohort.
    from fastapi import FastAPI, Request
    from starlette.responses import JSONResponse

    @asynccontextmanager
    async def lifetime(app):
        runtime.integrity()
        runtime.pool.start()
        try:
            yield
        finally:
            runtime.close()

    app = FastAPI(lifespan=lifetime, docs_url=None, redoc_url=None, openapi_url=None)

    def reply(value, status=200):
        return JSONResponse(value, status_code=status, headers={'Cache-Control': 'no-store'})

    def fail(code, status):
        return reply({'error': {'code': code}}, status)

    @app.api_route('/{path:path}', methods=['GET', 'POST', 'DELETE'])
    async def handle(request: Request, path: str):
        if request.headers.get('host') not in {f'127.0.0.1:{runtime.port}', f'localhost:{runtime.port}'} or request.headers.get('origin'):
            return fail('forbidden_origin', 403)
        if not secrets.compare_digest(request.headers.get('authorization', ''), 'Bearer '+runtime.token):
            return fail('unauthorized', 401)
        if request.method == 'GET' and path == 'health':
            return reply(runtime.health())
        if request.headers.get('x-raya-owner-epoch') != runtime.pool.epoch:
            return fail('owner_epoch_changed', 409)
        if request.method == 'POST' and path in ('v2/drain', 'v2/resume'):
            try:
                if path == 'v2/resume':
                    runtime.resume()
                else:
                    runtime.pause()
                    until = time.monotonic()+15
                    while not runtime.quiet():
                        if runtime.fenced or runtime.pool.fenced:
                            return fail('drain_unconfirmed', 503)
                        if time.monotonic() >= until:
                            runtime.fence()
                            return fail('drain_observation_expired', 503)
                        await asyncio.sleep(0.01)
                return reply({'format': 'raya.retrieval.lifecycle.v2', 'owner_epoch': runtime.pool.epoch,
                              'selected_release_sha256': runtime.pool.release, 'draining': runtime.draining,
                              'original_coordinator_retained': runtime.pool.thread.is_alive(),
                              'original_worker_retired': runtime.pool.owner is None,
                              'request_publications_confirmed': not runtime.fenced,
                              'request_admissions_joined': runtime.admissions == 0})
            except Exception:
                return fail('lifecycle_unconfirmed', 503)
        if request.method in ('GET', 'DELETE') and path.startswith('v2/requests/'):
            key = path.removeprefix('v2/requests/')
            if not re.fullmatch('[a-f0-9]{32}', key):
                return fail('invalid_request_id', 400)
            with runtime.lock:
                record = runtime.records.get(key)
                if record is None:
                    return fail('request_unknown', 404)
                if request.method == 'DELETE':
                    ticket = record.get('ticket')
                    if ticket is not None:
                        ticket.cancel.set()
                    return reply({'request': key, 'owner_epoch': runtime.pool.epoch,
                                  'cancel_requested': True, 'settlement_acknowledged': False})
                try:
                    runtime.settle(record)
                except Exception:
                    return fail('settlement_unconfirmed', 503)
                return reply(record.get('settlement') or {**record['identity'], 'phase': 'pending',
                             'format': 'raya.retrieval.request.reservation', 'version': 2})
        if request.method != 'POST' or path not in ('v2/embeddings', 'v2/rerank'):
            return fail('not_found', 404)
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            return fail('unsupported_media', 415)
        key = request.headers.get('x-raya-request-id', '')
        budget = request.headers.get('x-raya-timeout-ms', '150000')
        if not re.fullmatch('[a-f0-9]{32}', key):
            return fail('invalid_request_id', 400)
        if not re.fullmatch('[0-9]{1,6}', budget) or not 1 <= int(budget) <= 150000:
            return fail('invalid_timeout', 400)
        try:
            runtime.integrity()
            runtime.reap()
        except Exception:
            runtime.fence()
            return fail('integrity_or_settlement_unconfirmed', 503)
        if (runtime.fenced or runtime.pool.fenced or runtime.draining or runtime.pool.thread is None or
                not runtime.pool.thread.is_alive() or runtime.pool.stop.is_set()):
            return fail('admission_closed', 503)
        with runtime.lock:
            if runtime.draining or runtime.fenced or runtime.pool.fenced:
                return fail('admission_closed', 503)
            if not runtime.slots.acquire(blocking=False):
                return fail('queue_full', 429)
            runtime.admissions += 1
        ticket = None
        record = None
        try:
            async def read():
                raw = bytearray()
                async for part in request.stream():
                    if len(raw) + len(part) > 300000:
                        raise ValueError('request_bound')
                    raw.extend(part)
                return decode(bytes(raw), 300000)
            body = await asyncio.wait_for(read(), 15)
            kind = 'embeddings' if path.endswith('/embeddings') else 'rerank'
            model = body.get('model') if isinstance(body, dict) else None
            if not isinstance(model, str) or model not in runtime.pool.revisions:
                return fail('unsupported_model', 422)
            body = runtime.pool.prepare(kind, body)
            until = time.monotonic() + int(budget)/1000
            with runtime.lock:
                if runtime.draining or runtime.fenced or runtime.pool.fenced:
                    return fail('admission_closed', 503)
                if key in runtime.records or len(runtime.records) >= 256:
                    return fail('request_reserved_or_capacity', 409)
                record = {'identity': {'request': key, 'owner_epoch': runtime.pool.epoch,
                          'selected_release_sha256': runtime.pool.release, 'request_sha256': fingerprint(body)},
                          'ticket': None, 'settlement': None}
                runtime.records[key] = record
                runtime.publish(key, {**record['identity'], 'format': 'raya.retrieval.request.reservation',
                                      'version': 2, 'phase': 'pending'})
                ticket = runtime.pool.submit(kind, body, until, key)
                record['ticket'] = ticket
            while not ticket.done.is_set():
                if await request.is_disconnected():
                    ticket.cancel.set()
                    return fail('caller_disconnected_cleanup_pending', 499)
                if time.monotonic() >= until + 10:
                    ticket.cancel.set()
                    runtime.fence()
                    return fail('settlement_observation_expired', 503)
                await asyncio.sleep(0.01)
            runtime.settle(record)
            if ticket.result is None:
                code, status = (('cancelled', 499) if ticket.cancel.is_set() else
                                ('memory_pressure', 503) if ticket.error in ('pool_memory_reserve', 'lease_memory_pressure') else
                                ('timeout', 504) if ticket.error in ('pool_queue_expired', 'pool_before_dispatch_cancelled_or_expired') else
                                ('inference_failed', 500))
                return reply({'error': {'code': code}, 'settlement': record['settlement']}, status)
            output, _ = ticket.result
            return reply(dict(output, settlement=record['settlement']))
        except asyncio.CancelledError:
            if ticket is not None:
                ticket.cancel.set()
            raise
        except (ValueError, UnicodeError, TypeError):
            if record is not None:
                runtime.fence()
                return fail('reservation_or_submission_unconfirmed', 503)
            return fail('invalid_input', 422)
        except asyncio.TimeoutError:
            return fail('body_timeout', 408)
        except Exception:
            runtime.fence()
            return fail('settlement_unconfirmed', 503)
        finally:
            if ticket is None:
                runtime.release()
            elif ticket.done.is_set():
                try:
                    runtime.settle(record)
                except Exception as err:
                    runtime.errors.append({'phase': 'delivery_cleanup', 'type': type(err).__name__})
                    runtime.fence()
                if record.get('settlement') is not None:
                    ticket.result = None

    return app
