"""Unselected bounded retrieval scheduler; one original coordinator and owner."""
from collections import deque
import ctypes
from ctypes import wintypes as w
import re
import threading
import time
from types import MappingProxyType
import uuid

from lease import Lease
from resident import Resident
from session import Owner
from validation import canonical, decode

GIB = 1024 ** 3


def available():
    class Status(ctypes.Structure):
        _fields_ = [('length', w.DWORD), ('load', w.DWORD)] + [(name, ctypes.c_ulonglong) for name in
                    ('total', 'free', 'paging', 'available_paging', 'virtual', 'available_virtual', 'extended')]
    value = Status()
    value.length = ctypes.sizeof(value)
    library = ctypes.WinDLL('kernel32', use_last_error=True)
    library.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(Status)]
    library.GlobalMemoryStatusEx.restype = w.BOOL
    if not library.GlobalMemoryStatusEx(ctypes.byref(value)):
        raise OSError(ctypes.get_last_error(), 'GlobalMemoryStatusEx_retrieval')
    return value.free


class Ticket:
    def __init__(self, kind, body, until):
        self.request = uuid.uuid4().hex
        self.kind = kind
        self.body = body
        self.until = until
        self.cancel = threading.Event()
        self.done = threading.Event()
        self.result = None
        self.error = None


class Pool:
    def __init__(self, epoch, release, revisions, namespace, reserve=6 * GIB):
        if (not isinstance(revisions, dict) or not revisions or
                set(revisions) - {'embeddinggemma-2', 'qwen3-embedding-0.6b', 'qwen3-reranker-0.6b'} or
                any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{40}', value) for value in revisions.values()) or
                type(reserve) is not int or reserve < 6 * GIB):
            raise ValueError('pool_selection')
        name = next(iter(revisions))
        Lease(uuid.uuid4().hex, epoch, release, 'rerank' if name == 'qwen3-reranker-0.6b' else 'embeddings', name)
        namespace.check()
        self.epoch = epoch
        self.release = release
        self.revisions = MappingProxyType(dict(revisions))
        self.namespace = namespace
        self.reserve = reserve
        self.slots = threading.BoundedSemaphore(4)
        self.condition = threading.Condition()
        self.queue = deque()
        self.active = None
        self.owner = None
        self.thread = None
        self.stop = threading.Event()
        self.fenced = False
        self.errors = deque(maxlen=16)

    def pressure(self):
        return available() < self.reserve

    def fence(self):
        with self.condition:
            self.fenced = True
            self.stop.set()
            if self.active is not None:
                self.active.cancel.set()
            self.condition.notify_all()

    def submit(self, kind, body, until):
        if type(until) not in (int, float) or not time.monotonic() < until <= time.monotonic() + 150:
            raise ValueError('pool_deadline')
        with self.condition:
            if self.stop.is_set() or self.fenced:
                raise ValueError('pool_admission_closed')
            if not self.slots.acquire(blocking=False):
                raise ValueError('pool_capacity')
        try:
            snapshot = decode(canonical(body, 300000), 300000)
            model = snapshot.get('model') if isinstance(snapshot, dict) else None
            if not isinstance(model, str) or model not in self.revisions:
                raise ValueError('pool_model_not_selected')
            Resident(kind, model).check(snapshot)
            canonical({'format': 'raya.retrieval.lease.request', 'version': 2, 'lease': '0' * 32,
                       'owner_epoch': self.epoch, 'selected_release_sha256': self.release, 'sequence': 32,
                       'request': '0' * 32, 'request_sha256': '0' * 64, 'kind': kind, 'body': snapshot}, 300000)
            with self.condition:
                if self.stop.is_set() or self.fenced:
                    raise ValueError('pool_admission_closed')
                ticket = Ticket(kind, snapshot, until)
                self.queue.append(ticket)
                self.condition.notify_all()
                return ticket
        except Exception:
            self.slots.release()
            raise

    def start(self):
        with self.condition:
            if self.thread is not None or self.stop.is_set():
                raise ValueError('pool_already_started_or_closed')
            self.thread = threading.Thread(target=self.serve, daemon=False)
            self.thread.start()

    def retire(self, force):
        if self.owner is None:
            return
        receipt = self.owner.retire(force)
        if (receipt is None or receipt.get('phase') != 'terminal' or receipt.get('cleanup_outcome') != 'joined' or
                receipt.get('joins_observed') is not True or self.owner.handles):
            self.fence()
            raise ValueError('pool_retirement_unconfirmed')
        self.owner = None

    def invoke(self, ticket):
        if ticket.cancel.is_set() or self.stop.is_set() or time.monotonic() >= ticket.until:
            raise ValueError('pool_before_dispatch_cancelled_or_expired')
        model = ticket.body['model']
        if self.owner is not None:
            expired = time.monotonic() >= self.owner.until
            if (self.owner.closed or expired or self.owner.lease.sequence >= self.owner.lease.limit or
                    time.monotonic() - self.owner.last >= self.owner.idle or
                    self.owner.model != model or self.owner.kind != ticket.kind):
                self.retire(expired)
        # The clean Gemma runtime exceeded the earlier 3.25 GiB loading margin
        # in a guarded live attempt. Keep the reserve and require more cold room.
        headroom = GIB // 2 if self.owner is not None else (5 * GIB if model == 'embeddinggemma-2' else 13 * GIB // 4)
        if available() < self.reserve + headroom:
            if self.owner is not None:
                self.retire(True)
            raise ValueError('pool_memory_reserve')
        if self.owner is None:
            self.owner = Owner(uuid.uuid4().hex, self.epoch, self.release, ticket.kind, model,
                               threading.Event(), self.fence, self.namespace)
            self.owner.start(ticket.cancel, ticket.until, self.pressure)
        if ticket.cancel.is_set() or self.stop.is_set() or time.monotonic() >= ticket.until:
            self.retire(True)
            raise ValueError('pool_before_inference_cancelled_or_expired')
        value = self.owner.exchange(ticket.request, ticket.body, self.revisions[model],
                                    ticket.cancel, min(ticket.until, self.owner.until), self.pressure)
        if ticket.cancel.is_set() or self.stop.is_set() or time.monotonic() >= ticket.until:
            self.retire(True)
            raise ValueError('pool_delivery_cancelled_or_expired')
        return value

    def complete(self, ticket, error=None, result=None):
        with self.condition:
            if result is not None and (ticket.cancel.is_set() or self.stop.is_set() or time.monotonic() >= ticket.until):
                error, result = 'pool_delivery_cancelled_or_expired', None
            ticket.error = error
            ticket.result = result
            ticket.body = None
            if self.active is ticket:
                self.active = None
            self.slots.release()
            ticket.done.set()
            self.condition.notify_all()

    def drain(self):
        while self.queue:
            ticket = self.queue.popleft()
            ticket.cancel.set()
            self.complete(ticket, 'pool_closed')

    def serve(self):
        try:
            while True:
                with self.condition:
                    if self.stop.is_set():
                        self.drain()
                        break
                    ticket = self.queue.popleft() if self.queue else None
                    self.active = ticket
                    if ticket is None:
                        self.condition.wait(0.1)
                if ticket is None:
                    if self.owner is not None:
                        if self.pressure():
                            self.retire(True)
                        else:
                            receipt = self.owner.tick()
                            if receipt is not None:
                                self.retire(False)
                    continue
                try:
                    if ticket.cancel.is_set():
                        raise ValueError('pool_queue_cancelled')
                    if time.monotonic() >= ticket.until:
                        raise ValueError('pool_queue_expired')
                    result = self.invoke(ticket)
                except Exception as error:
                    if self.owner is not None and self.owner.closed:
                        self.retire(True)
                    self.complete(ticket, str(error) if isinstance(error, ValueError) else 'pool_worker_failed')
                    continue
                self.complete(ticket, result=result)
        except Exception as error:
            self.errors.append({'phase': 'coordinator', 'type': type(error).__name__})
            self.fence()
            with self.condition:
                if self.active is not None:
                    self.complete(self.active, 'pool_fenced')
                self.drain()
        finally:
            if self.owner is not None:
                try:
                    self.retire(True)
                except Exception as error:
                    self.errors.append({'phase': 'retirement', 'type': type(error).__name__})
                    self.fence()

    def close(self):
        with self.condition:
            self.stop.set()
            if self.active is not None:
                self.active.cancel.set()
            if self.thread is None or self.thread.ident is None:
                self.drain()
            self.condition.notify_all()
        if self.thread is not None and self.thread.ident is not None:
            self.thread.join()
        return {'closed': self.owner is None and (self.thread is None or not self.thread.is_alive()),
                'fenced': self.fenced, 'original_coordinator_joined': self.thread is None or not self.thread.is_alive(),
                'ownership_retained': self.owner is not None}
