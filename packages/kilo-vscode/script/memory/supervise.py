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


RELEASES = {'memory': {'server.py': '544647a72b12536dcd7223d3bec10c49f547ead30feb36f10f9a66f14b13418e', 'index.py': '249a099fb797cf0f3b1d2aaa2a951117d9ddd280721125f1c7ea18ca5635c97d', 'notes.py': '59488d324200d95b0974bfa119215de627bc1b17dd3233fc6b02ab137b651923', 'policy.py': '87c931cfa7cceb7386e6d2b4b05fdacf916360fd2cb0ff590d0fccf5dd334ae2', 'admission.py': '347561aafc7467a24f7871714fc08f511e1f1509c3ade56fbfa00d71a30eae86', 'host.py': '4854ab90b06085450136e764ec1f70034ae27c597af9b6fa98a99860aa049a97', 'operations.py': '385a248e4f4e93f9e9849cc630412957428994b89e228dcf84c9833495c06296', 'retirement.py': 'f31e2535b7793f93ce0c556eb50c9bf774270bce6e86582e1c47ef661794a1da', 'namespace.py': '0df00525c58bc5c57bb11dbee48cb71785a6c40ee178a011c90a5883dbe26a72', 'dispatch.py': '50c6c5ab29519e3cdad4f226b8d5f0c5e30fc407966dd0706a10bd328f96dc35', 'historical.py': '54c171bd12735ed04c0aa08ced0778b4f4de3284c1fd1dac47cdd6a2f429c524', 'proposals.py': 'fbfd07c0bbe71439d21399d06eac37f8712aff1f24f509697e01f39802c301e0'}, 'retrieval': {'worker.py': 'e5e3d135ebe3806097c9937c3d0429574622358a77b4beb14c2f9ee932e0d721', 'models.py': '2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873', 'validation.py': '905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2', 'server.py': '6bba99a267420d0e519d8db1f26848af16999ac7b339487f2da4fd0261e73ecb', 'namespace.py': '5cc018c7340b6225544ab43120a71eadcd1699ad38a05be7df3826115c7689b3', 'bootstrap.py': '530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d', 'owner.py': 'fb629212836e2958df0beb49fbc6b56fa38da7956d81eac06f8aeaa9ecf6a446'}}


CAPTURE = {'server.py': '8764ed7600cefb9a33684e06d35ca82df8b408284849fb47442701e9b164443c', 'index.py': 'dbbe3a56da1222956dc1d1d8a082e78a5920fc4ccef9275416f68e45c8795f8e', 'notes.py': 'e43105220aa739664bfbaecc6638d36fb201e0da55052da6403f7015f9034643', 'policy.py': '87c931cfa7cceb7386e6d2b4b05fdacf916360fd2cb0ff590d0fccf5dd334ae2', 'admission.py': '347561aafc7467a24f7871714fc08f511e1f1509c3ade56fbfa00d71a30eae86', 'host.py': '4854ab90b06085450136e764ec1f70034ae27c597af9b6fa98a99860aa049a97', 'operations.py': 'a0641dc9072841c30c207ab5327ce5adc19e1151626a1b3e43259a6b2ca123cb', 'retirement.py': 'f31e2535b7793f93ce0c556eb50c9bf774270bce6e86582e1c47ef661794a1da', 'namespace.py': '0df00525c58bc5c57bb11dbee48cb71785a6c40ee178a011c90a5883dbe26a72', 'historical.py': '2d97c96d13b906d8aadcae47a89704cb1b839f5e09da144ca28bd20a0af779bc', 'dispatch.py': '50c6c5ab29519e3cdad4f226b8d5f0c5e30fc407966dd0706a10bd328f96dc35', 'proposals.py': 'fbfd07c0bbe71439d21399d06eac37f8712aff1f24f509697e01f39802c301e0', 'capture.py': 'b059c9bb84a176c86e5ff7b7e35b1470cba30fdfec5fb7dcdef4d829298b0dfe'}

REUSE = {'retrieval/bootstrap.py': '530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d', 'retrieval/models.py': '2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873', 'retrieval/namespace.py': '5cc018c7340b6225544ab43120a71eadcd1699ad38a05be7df3826115c7689b3', 'retrieval/owner.py': 'fb629212836e2958df0beb49fbc6b56fa38da7956d81eac06f8aeaa9ecf6a446', 'retrieval/server.py': '6bba99a267420d0e519d8db1f26848af16999ac7b339487f2da4fd0261e73ecb', 'retrieval/validation.py': '905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2', 'retrieval/worker.py': 'e5e3d135ebe3806097c9937c3d0429574622358a77b4beb14c2f9ee932e0d721', 'retrieval_reuse/bootstrap.py': 'cc424607c0b6d9b8565602d11027a4e1c65e769d06af8eaa89b581ec7ff30a6a', 'retrieval_reuse/entry.py': 'fbb6113cb571ef682001aacf5877e3fa3b5927714223889391fde29b226dea9b', 'retrieval_reuse/lease.py': '308eeeab2ffbd8ae1e7db9b1da238c442829aec0cd1ab9ea5202a8d8e3412a3d', 'retrieval_reuse/living.py': 'bc75c4be4d9ced06e9bca4c2408430a1d1fb084a827762e81a3b5ec0043d261a', 'retrieval_reuse/pool.py': 'c6938930c0090dfab5369de422b659aa28410c714fc1e1ac6e88d8dcbdb0955a', 'retrieval_reuse/receipts.py': 'cab18d5ac5461e045eb283f480eefbd175fa96b8b4fefe8e0353af5f4269ffa3', 'retrieval_reuse/resident.py': 'f5ba90a93cdb55aecef91ba0017a30cc824719c0e840aacf0e5f2026a72fb039', 'retrieval_reuse/server.py': 'dece9b933f6a62ae5886c9fe66607bc505b177aaa410791030ac06b7d2858280', 'retrieval_reuse/session.py': '487cbfdb0724162b1772e685350c212d16328eaa800d644a18a4de009793fb5c'}


REUSED = {'retrieval/bootstrap.py': '530527b8df81642dd9ab420841d478e3ff25d46e2476be46aa2fefb9b91dc37d', 'retrieval/models.py': '2b60cf34c3532374e3e68748240850525a5c46a7056a126be26ee5356decb873', 'retrieval/namespace.py': '5cc018c7340b6225544ab43120a71eadcd1699ad38a05be7df3826115c7689b3', 'retrieval/owner.py': 'fb629212836e2958df0beb49fbc6b56fa38da7956d81eac06f8aeaa9ecf6a446', 'retrieval/server.py': '6bba99a267420d0e519d8db1f26848af16999ac7b339487f2da4fd0261e73ecb', 'retrieval/validation.py': '905626e694e5ac1f8742ecad6bddbc619301f8a8f8e5ab0da4ed60990be0d6e2', 'retrieval/worker.py': 'e5e3d135ebe3806097c9937c3d0429574622358a77b4beb14c2f9ee932e0d721', 'retrieval_reuse/bootstrap.py': 'cc424607c0b6d9b8565602d11027a4e1c65e769d06af8eaa89b581ec7ff30a6a', 'retrieval_reuse/entry.py': '88d9a50d99e1ed1930847b38f79142d13e4d443b180eb616956a8d8b3b6292ce', 'retrieval_reuse/lease.py': '308eeeab2ffbd8ae1e7db9b1da238c442829aec0cd1ab9ea5202a8d8e3412a3d', 'retrieval_reuse/living.py': 'bc75c4be4d9ced06e9bca4c2408430a1d1fb084a827762e81a3b5ec0043d261a', 'retrieval_reuse/pool.py': '4a0c0c12964ae99ae0a949d9d561c78226a71d42e2404052abc3c8760040db1c', 'retrieval_reuse/receipts.py': 'cab18d5ac5461e045eb283f480eefbd175fa96b8b4fefe8e0353af5f4269ffa3', 'retrieval_reuse/resident.py': 'f5ba90a93cdb55aecef91ba0017a30cc824719c0e840aacf0e5f2026a72fb039', 'retrieval_reuse/server.py': 'f1cee409152d2a5832411087dea53ae8fe92857aceee86947de27ee60c8258ee', 'retrieval_reuse/session.py': '487cbfdb0724162b1772e685350c212d16328eaa800d644a18a4de009793fb5c'}
FINITE_PREVIOUS = RELEASES['retrieval']
RELEASES = dict(RELEASES, retrieval=dict(FINITE_PREVIOUS, **{'bootstrap.py': '27a1b3edd73c7f10d38aa4737a54601e9abc7acfa812327845b93e9b7af39646', 'owner.py': '374028df76227eb1b758b0c8fac07b444f5bbbf8b12c26faad2904d7bccebf1b'}))
REUSE_PREVIOUS = REUSE
REUSE = dict(REUSE_PREVIOUS, **{'retrieval_reuse/pool.py': '5abd1acf33a4dd0bf4de83f1bd392add89948b113e9c381039369fed56247e8e'})
REUSE_COLD = REUSE
REUSE = dict(REUSE_COLD, **{'retrieval/bootstrap.py': '27a1b3edd73c7f10d38aa4737a54601e9abc7acfa812327845b93e9b7af39646', 'retrieval/owner.py': '374028df76227eb1b758b0c8fac07b444f5bbbf8b12c26faad2904d7bccebf1b', 'retrieval_reuse/bootstrap.py': '9c16ad3d709d1cf4623cc6637c28a11654e7984d855210a4e3e898c9600c30a3', 'retrieval_reuse/entry.py': '5a81460ac8a553abb27160f93e8af85d678a9a42f4009e86ca736d9bd83480b6', 'retrieval_reuse/session.py': '950521fc3ca2bd0b3c6926689d69ec449f110ec4ac3c3643f1636cfccc18a6db'})
PREVIOUS = [CAPTURE, dict(CAPTURE, **{'index.py': '8ae8274ff8f46f906efc9c6c5e2dbd2445315f27dc371bd07485fb71635f20f3'})]
PREVIOUS += (dict(CAPTURE, **{'index.py': '89fcbf572c83a25bc39f8e646fcd080330ddb1605cb89c65c8240f9d2ae0a9dc'}),)
CAPTURE = dict(CAPTURE, **{'server.py': 'deb92041d4cc08c64d64403cb23edfe71221105b2c8094a064aa1e184a168b8b', 'index.py': 'e6f14470dbbe65d1ab6e0c2d0707253b2951bfa6ff529de6e7271c9ba376b5d7'})

PREVIOUS.append(CAPTURE)
CAPTURE = dict(CAPTURE, **{'server.py': 'ddcffa6ec22432f1622850aa36e04e48cfe8cad94db28648e1b6b8dd2fefcf1d'})
CLOSED = CAPTURE
PREVIOUS.append(CLOSED)
CAPTURE = dict(CLOSED, **{'index.py': '3c106c8e45267ee808a3c2bd8dfacf85a4d3c1ca47e23785706d7663d6791f65'})
PREVIOUS.append(CAPTURE)
CAPTURE = dict(CAPTURE, **{
    'server.py': 'd3b3bba2166c30358442a1ef274d18a272d8e1a1f1c3ea44b70276dc61932af6',
    'index.py': 'b6bd48d00bca2565c8c6690691b7f9b1e2e7680abbd48058ab62b4a2770ef5cd',
    'entries.py': '20b59cdc4a4ea3b5124ee81c0950ffbb6429ba05dcd6f0ac8d9d8656c2a13472',
    'management.py': '0794a56bc81e326431d8bbcc961d1e703e03062d18cd9088d9ceae85366d8324',
})
MANAGED = CAPTURE
PREVIOUS.append(MANAGED)
CAPTURE = dict(MANAGED, **{'historical.py': '81c2d9bc84acb94d05d026ef22430a3de262270b968a9e093c22be107a6f7d10'})
RECOVERED = CAPTURE
PREVIOUS.append(RECOVERED)
CAPTURE = dict(RECOVERED, **{'index.py': '699f9d1af1083e9b751b5c08ed71077bafd9809fa1d32918d276e202770aa96c'})
RECALL = CAPTURE
PREVIOUS.append(RECALL)
CAPTURE = dict(RECALL, **{'index.py': '008f7051d51cdd7bd0edaa2802630ce87b09766be470d9b8f2b3dc494677889e'})

def release(kind, pins, reuse=False):
    capture = next((value for value in PREVIOUS if pins == value), CAPTURE)
    selected = (REUSED if pins == REUSED else REUSE_PREVIOUS if pins == REUSE_PREVIOUS else REUSE_COLD if pins == REUSE_COLD else REUSE) if reuse else capture if kind == 'memory' and 'capture.py' in pins else FINITE_PREVIOUS if kind == 'retrieval' and pins == FINITE_PREVIOUS else RELEASES[kind]
    if len(pins) != len(selected) or pins != selected:
        reject('Exact selected service release required')
    return selected


def reject(message):
    raise ValueError(message)


def reusable(plan):
    protocol = plan.get('retrieval_protocol', 'raya.retrieval.retirement.v1')
    if protocol not in ('raya.retrieval.retirement.v1', 'raya.retrieval.request.settlement.v2'):
        reject('Explicit retrieval protocol selection differs')
    if 'retrieval_protocol' in plan and plan['kind'] != 'retrieval':
        reject('Retrieval protocol belongs to Retrieval only')
    return protocol == 'raya.retrieval.request.settlement.v2'


def entry(plan):
    return Path(plan['source'])/('retrieval_reuse/entry.py' if reusable(plan) else 'server.py')


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


def diagnostics():
    """Observe the original selected pool without changing its admission or settlement."""
    import pool
    original = pool.Pool
    available = pool.available
    resources = getattr(pool, 'resources', lambda: (available(), None))
    local = threading.local()
    causes = {'pool_memory_reserve': 503, 'lease_memory_pressure': 503,
              'pool_queue_expired': 504, 'pool_before_dispatch_cancelled_or_expired': 504,
              'pool_queue_cancelled': 499, 'pool_closed': 499,
              'pool_before_inference_cancelled_or_expired': 500, 'lease_start_expired': 500,
              'lease_start_deadline': 500, 'lease_selection': 500, 'fixed_request_identity': 500,
              'receipt_namespace_changed': 500, 'receipt_directory_identity': 500,
              'source_identity': 500, 'source_selection': 500, 'source_changed': 500,
              'pool_worker_failed': 500}

    def measured():
        value, commit = resources()
        current = getattr(local, 'current', None)
        if current is not None and len(current['samples']) < 32:
            owner, ticket = current['pool'], current['ticket']
            headroom = (pool.budget(ticket.kind, ticket.body['model'], owner.revisions[ticket.body['model']], owner.text, owner.owner is not None)
                        if hasattr(pool, 'budget') else pool.GIB // 2 if owner.owner is not None else
                        5 * pool.GIB if ticket.body['model'] == 'embeddinggemma-2' else 13 * pool.GIB // 4)
            cold = owner.owner is None and ticket.body['model'] == 'embeddinggemma-2'
            required = pool.required(owner.reserve, headroom, cold) if hasattr(pool, 'required') else owner.reserve + headroom
            current['samples'].append({'observed_unix_ms': time.time_ns() // 1000000,
                                      'available_ram_bytes': value,
                                      'available_commit_bytes': commit,
                                      'reserve_ram_bytes': owner.reserve,
                                      'admission_headroom_bytes': required - owner.reserve,
                                      'model_budget_bytes': headroom,
                                      'cold_gemma': cold,
                                      'original_owner_present': owner.owner is not None,
                                      'settling_enabled': getattr(owner, 'settle', False),
                                      'required_ram_bytes': required})
        return value, commit

    class Observed(original):
        def invoke(self, ticket):
            current = {'pool': self, 'ticket': ticket, 'samples': []}
            ticket.diagnostic = current['samples']
            local.current = current
            try:
                return super().invoke(ticket)
            finally:
                local.current = None

        def complete(self, ticket, error=None, result=None):
            if error is not None and result is None and (ticket.owner is None or not ticket.owner.created):
                cause = error if error in causes else 'preworker_unclassified'
                value = {'format': 'raya.retrieval.preworker.refusal', 'version': 1,
                         'request': ticket.request, 'owner_epoch': self.epoch,
                         'selected_release_sha256': self.release,
                         'cause': cause, 'http_status': 499 if ticket.cancel.is_set() else causes.get(cause, 500),
                         'observed_unix_ms': time.time_ns() // 1000000,
                         'memory': getattr(ticket, 'diagnostic', []),
                         'settlement_authority': False, 'replay': False}
                try:
                    folder = self.namespace.folder('Runs', self.epoch, ticket.request)
                    self.namespace.publish(folder, '000000.json',
                                           json.dumps(value, sort_keys=True, separators=(',', ':')).encode('utf-8'))
                except Exception:
                    # Diagnostic persistence cannot reclassify the original request or conceal its failure.
                    with PHASE:
                        emit({'format': 'raya.retrieval.preworker.diagnostic-failure', 'version': 1,
                              'settlement_authority': False})
            return super().complete(ticket, error, result)

    if hasattr(pool, 'resources'):
        pool.resources = measured
    else:
        pool.available = lambda: measured()[0]
    pool.Pool = Observed


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
    reuse = reusable(plan)
    selected = release(plan['kind'], pins, reuse)
    selected = {source / name for name in pins}
    paths, images = dependencies(plan['files'], selected)
    deps = Path(plan['dependencies'])
    if not any(path.is_relative_to(deps) for path in paths):
        reject('Reviewed dependency closure required')
    for name, sha in pins.items():
        if (not reuse and Path(name).name != name) or not name.endswith('.py') or digest(images[source / name]) != sha:
            reject('Selected service source differs')
    env = plan['env']
    system = {'SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS',
              'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER'}
    private = {'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'HF_HOME', 'HF_HUB_OFFLINE',
               'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_PROGRESS_BARS', 'PYTHONDONTWRITEBYTECODE'}
    memory = {'RAYA_MEMORY_ROOT', 'RAYA_MEMORY_PORT', 'RAYA_MEMORY_TOKEN_FILE',
              'RAYA_MEMORY_OPERATION_ROOT', 'RAYA_MEMORY_OPERATION_SID', 'RAYA_MEMORY_OPERATION_GENERATIONS',
              'RAYA_MEMORY_NOTE_GENERATIONS', 'RAYA_MEMORY_RETRIEVAL_TOKEN_FILE',
              'RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256', 'RAYA_RETRIEVAL_PORT', 'RAYA_MEMORY_EMBEDDING_MODEL',
              'RAYA_MEMORY_RETRIEVAL_PROTOCOL'}
    retrieval = {'RAYA_RETRIEVAL_PORT', 'RAYA_RETRIEVAL_TOKEN_FILE', 'RAYA_RETRIEVAL_RECEIPT_ROOT',
                 'RAYA_RETRIEVAL_RECEIPT_SID', 'RAYA_RETRIEVAL_RECEIPT_GENERATIONS',
                 'RAYA_RETRIEVAL_MIN_RAM_GIB', 'RAYA_RETRIEVAL_TIMEOUT'}
    if reuse:
        retrieval.add('RAYA_RETRIEVAL_RELEASE_SHA256')
        retrieval.add('RAYA_RETRIEVAL_OLLAMA_SETTLE')
        if env.get('RAYA_RETRIEVAL_OLLAMA_SETTLE', '0') not in ('0', '1'):
            reject('Selected local residency policy differs')
        value = env.get('RAYA_RETRIEVAL_RELEASE_SHA256')
        if not isinstance(value, str) or len(value) != 64 or any(char not in '0123456789abcdef' for char in value):
            reject('Independent reusable release selection required')
    if set(env) - system - private - (memory if plan['kind'] == 'memory' else retrieval):
        reject('Unreviewed environment field')
    if env.get('RAYA_MEMORY_EMBEDDING_MODEL', 'qwen3-embedding-0.6b') not in ('qwen3-embedding-0.6b', 'embeddinggemma-2'):
        reject('Unsupported embedding model selection')
    if env.get('RAYA_MEMORY_RETRIEVAL_PROTOCOL', 'raya.retrieval.retirement.v1') not in ('raya.retrieval.retirement.v1', 'raya.retrieval.request.settlement.v2'):
        reject('Unsupported downstream ownership protocol selection')
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
    source = Path(plan['source'])/('retrieval/namespace.py' if reusable(plan) else 'namespace.py')
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
    def __init__(self, source, images, reuse=False):
        self.source = source
        self.images = images
        self.reuse = reuse

    def file(self, name):
        if not self.reuse:
            return self.source/(name+'.py')
        if name in ('bootstrap', 'entry', 'lease', 'living', 'pool', 'receipts', 'resident', 'server', 'session'):
            return self.source/'retrieval_reuse'/(name+'.py')
        if name in ('models', 'namespace', 'owner', 'validation', 'worker'):
            return self.source/'retrieval'/(name+'.py')
        return None

    def find_spec(self, fullname, path=None, target=None):
        file = self.file(fullname)
        if file not in self.images:
            return None
        return importlib.util.spec_from_loader(fullname, self, origin=str(file))

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        file = self.file(module.__name__)
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
        if plan['source_sha256'] in (CAPTURE, RECALL, RECOVERED, MANAGED, CLOSED):
            import tokenizers
            return
        from transformers import AutoTokenizer


def settled(record, name, future):
    """Join the original Future; only its own successful publication can classify a failed inference."""
    try:
        return future.result()
    except BaseException:
        publication = record.get('publication')
        terminal = record.get('terminal')
        pending = record.get('pending')
        if (name != 'future' or record.get('phase') != 'terminal' or record.get('faults') or
                publication is None or not publication.done() or publication.cancelled() or
                publication.exception() is not None or publication.result() is not terminal or
                not isinstance(terminal, dict) or not isinstance(pending, dict) or
                terminal.get('status') != 'terminal' or
                terminal.get('operation_outcome') not in ('cancelled', 'failed') or
                any(terminal.get(key) != pending.get(key) for key in
                    ('format', 'request', 'owner_epoch', 'selected_release_sha256', 'kind', 'request_sha256'))):
            raise
        body = {key: value for key, value in terminal.items() if key != 'receipt_sha256'}
        raw = json.dumps(body, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if hashlib.sha256(raw).hexdigest() != terminal.get('receipt_sha256'):
            raise
        # Journal.complete already validates the downstream certificates before this
        # same original publication Future succeeds. Never inspect or adopt disk receipts here.
        return None


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
    module = {'__name__': '__main__', '__file__': str(entry(plan))}
    try:
        prepare(plan)
        thread.start()
        sys.meta_path.insert(0, Sources(Path(plan['source']), images, reusable(plan)))
        if reusable(plan):
            diagnostics()
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
        file = entry(plan)
        exec(compile(images[file], str(file), 'exec'), module)
    except BaseException as error:
        errors.append(error)
    finally:
        stop()
        runtime = module.get('RUNTIME')
        if runtime is not None:
            try:
                value = runtime.close()
                if (not value['closed'] or not value['original_coordinator_joined'] or value['ownership_retained'] or
                        not value['request_publications_confirmed'] or not value['request_admissions_joined']):
                    reject('Original reusable service closure unconfirmed')
            except BaseException as error:
                errors.append(error)
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
                    settled(record, name, future)
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
