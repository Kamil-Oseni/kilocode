"""Bounded private admission before any selected retrieval/model import."""
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import time
import types

HERE = Path(__file__).resolve().parent
PINS = {'worker.py': 'a0fef291bd0e9b40151f4f3842bb6bddb87e127dd6ed15f73bd8f9cac8b5a599',
        'models.py': 'c0cfec605b11efc4a3ff641a9c61be01e830fbabe63048b55e8783780c723345'}
ROOT = HERE.parent.parent
DEPENDENCIES = ROOT/'dependencies'
ENV = {'SystemRoot': 'C:\\Windows', 'HOME': str(ROOT/'home'), 'USERPROFILE': str(ROOT/'home'), 'TEMP': str(ROOT/'tmp'), 'TMP': str(ROOT/'tmp'), 'HF_HOME': str(ROOT/'hf'), 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_PROGRESS_BARS': '1', 'CUDA_VISIBLE_DEVICES': '-1'}
CATALOG = Path(r'D:\Raya\Models\Catalog')
MANIFESTS = {'Qwen--Qwen3-Embedding-0.6B.json': '60cae741077a5b3f79f531c139674a1461bda80a5fb8ca767ec1a9ba25975b7d',
             'Qwen--Qwen3-Reranker-0.6B.json': 'ef8b5bbc099e513ad2ddcd0d20e1ce0006a87e1701228631652d278eecb3f0a3'}


def fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_key')
        result[key] = value
    return result


def decode(raw):
    return json.loads(raw.decode('utf-8'), object_pairs_hook=fields,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))


def image(path, expected):
    for parent in path.parents:
        row = parent.lstat()
        if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
            raise ValueError('source_parent')
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1048576 or getattr(before, 'st_file_attributes', 0) & 0x400:
        raise ValueError('source_file')
    with path.open('rb') as file:
        opened = os.fstat(file.fileno())
        raw = file.read(1048577)
        final = os.fstat(file.fileno())
    after = path.lstat()
    names = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
    signature = tuple(getattr(before, name) for name in names)
    if any(tuple(getattr(row, name) for name in names) != signature for row in (opened, final, after)) or before.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns or len(raw) != before.st_size:
        raise ValueError('source_changed')
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('source_selection')
    return raw


def read(library, handle, bound):
    until = library.GetTickCount64()+30000
    raw = bytearray()
    while True:
        available = w.DWORD()
        if not library.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
            code = ctypes.get_last_error()
            if code == 109:
                return bytes(raw)
            raise OSError(code, 'bootstrap_pipe')
        if library.GetTickCount64() >= until:
            raise TimeoutError('bootstrap_observation')
        if not available.value:
            time.sleep(0.01)
            continue
        size = min(available.value, bound+1-len(raw))
        if size <= 0:
            raise ValueError('bootstrap_bound')
        buffer = ctypes.create_string_buffer(size)
        count = w.DWORD()
        if not library.ReadFile(handle, buffer, size, ctypes.byref(count), None):
            raise OSError(ctypes.get_last_error(), 'bootstrap_read')
        raw.extend(buffer.raw[:count.value])
        if len(raw) > bound:
            raise ValueError('bootstrap_bound')


def private():
    if HERE.name != 'retrieval' or HERE.parent.name != 'source' or not ROOT.name.startswith('raya-memory-managed-'):
        raise ValueError('private_source_layout')
    for key, value in ENV.items():
        if os.environ.get(key) != value:
            raise ValueError('private_environment')
    for value in {ENV[key] for key in ('HOME', 'USERPROFILE', 'TEMP', 'TMP', 'HF_HOME')}:
        path = Path(value)
        if not path.is_absolute() or os.path.normcase(str(path.resolve(strict=True))) != os.path.normcase(str(path)):
            raise ValueError('private_canonical')
        for parent in (path, *path.parents):
            row = parent.lstat()
            if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
                raise ValueError('private_directory')
    if not sys.flags.dont_write_bytecode:
        raise ValueError('private_bytecode')


def main():
    if len(sys.argv) != 5 or not sys.flags.isolated or not sys.flags.no_site:
        raise ValueError('fixed_launch_required')
    private()
    control, request, epoch, selection = sys.argv[1:]
    if not control.isdecimal():
        raise ValueError('private_control_handle')
    library = ctypes.WinDLL('kernel32', use_last_error=True)
    library.GetStdHandle.argtypes = [w.DWORD]
    library.GetStdHandle.restype = w.HANDLE
    library.PeekNamedPipe.argtypes = [w.HANDLE, w.LPVOID, w.DWORD, w.LPVOID, ctypes.POINTER(w.DWORD), w.LPVOID]
    library.PeekNamedPipe.restype = w.BOOL
    library.ReadFile.argtypes = [w.HANDLE, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD), w.LPVOID]
    library.ReadFile.restype = w.BOOL
    library.GetTickCount64.argtypes = []
    library.GetTickCount64.restype = ctypes.c_ulonglong
    library.CloseHandle.argtypes = [w.HANDLE]
    library.CloseHandle.restype = w.BOOL
    handle = w.HANDLE(int(control))
    try:
        raw = read(library, handle, 1024)
    finally:
        if not library.CloseHandle(handle):
            raise OSError(ctypes.get_last_error(), 'bootstrap_control_close')
    expected = {'format': 'raya.worker.start', 'version': 1, 'request': request,
                'owner_epoch': epoch, 'selection_sha256': selection}
    if not raw.endswith(b'\n') or raw.count(b'\n') != 1:
        raise ValueError('admission_frame')
    value = decode(raw)
    if value != expected or type(value.get('version')) is not int:
        raise ValueError('admission_identity')
    payload = decode(read(library, library.GetStdHandle(w.DWORD(-10 & 0xffffffff)), 300000))
    if not isinstance(payload, dict) or set(payload) != {'kind', 'body'} or payload['kind'] not in ('embeddings', 'rerank') or not isinstance(payload['body'], dict):
        raise ValueError('model_payload')
    sources = {name: image(HERE/name, digest) for name, digest in PINS.items()}
    manifests = {name: decode(image(CATALOG/name, digest)) for name, digest in MANIFESTS.items()}
    for parent in (DEPENDENCIES, *DEPENDENCIES.parents):
        row = parent.lstat()
        if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
            raise ValueError('dependency_directory')
    # Fixed dependency path is reviewed separately; no request-selected sys.path or .pth execution.
    sys.path.append(str(DEPENDENCIES))
    module = types.ModuleType('models')
    module.__file__ = str(HERE/'models.py')
    module.MANIFESTS = {'qwen3-embedding-0.6b': manifests['Qwen--Qwen3-Embedding-0.6B.json'],
                        'qwen3-reranker-0.6b': manifests['Qwen--Qwen3-Reranker-0.6B.json']}
    sys.modules['models'] = module
    exec(compile(sources['models.py'], module.__file__, 'exec'), module.__dict__)
    worker = {'__name__': 'reviewed_retrieval_worker', '__file__': str(HERE/'worker.py')}
    exec(compile(sources['worker.py'], worker['__file__'], 'exec'), worker)
    try:
        result = {'result': worker['infer'](payload['kind'], payload['body'])}
    except ValueError:
        result = {'type': 'validation', 'error': 'Selected model input validation failed.'}
    output = json.dumps(result, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(output) > 2097152:
        raise ValueError('model_output_bound')
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr, flush=True)
        sys.exit(65)
