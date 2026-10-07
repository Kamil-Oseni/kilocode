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
PINS = {'worker.py': 'e5e3d135ebe3806097c9937c3d0429574622358a77b4beb14c2f9ee932e0d721',
        'models.py': '2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873'}
ROOT = HERE.parent.parent
DEPENDENCIES = ROOT/'dependencies'
ENV = {'SystemRoot': 'C:\\Windows', 'HOME': str(ROOT/'home'), 'USERPROFILE': str(ROOT/'home'), 'TEMP': str(ROOT/'tmp'), 'TMP': str(ROOT/'tmp'), 'HF_HOME': str(ROOT/'hf'), 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_PROGRESS_BARS': '1', 'CUDA_VISIBLE_DEVICES': '-1'}
CATALOG = Path(r'D:\Raya\Models\Catalog')
MANIFESTS = {'Qwen--Qwen3-Embedding-0.6B.json': '60cae741077a5b3f79f531c139674a1461bda80a5fb8ca767ec1a9ba25975b7d',
             'Qwen--Qwen3-Reranker-0.6B.json': 'ef8b5bbc099e513ad2ddcd0d20e1ce0006a87e1701228631652d278eecb3f0a3',
             'google--embeddinggemma-2.json': '7f28a34d9d8e9cc67372be2bc8d1c5ad4e386914e59aa18ae7351e1e95646f54'}


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


def checkpoint(manifest):
    revision = '914f7f89142e33e77833254d9c9b90c3cef7303b'
    root = Path(r'D:\Raya\Models\HuggingFace\google--embeddinggemma-2')/revision
    if manifest.get('source') != 'google/embeddinggemma-2' or manifest.get('revision') != revision or manifest.get('status') != 'downloaded_verified' or Path(manifest.get('path', '')) != root:
        raise ValueError('gemma_checkpoint_selection')
    files = manifest.get('files')
    if not isinstance(files, list) or len(files) != 15:
        raise ValueError('gemma_checkpoint_inventory')
    seen = set()
    keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
    for item in files:
        name = item.get('name') if isinstance(item, dict) else None
        if not isinstance(name, str) or not name or '\\' in name or ':' in name or any(part in ('', '.', '..') for part in name.split('/')) or name.startswith('/') or name in seen:
            raise ValueError('gemma_checkpoint_name')
        seen.add(name)
        path = root/name
        for parent in path.parents:
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('gemma_checkpoint_parent')
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or getattr(before, 'st_file_attributes', 0) & 0x400 or type(item.get('bytes')) is not int or not 0 < item['bytes'] <= 2147483648 or before.st_size != item['bytes']:
            raise ValueError('gemma_checkpoint_file')
        digest = hashlib.sha256()
        with path.open('rb') as file:
            opened = os.fstat(file.fileno())
            for raw in iter(lambda: file.read(1048576), b''):
                digest.update(raw)
            final = os.fstat(file.fileno())
        after = path.lstat()
        signature = tuple(getattr(before, key) for key in keys)
        if any(tuple(getattr(info, key) for key in keys) != signature for info in (opened, final, after)) or before.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns or digest.hexdigest() != item.get('sha256'):
            raise ValueError('gemma_checkpoint_changed')
    return manifest


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
    if payload['kind'] == 'embeddings' and payload['body'].get('model') == 'embeddinggemma-2':
        checkpoint(manifests['google--embeddinggemma-2.json'])
    for parent in (DEPENDENCIES, *DEPENDENCIES.parents):
        row = parent.lstat()
        if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
            raise ValueError('dependency_directory')
    # Fixed dependency path is reviewed separately; no request-selected sys.path or .pth execution.
    sys.path.append(str(DEPENDENCIES))
    module = types.ModuleType('models')
    module.__file__ = str(HERE/'models.py')
    module.MANIFESTS = {'embeddinggemma-2': manifests['google--embeddinggemma-2.json'],
                        'qwen3-embedding-0.6b': manifests['Qwen--Qwen3-Embedding-0.6B.json'],
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
