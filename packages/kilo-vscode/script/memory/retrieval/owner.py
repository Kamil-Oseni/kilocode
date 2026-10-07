"""Source-only reviewed ordinary-worker owner; importing does not create a child."""
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BASE = ROOT/'python'/'python.exe'
ENV = {'SystemRoot': 'C:\\Windows', 'HOME': str(ROOT/'home'), 'USERPROFILE': str(ROOT/'home'), 'TEMP': str(ROOT/'tmp'), 'TMP': str(ROOT/'tmp'), 'HF_HOME': str(ROOT/'hf'), 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_PROGRESS_BARS': '1', 'CUDA_VISIBLE_DEVICES': '-1'}
BOOT = HERE/'bootstrap.py'
PINS = {'interpreter': 'b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2',
        'bootstrap': 'f07ce77f8a4358ffb8852b0f4228976695e95820ca558306b5a0c81794b3b3c6',
        'worker': 'a0fef291bd0e9b40151f4f3842bb6bddb87e127dd6ed15f73bd8f9cac8b5a599',
        'models': '2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873'}
SIZE = ctypes.c_size_t
REGISTRY = {}


class Security(ctypes.Structure):
    _fields_ = [('size', w.DWORD), ('descriptor', w.LPVOID), ('inherit', w.BOOL)]


class Startup(ctypes.Structure):
    _fields_ = [('size', w.DWORD), ('reserved', w.LPWSTR), ('desktop', w.LPWSTR),
                ('title', w.LPWSTR), ('x', w.DWORD), ('y', w.DWORD), ('width', w.DWORD),
                ('height', w.DWORD), ('charsx', w.DWORD), ('charsy', w.DWORD),
                ('fill', w.DWORD), ('flags', w.DWORD), ('show', w.WORD),
                ('count', w.WORD), ('bytes', ctypes.POINTER(w.BYTE)),
                ('input', w.HANDLE), ('output', w.HANDLE), ('error', w.HANDLE)]


class Extended(ctypes.Structure):
    _fields_ = [('startup', Startup), ('attributes', w.LPVOID)]


class Process(ctypes.Structure):
    _fields_ = [('process', w.HANDLE), ('thread', w.HANDLE), ('pid', w.DWORD), ('tid', w.DWORD)]


class Basic(ctypes.Structure):
    _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                ('flags', w.DWORD), ('minimum', SIZE), ('maximum', SIZE),
                ('active', w.DWORD), ('affinity', SIZE), ('priority', w.DWORD),
                ('scheduling', w.DWORD)]


class Io(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ('reads', 'writes', 'other', 'read_bytes', 'write_bytes', 'other_bytes')]


class Limits(ctypes.Structure):
    _fields_ = [('basic', Basic), ('io', Io), ('process_memory', SIZE),
                ('job_memory', SIZE), ('peak_process', SIZE), ('peak_job', SIZE)]


class Accounting(ctypes.Structure):
    _fields_ = [('user', ctypes.c_longlong), ('kernel', ctypes.c_longlong),
                ('period_user', ctypes.c_longlong), ('period_kernel', ctypes.c_longlong),
                ('faults', w.DWORD), ('total', w.DWORD), ('active', w.DWORD), ('terminated', w.DWORD)]


class Port(ctypes.Structure):
    _fields_ = [('key', w.LPVOID), ('port', w.HANDLE)]


def api():
    library = ctypes.WinDLL('kernel32', use_last_error=True)
    specs = {
        'CreateJobObjectW': ([w.LPVOID, w.LPCWSTR], w.HANDLE),
        'SetInformationJobObject': ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD], w.BOOL),
        'QueryInformationJobObject': ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, w.LPVOID], w.BOOL),
        'CreateIoCompletionPort': ([w.HANDLE, w.HANDLE, SIZE, w.DWORD], w.HANDLE),
        'CreatePipe': ([ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.POINTER(Security), w.DWORD], w.BOOL),
        'SetHandleInformation': ([w.HANDLE, w.DWORD, w.DWORD], w.BOOL),
        'InitializeProcThreadAttributeList': ([w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(SIZE)], w.BOOL),
        'UpdateProcThreadAttribute': ([w.LPVOID, w.DWORD, SIZE, w.LPVOID, SIZE, w.LPVOID, w.LPVOID], w.BOOL),
        'DeleteProcThreadAttributeList': ([w.LPVOID], None),
        'CreateProcessW': ([w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL, w.DWORD,
                            w.LPVOID, w.LPCWSTR, ctypes.POINTER(Extended), ctypes.POINTER(Process)], w.BOOL),
        'CloseHandle': ([w.HANDLE], w.BOOL),
        'GetCurrentProcess': ([], w.HANDLE),
        'GetProcessTimes': ([w.HANDLE]+[ctypes.POINTER(w.FILETIME)]*4, w.BOOL),
        'QueryFullProcessImageNameW': ([w.HANDLE, w.DWORD, w.LPWSTR, ctypes.POINTER(w.DWORD)], w.BOOL),
        'IsProcessInJob': ([w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL)], w.BOOL),
        'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),
        'GetExitCodeProcess': ([w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),
        'ReadFile': ([w.HANDLE, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD), w.LPVOID], w.BOOL),
        'PeekNamedPipe': ([w.HANDLE, w.LPVOID, w.DWORD, w.LPVOID, ctypes.POINTER(w.DWORD), w.LPVOID], w.BOOL),
        'WriteFile': ([w.HANDLE, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD), w.LPVOID], w.BOOL),
    }
    for name, (args, result) in specs.items():
        function = getattr(library, name)
        function.argtypes = args
        function.restype = result
    return library


def checked(value, name):
    if not value:
        raise OSError(ctypes.get_last_error(), name)
    return value


def selected(path, expected, include=False):
    for parent in path.parents:
        row = parent.lstat()
        if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
            raise ValueError('source_parent')
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 16777216 or getattr(before, 'st_file_attributes', 0) & 0x400:
        raise ValueError('source_identity')
    with path.open('rb') as file:
        opened = os.fstat(file.fileno())
        raw = file.read(16777217)
        final = os.fstat(file.fileno())
    after = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
    identity = tuple(getattr(before, name) for name in fields)
    if any(tuple(getattr(row, name) for name in fields) != identity for row in (opened, final, after)) or before.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns or len(raw) != before.st_size:
        raise ValueError('source_changed')
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('source_selection')
    metadata = {'path': str(path), 'sha256': expected, 'generation': list(identity)}
    return (metadata, raw) if include else metadata


def identity(library, handle):
    times = [w.FILETIME() for _ in range(4)]
    checked(library.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)), 'GetProcessTimes')
    size = w.DWORD(32768)
    buffer = ctypes.create_unicode_buffer(size.value)
    checked(library.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)), 'QueryFullProcessImageNameW')
    return {'birth_filetime': str(times[0].dwLowDateTime+(times[0].dwHighDateTime << 32)),
            'image': buffer.value}


class Owner:
    def __init__(self, request, epoch, kind, body, cancel, until, fence, namespace):
        if not re.fullmatch('[a-f0-9]{32}', request) or not re.fullmatch('[a-f0-9]{32}', epoch) or kind not in ('embeddings', 'rerank'):
            raise ValueError('fixed_request_identity')
        payload = json.dumps({'kind': kind, 'body': body}, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if len(payload) > 300000:
            raise ValueError('payload_bound')
        self.library = api()
        self.request = request
        self.epoch = epoch
        self.payload = payload
        self.cancel = cancel
        self.until = until
        self.fence = fence
        self.expired = False
        self.lock = threading.RLock()
        self.writer = None
        self.namespace = namespace
        self.handles = {}
        self.readers = {}
        self.errors = []
        self.causes = []
        self.seq = 0
        self.created = False
        self.state = {'format': 'raya.worker.ownership', 'version': 1,
                      'request': self.request, 'owner_epoch': self.epoch,
                      'phase': 'prepared', 'work_admitted': False,
                      'scope': 'source_only_retrieval_integration_candidate',
                      'failed_creation_universal_cleanup_proven': False}
        self.directory = namespace.folder('Runs', self.epoch, self.request)
        REGISTRY[self.request] = self

    def failure(self, error, phase):
        self.causes.append(error)
        self.errors.append({'phase': phase, 'type': type(error).__name__,
                            'api': error.strerror if isinstance(error, OSError) else 'validation',
                            'code': error.errno if isinstance(error, OSError) else None})

    def publish(self):
        with self.lock:
            self.seq += 1
            value = dict(self.state, seq=self.seq, errors=list(self.errors))
            raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')
            if len(raw) > 65536:
                raise ValueError('receipt_bound')
            self.namespace.publish(self.directory, f'{self.seq:06d}.json', raw)

    def expire(self):
        if self.expired:
            return
        self.expired = True
        self.state['observation_expired'] = True
        self.cancel.set()
        try:
            self.fence()
        except Exception as error:
            self.state['fence_unconfirmed'] = True
            self.failure(error, 'admission_fence')

    def consume(self, name, raw):
        row = self.readers[name]
        row['bytes'] += len(raw)
        limit = 2097152 if name == 'output' else 65536
        if name == 'output' and row['bytes'] <= limit:
            row['data'].extend(raw)
        if row['bytes'] > limit and not row['overflow']:
            row['overflow'] = True
            row['errors'].append({'type': 'output_bound'})
            self.causes.append(ValueError('output_bound'))

    def repair(self, name):
        row = self.readers[name]
        if row['eof'] or row['thread'].is_alive():
            return
        count = w.DWORD()
        if not self.library.PeekNamedPipe(self.handles[name+'_read'], None, 0, None, ctypes.byref(count), None):
            code = ctypes.get_last_error()
            if code == 109:
                row['eof'] = True
                row['ordinary_repair_observed'] = True
                return
            if not row.get('repair_error'):
                row['repair_error'] = code
                self.failure(OSError(code, 'PeekNamedPipe_repair'), 'reader_repair')
                self.expire()
            return
        if not count.value:
            return
        buffer = ctypes.create_string_buffer(min(count.value, 4096))
        read = w.DWORD()
        checked(self.library.ReadFile(self.handles[name+'_read'], buffer, len(buffer), ctypes.byref(read), None), 'ReadFile_repair')
        self.consume(name, buffer.raw[:read.value])

    def readers_start(self):
        for name in ('output', 'error'):
            if name in self.readers:
                continue
            row = {'bytes': 0, 'eof': False, 'overflow': False, 'errors': [], 'data': bytearray()}
            thread = threading.Thread(target=self.drain, args=(name,), daemon=False)
            self.readers[name] = dict(row, thread=thread)
            try:
                thread.start()
            except Exception as error:
                self.failure(error, 'reader_start')
                self.expire()

    def send(self):
        try:
            self.state['write_operation'] = 'control'
            written = w.DWORD()
            checked(self.library.WriteFile(self.handles['control_write'], self.frame, len(self.frame), ctypes.byref(written), None), 'WriteFile_control')
            if written.value != len(self.frame):
                raise ValueError('partial_start_frame')
            self.state['frame_written'] = True
            self.close('control_write')
            if 'control_write' in self.handles:
                raise ValueError('control_close_unconfirmed')
            if self.cancel.is_set() or time.monotonic() >= self.until:
                raise ValueError('payload_admission_closed')
            self.state['write_operation'] = 'payload'
            written = w.DWORD()
            checked(self.library.WriteFile(self.handles['input_write'], self.payload, len(self.payload), ctypes.byref(written), None), 'WriteFile_payload')
            if written.value != len(self.payload):
                raise ValueError('partial_model_payload')
            self.state['payload_written'] = True
        except Exception as error:
            self.failure(error, 'payload_write')
        finally:
            self.close('control_write')
            self.close('input_write')
            self.state['write_operation'] = 'returned'
            self.state['writer_returned'] = True
            if self.state.get('payload_written') and 'input_write' not in self.handles:
                self.state.update(phase='admission_sent', work_admitted=True)
            try:
                self.publish()
            except Exception as error:
                self.failure(error, 'writer_publication')
                self.expire()

    def close(self, name):
        handle = self.handles.get(name)
        if handle is None:
            return
        try:
            checked(self.library.CloseHandle(handle), 'CloseHandle')
            del self.handles[name]
        except Exception as error:
            self.failure(error, f'close_{name}')

    def pipe(self, name, parent):
        read, write = w.HANDLE(), w.HANDLE()
        security = Security(ctypes.sizeof(Security), None, True)
        checked(self.library.CreatePipe(ctypes.byref(read), ctypes.byref(write), ctypes.byref(security), 0), 'CreatePipe')
        self.handles[name+'_read'] = read.value
        self.handles[name+'_write'] = write.value
        checked(self.library.SetHandleInformation(self.handles[name+'_'+parent], 1, 0), 'SetHandleInformation')

    def count(self):
        value = Accounting()
        checked(self.library.QueryInformationJobObject(self.handles['job'], 1, ctypes.byref(value), ctypes.sizeof(value), None), 'QueryInformationJobObject')
        return value.active

    def drain(self, name):
        row = self.readers[name]
        buffer = ctypes.create_string_buffer(4096)
        try:
            while True:
                count = w.DWORD()
                if not self.library.ReadFile(self.handles[name+'_read'], buffer, len(buffer), ctypes.byref(count), None):
                    code = ctypes.get_last_error()
                    if code == 109:
                        row['eof'] = True
                        return
                    raise OSError(code, 'ReadFile')
                if not count.value:
                    row['eof'] = True
                    return
                self.consume(name, buffer.raw[:count.value])
        except Exception as error:
            self.causes.append(error)
            row['errors'].append({'type': type(error).__name__, 'code': getattr(error, 'errno', None)})

    def spawn(self):
        if HERE.name != 'retrieval' or HERE.parent.name != 'source' or not ROOT.name.startswith('raya-memory-managed-'):
            raise ValueError('private_source_layout')
        library = self.library
        if self.cancel.is_set() or time.monotonic() >= self.until:
            raise ValueError('precreation_admission_closed')
        paths = {'interpreter': BASE, 'bootstrap': BOOT, 'worker': HERE/'worker.py', 'models': HERE/'models.py'}
        self.state['sources'] = {name: selected(path, PINS[name]) for name, path in paths.items()}
        selection = hashlib.sha256(json.dumps(PINS, sort_keys=True).encode()).hexdigest()
        self.state['selection_sha256'] = selection
        self.state['owner'] = dict(identity(library, library.GetCurrentProcess()), pid=os.getpid())
        self.handles['job'] = checked(library.CreateJobObjectW(None, None), 'CreateJobObjectW')
        limits = Limits()
        checked(library.SetInformationJobObject(self.handles['job'], 9, ctypes.byref(limits), ctypes.sizeof(limits)), 'SetInformationJobObject')
        checked(library.QueryInformationJobObject(self.handles['job'], 9, ctypes.byref(limits), ctypes.sizeof(limits), None), 'QueryInformationJobObject')
        if limits.basic.flags:
            raise ValueError('job_limits')
        self.handles['port'] = checked(library.CreateIoCompletionPort(w.HANDLE(-1), None, 0, 1), 'CreateIoCompletionPort')
        port = Port(None, self.handles['port'])
        checked(library.SetInformationJobObject(self.handles['job'], 7, ctypes.byref(port), ctypes.sizeof(port)), 'SetInformationJobObject')
        self.pipe('input', 'write')
        self.pipe('control', 'write')
        self.pipe('output', 'read')
        self.pipe('error', 'read')
        size = SIZE()
        first = library.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
        code = ctypes.get_last_error()
        if first or code != 122 or not size.value:
            raise ValueError('attribute_size')
        buffer = ctypes.create_string_buffer(size.value)
        checked(library.InitializeProcThreadAttributeList(buffer, 2, 0, ctypes.byref(size)), 'InitializeProcThreadAttributeList')
        try:
            jobs = (w.HANDLE*1)(self.handles['job'])
            inherited = (w.HANDLE*4)(self.handles['input_read'], self.handles['output_write'], self.handles['error_write'], self.handles['control_read'])
            checked(library.UpdateProcThreadAttribute(buffer, 0, 0x2000d, jobs, ctypes.sizeof(jobs), None, None), 'UpdateProcThreadAttribute_JOB_LIST')
            checked(library.UpdateProcThreadAttribute(buffer, 0, 0x20002, inherited, ctypes.sizeof(inherited), None, None), 'UpdateProcThreadAttribute_HANDLE_LIST')
            startup = Extended()
            startup.startup.size = ctypes.sizeof(Extended)
            startup.startup.flags = 0x100
            startup.startup.input, startup.startup.output, startup.startup.error = inherited[:3]
            startup.attributes = ctypes.cast(buffer, w.LPVOID)
            process = Process()
            command = ctypes.create_unicode_buffer(subprocess.list2cmdline([
                str(BASE), '-I', '-S', '-B', '-u', str(BOOT), str(self.handles['control_read']), self.request, self.epoch, selection]))
            env = ctypes.create_unicode_buffer('\0'.join(key+'='+value for key, value in sorted(ENV.items()))+'\0\0')
            self.publish()
            if self.cancel.is_set() or time.monotonic() >= self.until:
                raise ValueError('creation_admission_closed')
            result = library.CreateProcessW(str(BASE), command, None, None, True,
                                            0x80000|0x08000000|0x400, env, str(HERE), ctypes.byref(startup), ctypes.byref(process))
            code = ctypes.get_last_error()
            if not result:
                self.state['creation'] = {'succeeded': False, 'code': code}
                raise OSError(code, 'CreateProcessW')
            self.created = True
            self.handles['process'] = process.process
            self.handles['thread'] = process.thread
            self.state['creation'] = {'succeeded': True, 'creation_time_job_list': True}
            self.state['worker'] = {'pid': process.pid}
        finally:
            library.DeleteProcThreadAttributeList(buffer)
        self.close('input_read')
        self.close('control_read')
        self.close('output_write')
        self.close('error_write')
        self.readers_start()
        self.state['worker'].update(identity(library, self.handles['process']))
        if os.path.normcase(self.state['worker']['image']) != os.path.normcase(str(BASE)):
            raise ValueError('worker_image')
        member = w.BOOL()
        checked(library.IsProcessInJob(self.handles['process'], self.handles['job'], ctypes.byref(member)), 'IsProcessInJob')
        if not member.value:
            raise ValueError('job_membership')
        for name, path in paths.items():
            if selected(path, PINS[name]) != self.state['sources'][name]:
                raise ValueError('source_generation')
        if self.errors:
            raise ValueError('prework_cleanup_debt')
        self.state.update(phase='created_waiting', membership_observed=True,
                          original_process_retained=True, original_job_retained=True)
        self.publish()
        if self.cancel.is_set() or time.monotonic() >= self.until:
            raise ValueError('work_admission_closed')
        frame = (json.dumps({'format': 'raya.worker.start', 'version': 1,
                             'request': self.request, 'owner_epoch': self.epoch,
                             'selection_sha256': selection}, separators=(',', ':'))+'\n').encode()
        self.state['work_admitted'] = 'unknown'
        self.frame = frame
        self.writer = threading.Thread(target=self.send, daemon=False)
        self.writer.start()

    def join(self, seconds=10):
        self.readers_start()
        until = time.monotonic()+seconds
        self.state['observations'] = []
        while True:
            for name in ('output', 'error'):
                try:
                    self.repair(name)
                except Exception as error:
                    if not self.readers[name].get('repair_failure'):
                        self.readers[name]['repair_failure'] = type(error).__name__
                        self.failure(error, 'reader_repair')
                    self.expire()
            root = self.library.WaitForSingleObject(self.handles['process'], 0)
            if root == 0xffffffff:
                if not self.state.get('root_observation_error'):
                    self.state['root_observation_error'] = ctypes.get_last_error()
                    self.failure(OSError(ctypes.get_last_error(), 'WaitForSingleObject'), 'root_observation')
                self.expire()
            try:
                count = self.count()
            except Exception as error:
                count = None
                if not self.state.get('job_observation_error'):
                    self.state['job_observation_error'] = type(error).__name__
                    self.failure(error, 'job_observation')
                self.expire()
            snapshot = {'root_signaled': root == 0, 'job_active': count,
                        'output_eof': self.readers['output']['eof'],
                        'error_eof': self.readers['error']['eof'],
                        'readers_finished': all(not row['thread'].is_alive() for row in self.readers.values())}
            if not self.state['observations'] or snapshot != self.state['observations'][-1]:
                if len(self.state['observations']) >= 64:
                    if not self.state.get('observation_bound'):
                        self.state['observation_bound'] = True
                        self.failure(ValueError('observation_bound'), 'observation')
                    self.expire()
                if len(self.state['observations']) < 64:
                    self.state['observations'].append(snapshot)
            writer = self.writer is None or not self.writer.is_alive()
            eof = all(row['eof'] and not row['thread'].is_alive() for row in self.readers.values())
            if root == 0 and count == 0 and eof and writer:
                break
            if time.monotonic() >= until:
                self.expire()
            time.sleep(0.01)
        exit = w.DWORD()
        checked(self.library.GetExitCodeProcess(self.handles['process'], ctypes.byref(exit)), 'GetExitCodeProcess')
        self.state.update(root_exit=exit.value, job_active=count)
        self.state['outputs'] = {}
        for name, row in self.readers.items():
            if row['thread'].ident is not None:
                row['thread'].join()
            self.state['outputs'][name] = {key: value for key, value in row.items() if key not in ('thread', 'data')}
            if not row['eof']:
                raise ValueError('output_join_uncertain')
            for error in row['errors']:
                self.errors.append(dict(error, phase='output'))
        if 'input_write' in self.handles or 'control_write' in self.handles:
            raise ValueError('input_join_uncertain')
        if self.writer is not None and self.writer.ident is not None:
            self.writer.join()
        self.state['writer_joined'] = True
        self.state['joins_observed'] = True

    def run(self):
        try:
            self.spawn()
        except Exception as error:
            self.failure(error, 'operation')
        for name in ('input_read', 'control_read', 'output_write', 'error_write'):
            self.close(name)
        if self.writer is None or self.writer.ident is None:
            self.close('control_write')
            self.close('input_write')
        if self.created:
            try:
                self.join(seconds=max(1, self.until-time.monotonic()+10))
            except Exception as error:
                self.failure(error, 'join')
        self.state['operation_outcome'] = 'failed' if self.errors or self.state.get('root_exit', 1) != 0 else 'completed'
        self.state['cleanup_outcome'] = 'uncertain'
        self.state['phase'] = 'uncertain'
        if self.state.get('joins_observed'):
            before = len(self.errors)
            for name in tuple(self.handles):
                self.close(name)
            if len(self.errors) == before and not self.handles:
                self.state['phase'] = 'terminal'
                self.state['cleanup_outcome'] = 'joined'
        try:
            self.publish()
        except Exception as error:
            self.failure(error, 'publication')
            self.state['phase'] = 'uncertain'
            self.state['cleanup_outcome'] = 'publication_unconfirmed'
        if self.state['phase'] == 'terminal':
            del REGISTRY[self.request]
        return dict(self.state, errors=list(self.errors), ownership_retained=self.request in REGISTRY)


def run(request, epoch, kind, body, cancel, until, fence, namespace):
    return Owner(request, epoch, kind, body, cancel, until, fence, namespace).run()
