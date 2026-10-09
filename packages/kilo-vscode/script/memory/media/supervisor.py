"""Creation-contained ordinary media worker, with a gated start and natural joins."""
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
import types

HERE = Path(__file__).resolve().parent
BASE = None
ENV = None


def image(path, digest):
    import stat
    path = Path(path)
    before = path.lstat()
    if not path.is_absolute() or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 16777216:
        raise ValueError('Ordinary bounded selected media source required.')
    for parent in (path, *path.parents):
        row = parent.lstat()
        if getattr(row, 'st_file_attributes', 0) & 0x400 or stat.S_ISLNK(row.st_mode):
            raise ValueError('Media launch source traverses reparse point.')
    with path.open('rb') as file:
        opened = os.fstat(file.fileno())
        raw = file.read(16777217)
        final = os.fstat(file.fileno())
    after = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_nlink', 'st_size', 'st_mtime_ns')
    identity = tuple(getattr(before, key) for key in fields)
    if any(tuple(getattr(row, key) for key in fields) != identity for row in (opened, final, after)) or before.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns or len(raw) != before.st_size or hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError('Media launch source changed or differs.')
    return raw


def decode(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise ValueError('Duplicate media protocol field refused.')
            result[key] = value
        return result
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite media value refused.')))


def config(path, digest):
    value = decode(image(path, digest))
    if not isinstance(value, dict) or set(value) != {'format', 'root', 'dependencies', 'python', 'sources'} or value['format'] != 'raya.media.launch.v1':
        raise ValueError('Exact media launch selection required.')
    if not isinstance(value['sources'], dict) or set(value['sources']) != {'worker.py', 'session.py', 'library.py', 'encoder.py', 'supervisor.py', 'owner.py'}:
        raise ValueError('Exact media launch source catalog required.')
    for name, ref in [('python', value['python']), *value['sources'].items()]:
        if not isinstance(ref, dict) or set(ref) != {'path', 'sha256', 'bytes'} or type(ref['bytes']) is not int or ref['bytes'] <= 0:
            raise ValueError('Exact media launch image reference required.')
        raw = image(ref['path'], ref['sha256'])
        if len(raw) != ref['bytes'] or name != 'python' and name != 'owner.py' and Path(ref['path']) != HERE / name:
            raise ValueError('Fixed media launch image differs.')
    if value['python']['sha256'] != 'b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2':
        raise ValueError('Reviewed media interpreter required.')
    import stat
    for name in ('root', 'dependencies'):
        path = Path(value[name])
        if not path.is_absolute() or path.resolve() != path:
            raise ValueError('Canonical media launch root required.')
        for node in (path, *path.parents):
            row = node.lstat()
            if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
                raise ValueError('Ordinary media launch root required.')
    return value


def load(cfg):
    source = cfg['sources']['owner.py']
    module = types.ModuleType('selected_media_job_api')
    module.__file__ = source['path']
    exec(compile(image(source['path'], source['sha256']), source['path'], 'exec'), module.__dict__)
    return module


def line(stream, bound=131072):
    raw = getattr(stream, 'raw', stream).readline(bound + 1)
    if not raw or len(raw) > bound or not raw.endswith(b'\n'):
        raise ValueError('Bounded newline terminated media frame required.')
    return decode(raw)


def emit(value):
    raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > 131072:
        raise ValueError('Media supervisor response bound exceeded.')
    sys.stdout.buffer.write(raw + b'\n')
    sys.stdout.buffer.flush()


def joined(value):
    if not isinstance(value, dict):
        return False
    creation = value.get('creation', {})
    outputs = value.get('outputs', {})
    if not isinstance(creation, dict) or not isinstance(outputs, dict):
        return False
    if not (value.get('format') == 'raya.worker.ownership' and type(value.get('version')) is int and value['version'] == 1 and value.get('phase') == 'terminal' and value.get('cleanup_outcome') == 'joined'):
        return False
    if creation.get('succeeded') is not True or creation.get('creation_time_job_list') is not True:
        return False
    if not all(value.get(key) is True for key in ('membership_observed', 'original_process_retained', 'original_job_retained', 'joins_observed', 'writer_joined')):
        return False
    if not all(type(value.get(key)) is int and value[key] == 0 for key in ('job_active', 'root_exit')):
        return False
    if value.get('ownership_retained') is not False or value.get('errors') != []:
        return False
    for name in ('output', 'error'):
        row = outputs.get(name)
        if not isinstance(row, dict) or row.get('eof') is not True or row.get('errors') != [] or row.get('overflow') is not False or type(row.get('bytes')) is not int or not 0 <= row['bytes'] <= (2097152 if name == 'output' else 0):
            return False
    return True


def main():
    global BASE, ENV
    if os.name != 'nt' or len(sys.argv) not in (3, 4) or not sys.flags.isolated or not sys.flags.no_site or not sys.flags.dont_write_bytecode:
        raise ValueError('Fixed isolated Windows media supervisor required.')
    cfg = config(sys.argv[1], sys.argv[2])
    BASE = Path(cfg['python']['path'])
    if os.path.normcase(sys.executable) != os.path.normcase(str(BASE)):
        raise ValueError('Original media supervisor interpreter differs.')
    sys.path.insert(0, str(HERE))
    from session import Session, encode, request
    value = request(line(sys.stdin.buffer))
    maximum = 300 if value['op'] in ('index', 'search') else 30
    duration = float(sys.argv[3]) if len(sys.argv) == 4 else maximum
    if not math.isfinite(duration) or not 0.001 <= duration <= maximum:
        raise ValueError('Media observation duration must be bounded by the ordinary operation budget.')
    if value['selection']['root'] != cfg['root']:
        raise ValueError('Media request belongs to another library launch.')
    job = load(cfg)
    for name in ('w', 'checked', 'Security', 'Startup', 'Extended', 'Process', 'SIZE', 'Limits', 'Port', 'identity', 'selected'):
        globals()[name] = getattr(job, name)
    import subprocess
    globals()['subprocess'] = subprocess
    ENV = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'TEMP', 'TMP') if key in os.environ}
    ENV.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_PROGRESS_BARS='1', CUDA_VISIBLE_DEVICES='-1', TOKENIZERS_PARALLELISM='false')
    session = Session(value)
    cancel = threading.Event()
    class Namespace:
        def folder(self, *parts):
            root = Path(cfg['root'])
            for part in parts:
                root = root / part
                root.mkdir(exist_ok=True)
                from library import ordinary
                ordinary(root, directory=True)
            return root
        def publish(self, folder, name, raw):
            with (folder / name).open('xb') as file:
                file.write(raw)
                file.flush()
                os.fsync(file.fileno())
    class Media(job.Owner):
        def images(self):
            rows = {'interpreter': cfg['python'], **cfg['sources']}
            return {key: Path(ref['path']) for key, ref in rows.items()}, {key: ref['sha256'] for key, ref in rows.items()}
        def command(self, selection):
            return [str(BASE), '-I', '-S', '-B', '-u', str(HERE / 'worker.py'), sys.argv[1], sys.argv[2], str(self.handles['control_read']), value['request'], value['epoch'], value['release'], value['policySHA'], selection]
        def admission(self, selection):
            return encode(dict(format='raya.media.worker.start.v1', request=value['request'], epoch=value['epoch'], release=value['release'], policySHA=value['policySHA'], selection=selection)) + b'\n'
        def limits(self):
            return Limits()
        def spawn(self):
            return contained(self)
    def fence():
        try:
            session.stop()
        except Exception as error:
            owner.failure(error, 'media_cancellation_fence')
    owner = Media(value['request'], value['epoch'], 'embeddings', {}, cancel, time.monotonic() + maximum, fence, Namespace())
    owner.payload = encode(value)
    emit(dict(format='raya.media.ready.v1', request=value['request'], epoch=value['epoch'], release=value['release'], policySHA=value['policySHA']))
    start = line(sys.stdin.buffer, 1024)
    if start != dict(format='raya.media.start.v1', request=value['request'], epoch=value['epoch'], release=value['release'], policySHA=value['policySHA']):
        raise ValueError('Original media supervisor START gate refused.')
    owner.until = time.monotonic() + duration
    done = threading.Event()
    def controls():
        try:
            import msvcrt
            api = job.api()
            handle = job.w.HANDLE(msvcrt.get_osfhandle(sys.stdin.fileno()))
            frame = bytearray()
            while not done.is_set():
                if time.monotonic() >= owner.until:
                    owner.expire()
                    return
                count = job.w.DWORD()
                if not api.PeekNamedPipe(handle, None, 0, None, ctypes.byref(count), None):
                    raise OSError(ctypes.get_last_error(), 'PeekNamedPipe_control')
                if not count.value:
                    done.wait(0.02)
                    continue
                buffer = ctypes.create_string_buffer(min(count.value, 1025 - len(frame)))
                actual = job.w.DWORD()
                job.checked(api.ReadFile(handle, buffer, len(buffer), ctypes.byref(actual), None), 'ReadFile_control')
                frame.extend(buffer.raw[:actual.value])
                if len(frame) > 1024:
                    raise ValueError('Media STOP exceeded its bound.')
                if frame.endswith(b'\n'):
                    break
            if done.is_set():
                return
            stop = decode(bytes(frame))
            if stop != dict(format='raya.media.stop.v1', request=value['request'], epoch=value['epoch']):
                raise ValueError('Original media STOP identity refused.')
        except Exception:
            cancel.set()
            fence()
            return
        cancel.set()
        fence()
    monitor = threading.Thread(target=controls, daemon=False)
    monitor.start()
    try:
        ownership = owner.run()
    finally:
        done.set()
        monitor.join()
    if time.monotonic() >= owner.until:
        owner.expire()
        ownership = dict(owner.state, errors=list(owner.errors), ownership_retained=owner.request in job.REGISTRY)
    accepted = not cancel.is_set() and not owner.expired and joined(ownership)
    raw = bytes(owner.readers.get('output', {}).get('data', b''))
    result = decode(raw) if accepted else None
    if accepted and (not isinstance(result, dict) or set(result) != {'format', 'request', 'epoch', 'release', 'policySHA', 'op', 'status', 'result', 'authority'} or any(result.get(key) != value[key] for key in ('request', 'epoch', 'release', 'policySHA', 'op')) or result.get('format') != 'raya.media.result.v1' or result.get('status') not in ('completed', 'failed') or result.get('authority') is not False):
        accepted = False
    if not joined(ownership):
        emit(dict(format='raya.media.uncertain.v1', request=value['request'], epoch=value['epoch'], ownership=ownership, accepted=False, authority=False))
        return
    final = session.finish(result['status'] if accepted else 'failed', result['result'] if accepted else dict(uncertain=True, authority=False, accepted=False), ownership=ownership, accepted=accepted)
    emit(final)


# Creation-time JOB_LIST implementation retained from the reviewed finite owner.
def contained(self):
    if BASE is None or ENV is None or HERE.name != 'media':
        raise ValueError('private_source_layout')
    library = self.library
    if self.cancel.is_set() or time.monotonic() >= self.until:
        raise ValueError('precreation_admission_closed')
    paths, pins = self.images()
    self.state['sources'] = {name: selected(path, pins[name]) for name, path in paths.items()}
    selection = hashlib.sha256(json.dumps(pins, sort_keys=True).encode()).hexdigest()
    self.state['selection_sha256'] = selection
    self.state['owner'] = dict(identity(library, library.GetCurrentProcess()), pid=os.getpid())
    self.handles['job'] = checked(library.CreateJobObjectW(None, None), 'CreateJobObjectW')
    limits = self.limits()
    flags = limits.basic.flags
    checked(library.SetInformationJobObject(self.handles['job'], 9, ctypes.byref(limits), ctypes.sizeof(limits)), 'SetInformationJobObject')
    checked(library.QueryInformationJobObject(self.handles['job'], 9, ctypes.byref(limits), ctypes.sizeof(limits), None), 'QueryInformationJobObject')
    if limits.basic.flags != flags:
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
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(self.command(selection)))
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
        if selected(path, pins[name]) != self.state['sources'][name]:
            raise ValueError('source_generation')
    if self.errors:
        raise ValueError('prework_cleanup_debt')
    self.state.update(phase='created_waiting', membership_observed=True,
                      original_process_retained=True, original_job_retained=True)
    self.publish()
    if self.cancel.is_set() or time.monotonic() >= self.until:
        raise ValueError('work_admission_closed')
    self.state['work_admitted'] = 'unknown'
    self.frame = self.admission(selection)
    self.writer = threading.Thread(target=self.send, daemon=False)
    self.writer.start()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stderr.write('Media supervisor refused: ' + type(error).__name__ + (': ' + str(error) if isinstance(error, ValueError) else '') + '\n')
        sys.exit(1)
