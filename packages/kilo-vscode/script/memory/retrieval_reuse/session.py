"""Unselected v2 retained native owner; no creation occurs on import."""
import ctypes
from ctypes import wintypes as w
import json
from pathlib import Path
import struct
import threading
import time

from owner import BASE, HERE as SOURCE, Limits, Owner as Finite, checked
from lease import INPUT, OUTPUT, Lease
from living import accept
from validation import canonical, decode, fingerprint

HERE = Path(__file__).resolve().parent
PINS = {'interpreter': 'b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2',
        'bootstrap': 'cc424607c0b6d9b8565602d11027a4e1c65e769d06af8eaa89b581ec7ff30a6a',
        'worker': 'f5ba90a93cdb55aecef91ba0017a30cc824719c0e840aacf0e5f2026a72fb039',
        'models': '2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873',
        'lease': '308eeeab2ffbd8ae1e7db9b1da238c442829aec0cd1ab9ea5202a8d8e3412a3d',
        'validation': '905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2',
        'support': '530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d',
        'finite': 'fb629212836e2958df0beb49fbc6b56fa38da7956d81eac06f8aeaa9ecf6a446',
        'living': 'bc75c4be4d9ced06e9bca4c2408430a1d1fb084a827762e81a3b5ec0043d261a'}


class Owner(Finite):
    def __init__(self, lease, epoch, release, kind, model, cancel, fence, namespace, idle=90, lifetime=600):
        if (type(idle) not in (int, float) or not 0 < idle <= 90 or
                type(lifetime) is not int or not 1 <= lifetime <= 600):
            raise ValueError('lease_lifetime_bounds')
        self.lease = Lease(lease, epoch, release, kind, model)
        self.model = model
        self.kind = kind
        self.release = release
        self.mutex = threading.Lock()
        self.pending = None
        self.reply = None
        self.buffer = bytearray()
        self.frames = 0
        self.closed = False
        self.ready = False
        self.last = time.monotonic()
        self.idle = idle
        super().__init__(lease, epoch, kind, {'model': model}, cancel, self.last + lifetime, fence, namespace)
        self.condition = threading.Condition(self.lock)
        self.library.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.library.TerminateJobObject.restype = w.BOOL
        self.state.update(version=2, scope='unselected_retrieval_reuse_candidate')

    def images(self):
        return {'interpreter': BASE, 'bootstrap': HERE/'bootstrap.py', 'worker': HERE/'resident.py',
                'models': SOURCE/'models.py', 'lease': HERE/'lease.py', 'validation': SOURCE/'validation.py',
                'support': SOURCE/'bootstrap.py', 'finite': SOURCE/'owner.py', 'living': HERE/'living.py'}, PINS

    def command(self, selection):
        return [str(BASE), '-I', '-S', '-B', '-u', str(HERE/'bootstrap.py'),
                str(self.handles['control_read']), self.request, self.epoch, selection,
                self.release, self.kind, self.model]

    def admission(self, selection):
        return (json.dumps({'format': 'raya.worker.lease.start', 'version': 2, 'lease': self.request,
                            'owner_epoch': self.epoch, 'selection_sha256': selection,
                            'selected_release_sha256': self.release, 'kind': self.kind,
                            'model': self.model, 'limit': 32}, separators=(',', ':')) + '\n').encode('utf-8')

    def limits(self):
        value = Limits()
        value.basic.flags = 0x2000  # Original job close retires children if the owner process dies.
        return value

    def send(self):
        try:
            written = w.DWORD()
            checked(self.library.WriteFile(self.handles['control_write'], self.frame, len(self.frame), ctypes.byref(written), None), 'WriteFile_lease_start')
            if written.value != len(self.frame):
                raise ValueError('lease_partial_start')
            self.state.update(frame_written=True, phase='lease_started', work_admitted=True)
        except Exception as error:
            self.failure(error, 'lease_start_write')
            self.expire()
        finally:
            self.close('control_write')
            self.state.update(write_operation='returned', writer_returned=True)
            try:
                self.publish()
            except Exception as error:
                self.failure(error, 'lease_start_publication')
                self.expire()

    def consume(self, name, raw):
        if name != 'output':
            super().consume(name, raw)
            return
        with self.condition:
            row = self.readers[name]
            row['bytes'] += len(raw)
            if len(raw) > 4096 or row['bytes'] > (OUTPUT + 4) * self.lease.limit + 1024:
                raise ValueError('lease_output_bound')
            self.buffer.extend(raw)
            while len(self.buffer) >= 4:
                length = struct.unpack('!I', self.buffer[:4])[0]
                if not 1 <= length <= OUTPUT:
                    raise ValueError('lease_output_frame_bound')
                if len(self.buffer) < length + 4:
                    return
                value = decode(bytes(self.buffer[4:length + 4]), OUTPUT)
                del self.buffer[:length + 4]
                if not self.ready:
                    expected = {'format': 'raya.retrieval.lease.ready', 'version': 2,
                                'lease': self.request, 'owner_epoch': self.epoch,
                                'selection_sha256': self.state['selection_sha256'],
                                'selected_release_sha256': self.release, 'kind': self.kind,
                                'model': self.model, 'limit': 32}
                    if (length > 1020 or value != expected or
                            type(value.get('version')) is not int or type(value.get('limit')) is not int):
                        raise ValueError('lease_ready_identity')
                    self.ready = True
                    self.condition.notify_all()
                    continue
                if self.pending is None or self.reply is not None or self.frames >= self.lease.limit:
                    raise ValueError('lease_unsolicited_output')
                self.frames += 1
                self.reply = value
                self.condition.notify_all()

    def start(self, cancel=None, until=None, pressure=None):
        if not self.mutex.acquire(blocking=False):
            raise ValueError('lease_owner_busy')
        try:
            if self.created or self.closed:
                raise ValueError('lease_owner_already_started')
            try:
                deadline = min(self.until, time.monotonic() + 30)
                if until is not None:
                    if type(until) not in (int, float) or not time.monotonic() < until <= time.monotonic() + 150:
                        raise ValueError('lease_start_deadline')
                    deadline = min(deadline, until)

                def admit():
                    if time.monotonic() >= deadline or self.cancel.is_set() or (cancel is not None and cancel.is_set()):
                        raise ValueError('lease_start_expired')
                    if pressure is not None and pressure():
                        raise ValueError('lease_memory_pressure')

                admit()
                self.spawn()
                while not self.ready or (self.writer is not None and self.writer.is_alive()):
                    admit()
                    if (time.monotonic() >= deadline or self.cancel.is_set() or self.errors or
                            self.library.WaitForSingleObject(self.handles['process'], 0) != 258 or
                            any(row['errors'] for row in self.readers.values())):
                        raise ValueError('lease_start_expired')
                    with self.condition:
                        self.condition.wait(0.01)
                admit()
                if self.errors or not self.state.get('frame_written') or 'control_write' in self.handles:
                    raise ValueError('lease_start_unconfirmed')
                self.last = time.monotonic()
                return dict(self.state)
            except Exception as error:
                self.failure(error, 'lease_start')
                self.finish(True)
                raise
        finally:
            self.mutex.release()

    def run(self):
        raise ValueError('retained_owner_requires_start_and_retire')

    def write(self, raw):
        try:
            offset = 0
            while offset < len(raw):
                count = w.DWORD()
                checked(self.library.WriteFile(self.handles['input_write'], raw[offset:], len(raw) - offset, ctypes.byref(count), None), 'WriteFile_lease_request')
                if not 0 < count.value <= len(raw) - offset:
                    raise ValueError('lease_partial_request')
                offset += count.value
        except Exception as error:
            self.failure(error, 'lease_request_write')
            self.cancel.set()
        finally:
            with self.condition:
                self.condition.notify_all()

    def exchange(self, request, body, revision, cancel, until, pressure=None):
        if not self.mutex.acquire(blocking=False):
            raise ValueError('lease_owner_busy')
        try:
            if self.closed or not self.created or self.cancel.is_set() or cancel.is_set() or time.monotonic() >= self.until:
                raise ValueError('lease_owner_closed')
            if not time.monotonic() < until <= min(self.until, time.monotonic() + 150):
                raise ValueError('lease_request_deadline')
            if pressure is not None and pressure():
                raise ValueError('lease_memory_pressure')
            frame = {'format': 'raya.retrieval.lease.request', 'version': 2, 'lease': self.request,
                     'owner_epoch': self.epoch, 'selected_release_sha256': self.release,
                     'sequence': self.lease.sequence + 1, 'request': request,
                     'request_sha256': fingerprint(body), 'kind': self.kind, 'body': body}
            raw = canonical(frame, INPUT)
            with self.condition:
                self.lease.request(frame)
                self.pending = request
                self.reply = None
            self.writer = threading.Thread(target=self.write, args=(struct.pack('!I', len(raw)) + raw,), daemon=False)
            self.writer.start()
            while True:
                with self.condition:
                    if (cancel.is_set() or self.cancel.is_set() or self.errors or
                            any(row['errors'] for row in self.readers.values()) or time.monotonic() >= until):
                        raise ValueError('lease_request_cancelled_or_expired')
                    if pressure is not None and pressure():
                        raise ValueError('lease_memory_pressure')
                    if self.reply is not None and not self.writer.is_alive():
                        paths, pins = self.images()
                        images = {name: {'path': path, 'sha256': pins[name], 'observed': self.state['sources'][name]}
                                  for name, path in paths.items()}
                        birth = {key: self.state['worker'][key] for key in ('birth_filetime', 'image')}
                        value = accept(self.lease, body, self.reply, revision, self.library,
                                       self.handles['process'], self.handles['job'], birth, images)
                        self.writer.join()
                        self.pending = None
                        self.reply = None
                        self.last = time.monotonic()
                        return value
                    if self.library.WaitForSingleObject(self.handles['process'], 0) != 258:
                        raise ValueError('lease_worker_exited')
                    self.condition.wait(0.01)
        except Exception as error:
            self.failure(error, 'lease_exchange')
            self.finish(True)
            raise
        finally:
            self.mutex.release()

    def finish(self, force):
        # Caller owns the exchange mutex. Retain cleanup until original joins;
        # the base owner fences an expired observation rather than permitting replacement.
        if self.closed:
            return dict(self.state)
        self.closed = True
        if force:
            self.cancel.set()
            if self.created:
                try:
                    checked(self.library.TerminateJobObject(self.handles['job'], 1), 'TerminateJobObject_lease')
                except Exception as error:
                    self.failure(error, 'lease_retirement')
                    self.expire()
        if self.writer is not None and self.writer.ident is not None:
            self.writer.join()
        self.close('control_write')
        self.close('input_write')
        return self.cleanup()

    def retire(self, force=False):
        if force:
            self.cancel.set()
        if not self.mutex.acquire(blocking=force):
            return None
        try:
            return self.finish(force)
        finally:
            self.mutex.release()

    def tick(self):
        now = time.monotonic()
        if now >= self.until:
            return self.retire(True)
        if now - self.last >= self.idle or self.lease.sequence >= self.lease.limit:
            return self.retire()
        return None
