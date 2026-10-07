"""Separate source-only v2 lease bootstrap; not in the selected finite release."""
import ctypes
from ctypes import wintypes as w
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types

HERE = Path(__file__).resolve().parent
SUPPORT = HERE.parent/'retrieval'/'bootstrap.py'
DIGEST = '530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d'
PINS = {'lease.py': '308eeeab2ffbd8ae1e7db9b1da238c442829aec0cd1ab9ea5202a8d8e3412a3d',
        'resident.py': '3f873c284a70501cebdfd7d7cbbef4fcfe8eb42100c64024446ec43c771239de',
        'validation.py': '905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2'}


def support():
    # Verify the ordinary bootstrap before executing any of its helpers. The
    # protected parent must independently authenticate this wrapper's image.
    for parent in SUPPORT.parents:
        row = parent.lstat()
        if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
            raise ValueError('lease_support_parent')
    before = SUPPORT.lstat()
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
            before.st_size > 1048576 or getattr(before, 'st_file_attributes', 0) & 0x400):
        raise ValueError('lease_support_file')
    with SUPPORT.open('rb') as file:
        opened = os.fstat(file.fileno())
        raw = file.read(1048577)
        final = os.fstat(file.fileno())
    after = SUPPORT.lstat()
    keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
    baseline = tuple(getattr(before, key) for key in keys)
    if (any(tuple(getattr(row, key) for key in keys) != baseline for row in (opened, final, after)) or
            before.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns or
            len(raw) != before.st_size or hashlib.sha256(raw).hexdigest() != DIGEST):
        raise ValueError('lease_support_selection')
    module = types.ModuleType('selected_retrieval_support')
    module.__file__ = str(SUPPORT)
    exec(compile(raw, module.__file__, 'exec'), module.__dict__)
    return module


def gate(raw, lease, epoch, selection, release, kind, model):
    if (not all(isinstance(value, str) and re.fullmatch('[a-f0-9]{32}', value) for value in (lease, epoch)) or
            not all(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) for value in (selection, release)) or
            (kind, model) not in {('embeddings', 'embeddinggemma-2'), ('embeddings', 'qwen3-embedding-0.6b'),
                                 ('rerank', 'qwen3-reranker-0.6b')}):
        raise ValueError('lease_start_selection')
    if not isinstance(raw, bytes) or len(raw) > 1024 or not raw.endswith(b'\n') or raw.count(b'\n') != 1:
        raise ValueError('lease_start_frame')
    def fields(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError('lease_start_duplicate')
            value[key] = item
        return value
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=fields,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError('lease_start_nonfinite')))
    expected = {'format': 'raya.worker.lease.start', 'version': 2, 'lease': lease,
                'owner_epoch': epoch, 'selection_sha256': selection, 'selected_release_sha256': release,
                'kind': kind, 'model': model, 'limit': 32}
    if (value != expected or not isinstance(value, dict) or
            type(value.get('version')) is not int or type(value.get('limit')) is not int):
        raise ValueError('lease_start_identity')
    return expected


def main():
    if len(sys.argv) != 8 or not sys.flags.isolated or not sys.flags.no_site or not sys.flags.dont_write_bytecode:
        raise ValueError('lease_fixed_launch_required')
    if HERE.name != 'retrieval_reuse':
        raise ValueError('lease_source_layout')
    boot = support()
    boot.private()
    control, lease, epoch, selection, release, kind, model = sys.argv[1:]
    if not control.isdecimal() or int(control) <= 0:
        raise ValueError('lease_control_handle')
    library = ctypes.WinDLL('kernel32', use_last_error=True)
    for name, args, result in (
            ('PeekNamedPipe', [w.HANDLE, w.LPVOID, w.DWORD, w.LPVOID, ctypes.POINTER(w.DWORD), w.LPVOID], w.BOOL),
            ('ReadFile', [w.HANDLE, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD), w.LPVOID], w.BOOL),
            ('GetTickCount64', [], ctypes.c_ulonglong), ('CloseHandle', [w.HANDLE], w.BOOL)):
        function = getattr(library, name)
        function.argtypes, function.restype = args, result
    handle = w.HANDLE(int(control))
    try:
        raw = boot.read(library, handle, 1024)
    finally:
        if not library.CloseHandle(handle):
            raise OSError(ctypes.get_last_error(), 'lease_control_close')
    gate(raw, lease, epoch, selection, release, kind, model)
    sources = {name: boot.image(HERE/name if name != 'validation.py' else SUPPORT.parent/name, digest)
               for name, digest in PINS.items()}
    code = boot.image(SUPPORT.parent/'models.py', boot.PINS['models.py'])
    manifests = {name: boot.decode(boot.image(boot.CATALOG/name, digest)) for name, digest in boot.MANIFESTS.items()}
    if model == 'embeddinggemma-2':
        boot.checkpoint(manifests['google--embeddinggemma-2.json'])
    for parent in (boot.DEPENDENCIES, *boot.DEPENDENCIES.parents):
        row = parent.lstat()
        if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400:
            raise ValueError('lease_dependency_directory')
    sys.path.append(str(boot.DEPENDENCIES))
    models = types.ModuleType('models')
    models.__file__ = str(SUPPORT.parent/'models.py')
    models.MANIFESTS = {'embeddinggemma-2': manifests['google--embeddinggemma-2.json'],
                       'qwen3-embedding-0.6b': manifests['Qwen--Qwen3-Embedding-0.6B.json'],
                       'qwen3-reranker-0.6b': manifests['Qwen--Qwen3-Reranker-0.6B.json']}
    def load(name):
        if name not in ('Embeddings', 'Gemma', 'Reranker'):
            raise AttributeError(name)
        exec(compile(code, models.__file__, 'exec'), models.__dict__)
        return models.__dict__[name]
    models.__getattr__ = load
    sys.modules['models'] = models
    modules = {}
    for name in ('validation', 'lease', 'resident'):
        module = types.ModuleType(name)
        module.__file__ = str(HERE/(name+'.py'))
        sys.modules[name] = module
        exec(compile(sources[name+'.py'], module.__file__, 'exec'), module.__dict__)
        modules[name] = module
    owner = modules['lease'].Lease(lease, epoch, release, kind, model)
    resident = modules['resident'].Resident(kind, model)
    modules['resident'].run(sys.stdin.buffer, sys.stdout.buffer, owner, resident)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__, file=sys.stderr, flush=True)
        sys.exit(65)
