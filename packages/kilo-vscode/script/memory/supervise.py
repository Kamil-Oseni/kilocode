"""Root-reviewed service supervision with an explicitly selected managed START gate.

Invoke only with fixed Python -I -S -B -u and an independently reviewed plan SHA.
There is no force, signal, restart, model request, or automatic receipt recovery.
"""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import threading
import time


BEGUN = time.monotonic()
PHASE = threading.Lock()


RELEASES = {'memory': {'server.py': '99200f6543198c25a85e9c739362bca843ee250005825b882a67ce7514f167ee', 'index.py': '8cf3e8de652cca38babf9529c287cb01157509e448c5c0a568d0cfc7e2e42c00', 'notes.py': '59488d324200d95b0974bfa119215de627bc1b17dd3233fc6b02ab137b651923', 'policy.py': '87c931cfa7cceb7386e6d2b4b05fdacf916360fd2cb0ff590d0fccf5dd334ae2', 'admission.py': 'c47d6881f4c6560b2aa2dad97d0999e0a08ca6d35b595fc17ad6a4ffde5f2267', 'host.py': '4854ab90b06085450136e764ec1f70034ae27c597af9b6fa98a99860aa049a97', 'operations.py': '5cf93ceb6c544b3684c87b4666b2d4c8c077da67aaac64d5067686112a5f509d', 'retirement.py': '9add7b8be0f6cdfb4622c2309ae76c37f1e850516cf5d426e48f5455c06a0d9f', 'namespace.py': '0df00525c58bc5c57bb11dbee48cb71785a6c40ee178a011c90a5883dbe26a72', 'dispatch.py': '50c6c5ab29519e3cdad4f226b8d5f0c5e30fc407966dd0706a10bd328f96dc35', 'historical.py': '9e62995e30d8a5df8880803597792a92b9a2684cd0723bcdc91efd23d3807d1f', 'proposals.py': 'fbfd07c0bbe71439d21399d06eac37f8712aff1f24f509697e01f39802c301e0'}, 'retrieval': {'worker.py': 'e5e3d135ebe3806097c9937c3d0429574622358a77b4beb14c2f9ee932e0d721', 'models.py': '2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873', 'validation.py': '905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2', 'server.py': '6bba99a267420d0e519d8db1f26848af16999ac7b339487f2da4fd0261e73ecb', 'namespace.py': '5cc018c7340b6225544ab43120a71eadcd1699ad38a05be7df3826115c7689b3', 'bootstrap.py': '530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d', 'owner.py': '75c4befcc8a9677e91e801509e711ca3b119ac924721aa0fc030e2f805778383'}}


def reject(message):
    raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stable(before, opened, final, after):
    # Windows path and descriptor ctime may differ; retain each API's exact value.
    shared = (0, 1, 2, 3, 5)
    if before != after or opened != final or any(before[index] != opened[index] for index in shared):
        reject('Original input changed')


def read(file, limit):
    path = Path(file)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit or path.resolve() != path:
        reject('Ordinary canonical bounded input required')
    with path.open('rb') as held:
        opened = os.fstat(held.fileno())
        data = held.read(limit + 1)
        final = os.fstat(held.fileno())
    after = path.lstat()
    keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    stable(*(tuple(getattr(info, key) for key in keys) for info in (before, opened, final, after)))
    if len(data) != before.st_size:
        reject('Original input changed')
    return data


def verify(item, retain):
    path = Path(item['path'])
    before = path.lstat()
    keys = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
    original = tuple(getattr(before, key) for key in keys)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or path.resolve() != path:
        reject('Ordinary canonical dependency required')
    if list(original) != item['identity'] or type(item['bytes']) is not int or item['bytes'] < 0 or before.st_size != item['bytes']:
        reject('Planned dependency identity differs')
    if retain and before.st_size > 536870912:
        reject('Selected source bound exceeded')
    sha = hashlib.sha256()
    data = bytearray() if retain else None
    count = 0
    with path.open('rb') as held:
        opened = os.fstat(held.fileno())
        while True:
            chunk = held.read(1048576)
            if not chunk:
                break
            count += len(chunk)
            if count > item['bytes']:
                reject('Planned dependency length exceeded')
            sha.update(chunk)
            if data is not None:
                data.extend(chunk)
        final = os.fstat(held.fileno())
    after = path.lstat()
    stable(original, *(tuple(getattr(info, key) for key in keys) for info in (opened, final, after)))
    if count != item['bytes'] or sha.hexdigest() != item['sha256']:
        reject('Selected source/dependency differs')
    return bytes(data) if data is not None else None


def dependencies(items, selected):
    paths = set()
    for item in items:
        path = Path(item['path'])
        if path in paths:
            reject('Duplicate dependency path')
        paths.add(path)
    images = {}
    errors = []
    # Keep one original executor and a bounded pending window. Its context joins
    # every submitted task before returning or raising; no cancellation/adoption.
    with ThreadPoolExecutor(max_workers=8) as pool:
        for offset in range(0, len(items), 64):
            batch = items[offset:offset+64]
            futures = []
            for item in batch:
                path = Path(item['path'])
                try:
                    futures.append((path, pool.submit(verify, item, path in selected)))
                except BaseException as error:
                    errors.append(error)
                    break
            for path, future in futures:
                try:
                    data = future.result()
                    if data is not None:
                        images[path] = data
                except BaseException as error:
                    errors.append(error)
            if errors:
                break
    if errors:
        raise BaseExceptionGroup('Original dependency verification failures retained', errors)
    return paths, images


def emit(value):
    # Types/counts only: never exception text, tokens, requests or note contents.
    print(json.dumps(value, separators=(',', ':')), flush=True)


def phase(name):
    if name not in ('closure-started', 'closure-verified', 'import-started', 'service-imported', 'uvicorn-started',
                    'control-stop', 'control-eof', 'serve-returned', 'terminal', 'launch-selected'):
        reject('Unknown supervisor phase')
    with PHASE:
        emit({'format': 'raya.memory.disposable.supervisor.phase', 'phase': name,
              'elapsed': round(time.monotonic() - BEGUN, 6)})


def load(file, expected, managed=False):
    raw = read(file, 16777216)
    if digest(raw) != expected:
        reject('Supervisor plan digest differs')
    plan = json.loads(raw)
    format = 'raya.memory.managed.supervisor' if managed else 'raya.memory.disposable.supervisor'
    if plan['format'] != format or plan['version'] != 1:
        reject('Supervisor plan differs')
    if plan['kind'] not in ('memory', 'retrieval') or plan['execution_admitted'] is not True:
        reject('Root execution admission required')
    root = Path(plan['root'])
    prefix = 'raya-memory-managed-' if managed else 'raya-memory-disposable-'
    if not root.is_absolute() or root.resolve() != root or not root.name.startswith(prefix):
        reject('Exclusive disposable root required')
    # Plan must carry the separately reviewed native provisioning/ACL receipt.
    proof = plan['protection']
    if digest(read(proof['path'], 1048576)) != proof['sha256']:
        reject('Protection receipt changed')
    cfg = json.loads(read(proof['path'], 1048576))
    if cfg.get('passed') is not True or Path(cfg['root']) != root:
        reject('Protected disposable root evidence required')
    for item in plan['directories']:
        path = Path(item['path'])
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or path.resolve() != path or [info.st_dev, info.st_ino, info.st_ctime_ns] != item['identity']:
            reject('Admitted directory generation differs')
    if plan['python_sha256'] != 'b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2' or digest(read(sys.executable, 536870912)) != plan['python_sha256']:
        reject('Selected Python image differs')
    source = Path(plan['source'])
    pins = plan['source_sha256']
    expected = 12 if plan['kind'] == 'memory' else 7
    if len(pins) != expected or pins != RELEASES[plan['kind']]:
        reject('Exact selected service release required')
    selected = {source / name for name in pins}
    paths, images = dependencies(plan['files'], selected)
    deps = Path(plan['dependencies'])
    if not any(path.is_relative_to(deps) for path in paths):
        reject('Reviewed dependency closure required')
    for name, sha in pins.items():
        if Path(name).name != name or not name.endswith('.py') or digest(images[source / name]) != sha:
            reject('Selected service source differs')
    env = plan['env']
    system = {'SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS',
              'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER'}
    private = {'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'HF_HOME', 'HF_HUB_OFFLINE',
               'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_PROGRESS_BARS', 'PYTHONDONTWRITEBYTECODE'}
    memory = {'RAYA_MEMORY_ROOT', 'RAYA_MEMORY_PORT', 'RAYA_MEMORY_TOKEN_FILE',
              'RAYA_MEMORY_OPERATION_ROOT', 'RAYA_MEMORY_OPERATION_SID', 'RAYA_MEMORY_OPERATION_GENERATIONS',
              'RAYA_MEMORY_NOTE_GENERATIONS', 'RAYA_MEMORY_RETRIEVAL_TOKEN_FILE',
              'RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256', 'RAYA_RETRIEVAL_PORT'}
    retrieval = {'RAYA_RETRIEVAL_PORT', 'RAYA_RETRIEVAL_TOKEN_FILE', 'RAYA_RETRIEVAL_RECEIPT_ROOT',
                 'RAYA_RETRIEVAL_RECEIPT_SID', 'RAYA_RETRIEVAL_RECEIPT_GENERATIONS',
                 'RAYA_RETRIEVAL_MIN_RAM_GIB', 'RAYA_RETRIEVAL_TIMEOUT'}
    if set(env) - system - private - (memory if plan['kind'] == 'memory' else retrieval):
        reject('Unreviewed environment field')
    for name in ('TEMP', 'TMP', 'HF_HOME'):
        path = Path(env[name])
        if path != root and root not in path.parents:
            reject('Private cache path required')
    if env.get('HF_HUB_OFFLINE') != '1' or env.get('TRANSFORMERS_OFFLINE') != '1' or env.get('PYTHONDONTWRITEBYTECODE') != '1':
        reject('Offline no-bytecode loading required')
    paths = ['RAYA_MEMORY_ROOT', 'RAYA_MEMORY_TOKEN_FILE', 'RAYA_MEMORY_OPERATION_ROOT',
             'RAYA_MEMORY_RETRIEVAL_TOKEN_FILE'] if plan['kind'] == 'memory' else [
             'RAYA_RETRIEVAL_TOKEN_FILE', 'RAYA_RETRIEVAL_RECEIPT_ROOT']
    selected = notes(plan, images, managed)
    for name in paths:
        path = Path(env[name])
        if name == 'RAYA_MEMORY_ROOT' and selected == path:
            continue
        if path != root and root not in path.parents:
            reject('Service input outside disposable root')
    home = root/'home' if managed else root
    if env.get('HOME') != str(home) or env.get('USERPROFILE') != str(home):
        reject('Private service HOME required')
    if env.get('PYTHONPATH') or env.get('PYTHONHOME'):
        reject('Ambient Python import overrides refused')
    if managed:
        namespaces(plan, images)
    return plan, images


def notes(plan, images, managed):
    selected = plan.get('notes_selection')
    if 'notes_selection' not in plan:
        return None
    if not managed or plan['kind'] != 'memory' or not isinstance(selected, dict) or set(selected) != {'root', 'system', 'generations'}:
        reject('Explicit managed notes selection required')
    root = Path(selected['root']) if isinstance(selected['root'], str) else None
    system = Path(selected['system']) if isinstance(selected['system'], str) else None
    if root is None or system != root/'System' or plan['env']['RAYA_MEMORY_ROOT'] != str(root):
        reject('Selected notes root/System differs')
    tuples = selected['generations']
    if not isinstance(tuples, dict) or set(tuples) != {'root', 'system'}:
        reject('Exact selected notes generations required')
    for value in tuples.values():
        if not isinstance(value, list) or len(value) != 3 or any(
                not isinstance(item, str) or not 1 <= len(item) <= 20 or not item.isascii() or not item.isdecimal() or
                str(int(item)) != item or int(item) > 2**64-1 for item in value):
            reject('Selected notes uint64 strings required')
    raw = plan['env']['RAYA_MEMORY_NOTE_GENERATIONS']
    def pairs(items):
        result = {}
        for name, value in items:
            if name in result:
                reject('Duplicate selected notes generation field')
            result[name] = value
        return result
    observed = json.loads(raw, object_pairs_hook=pairs) if isinstance(raw, str) and len(raw) <= 4096 else None
    if (not isinstance(observed, dict) or set(observed) != {'root', 'system'} or any(
            not isinstance(value, list) or len(value) != 3 or any(type(item) is not int for item in value)
            for value in observed.values()) or
            {name: [str(item) for item in value] for name, value in observed.items()} != tuples):
        reject('Selected notes environment generation differs')
    source = Path(plan['source'])/'namespace.py'
    module = {'__name__': 'managed_selected_notes', '__file__': str(source)}
    exec(compile(images[source], str(source), 'exec'), module)
    for name, path in (('root', root), ('system', system)):
        if not path.is_absolute() or path.resolve() != path:
            reject('Canonical selected notes directory required')
        for parent in (path, *path.parents):
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                reject('Ordinary selected notes ancestry required')
        if [str(item) for item in module['generation'](path)] != tuples[name]:
            reject('Selected notes directory generation differs')
    return root


def namespaces(plan, images):
    # Execute only the reviewed stdlib/ctypes namespace validator before START,
    # never the service, tokenizer, native inference or dependency import path.
    if plan['kind'] not in ('memory', 'retrieval'):
        reject('Managed service selection required')
    source = Path(plan['source'])/'namespace.py'
    module = {'__name__': 'managed_selected_namespace', '__file__': str(source)}
    exec(compile(images[source], str(source), 'exec'), module)
    choices = ((plan['env'], 'RAYA_RETRIEVAL_RECEIPT'),)
    if plan['kind'] == 'memory':
        selected = plan.get('retrieval_selection')
        if not isinstance(selected, dict) or set(selected) != {'RAYA_RETRIEVAL_RECEIPT_ROOT',
                                                              'RAYA_RETRIEVAL_RECEIPT_SID',
                                                              'RAYA_RETRIEVAL_RECEIPT_GENERATIONS'}:
            reject('Independent Retrieval namespace selection required')
        choices = ((plan['env'], 'RAYA_MEMORY_OPERATION'), (selected, 'RAYA_RETRIEVAL_RECEIPT'))
    for env, prefix in choices:
        root = Path(env[prefix+'_ROOT'])
        if Path(plan['root']) not in root.parents:
            reject('Selected namespace outside managed root')
        raw = env[prefix+'_GENERATIONS']
        if not isinstance(raw, str):
            reject('Original namespace generation text required')
        module['Namespace'](root, env[prefix+'_SID'], json.loads(raw))


class Sources(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, source, images):
        self.source = source
        self.images = images

    def find_spec(self, fullname, path=None, target=None):
        file = self.source / (fullname + '.py')
        if file not in self.images:
            return None
        return importlib.util.spec_from_loader(fullname, self, origin=str(file))

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        file = self.source / (module.__name__ + '.py')
        module.__file__ = str(file)
        exec(compile(self.images[file], str(file), 'exec'), module.__dict__)


def prepare(plan):
    # The validated private import environment precedes native initialization.
    os.environ.clear()
    os.environ.update(plan['env'])
    sys.path[:] = [path for path in sys.path if path and Path(path).is_relative_to(Path(sys.base_prefix))]
    sys.path.append(str(Path(plan['dependencies'])))
    if plan['kind'] == 'memory':
        # NumPy native initialization must precede the blocking stdin reader.
        import numpy
        from transformers import AutoTokenizer


def serve(plan, images):
    errors = []
    state = {'server': None, 'stop': False, 'control_eof': False}
    guard = threading.Lock()

    def stop():
        with guard:
            state['stop'] = True
            if state['server'] is not None:
                state['server'].should_exit = True

    def control():
        try:
            raw = sys.stdin.buffer.readline(7)
            if raw not in (b'', b'STOP\n', b'STOP\r\n'):
                reject('Literal STOP or original stdin EOF required')
            state['control_eof'] = raw == b''
            phase('control-eof' if raw == b'' else 'control-stop')
        except BaseException as error:
            errors.append(error)
        finally:
            stop()

    # The original reader starts after NumPy preload, before accepted service import.
    thread = threading.Thread(target=control, name='memory-original-control', daemon=False)
    module = {'__name__': '__main__', '__file__': str(Path(plan['source']) / 'server.py')}
    try:
        prepare(plan)
        thread.start()
        sys.meta_path.insert(0, Sources(Path(plan['source']), images))
        phase('import-started')
        import uvicorn

        class Server(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets=sockets)
                if self.started:
                    phase('uvicorn-started')

            @contextlib.contextmanager
            def capture_signals(self):
                # Only the retained original control reader requests ordinary exit.
                yield

        def run(app, host, port, access_log):
            if host != '127.0.0.1' or port != plan['port'] or access_log is not False:
                reject('Selected loopback entrypoint differs')
            phase('service-imported')
            server = Server(uvicorn.Config(app, host=host, port=port, access_log=False,
                                          timeout_graceful_shutdown=None, log_config=None))
            with guard:
                state['server'] = server
                server.should_exit = state['stop']
            server.run()
            phase('serve-returned')

        # Run the genuine retained entrypoint and its existing finally hooks.
        uvicorn.run = run
        file = Path(plan['source']) / 'server.py'
        exec(compile(images[file], str(file), 'exec'), module)
    except BaseException as error:
        errors.append(error)
    finally:
        stop()
        # If an earlier original finalizer raised, still attempt every independent pool.
        for name in ('POOL', 'STORAGE'):
            pool = module.get(name)
            if pool is None:
                continue
            try:
                pool.shutdown(wait=True, cancel_futures=name == 'POOL')
            except BaseException as error:
                errors.append(error)
        # A pending blocked control reader is retained until Root sends STOP/EOF.
        if thread.ident is None:
            try:
                thread.start()
            except BaseException as error:
                errors.append(error)
        if thread.ident is not None:
            thread.join()
        else:
            errors.append(RuntimeError('Original control reader was not started'))
        for record in module.get('RECORDS', {}).values():
            for name in ('reservation', 'future', 'publication', 'terminal_write'):
                future = record.get(name)
                if future is None:
                    continue
                try:
                    future.result()
                except BaseException as error:
                    errors.append(error)
        if module.get('ACTIVE', 0) != 0 or module.get('JOBS') or module.get('UNCERTAIN'):
            errors.append(RuntimeError('Original service retirement unconfirmed'))
        for item in plan['files']:
            try:
                info = Path(item['path']).lstat()
                if [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink] != item['identity']:
                    reject('Admitted input identity changed through closure')
            except BaseException as error:
                errors.append(error)
        phase('terminal')
        emit({'format': 'raya.memory.disposable.supervisor.closed', 'kind': plan['kind'],
              'passed': not errors, 'control_joined': thread.ident is not None and not thread.is_alive(),
              'control_eof': state['control_eof'], 'errors': [type(error).__name__ for error in errors],
              'worker_proof': 'Selected producer only; no independently authenticated native retirement'})
    if errors:
        raise BaseExceptionGroup('Original service failures retained', errors)


def gate():
    # No private environment, model/native module or service body enters before
    # the original parent has durably bound selection and actual child identity.
    phase('launch-selected')
    raw = sys.stdin.buffer.readline(8)
    if raw in (b'', b'STOP\n', b'STOP\r\n'):
        emit({'format': 'raya.memory.disposable.supervisor.pre-start-closed', 'passed': True,
              'started': False, 'gate_joined': True, 'verification_joined': True,
              'control_eof': raw == b'', 'errors': [],
              'worker_proof': 'Original verification executor and START gate only; no producer/native/cold authority'})
        return False
    if raw not in (b'START\n', b'START\r\n'):
        reject('Literal original START gate required')
    return True


if __name__ == '__main__':
    managed = len(sys.argv) == 4 and sys.argv[1] == '--managed'
    if (not managed and len(sys.argv) != 3) or not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        reject('Fixed isolated no-site no-bytecode invocation required')
    phase('closure-started')
    cfg, images = load(sys.argv[2] if managed else sys.argv[1], sys.argv[3] if managed else sys.argv[2], managed)
    phase('closure-verified')
    if not managed or gate():
        serve(cfg, images)
