"""Rebuildable Markdown retrieval index. No note rewriting or capture worker."""
import argparse
from contextlib import contextmanager
import fnmatch
import hashlib
import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from notes import clean
from admission import Store, Refused, Retirement, closing, entry, leaf
from policy import Policy
from retirement import decode as metadata, certificate, canonical, fingerprint, hex as hexadecimal
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import threading

CANCEL = ContextVar('memory_cancel', default=None)
LEASE = ContextVar('memory_admission', default=None)
CORRELATION = ContextVar('memory_request_correlation', default=None)
PROOFS = ContextVar('memory_worker_proofs', default=None)


def admitted(call):
    @wraps(call)
    def run(self, *args, **kwargs):
        lease = LEASE.get()
        if lease is not None:
            if lease.store is not self.store:
                raise Refused('A different admission root is already active.')
            lease.check()
            return call(self, *args, **kwargs)
        with self.store.lease() as lease:
            token = LEASE.set(lease)
            try:
                return call(self, *args, **kwargs)
            finally:
                LEASE.reset(token)
    return run


class Cancelled(RuntimeError):
    pass


DEADLINE = ContextVar('memory_deadline', default=None)


def remaining():
    cancel = CANCEL.get()
    if cancel is not None and cancel.is_set():
        raise Cancelled('Memory operation cancellation requested.')
    until = DEADLINE.get()
    value = 170 if until is None else until - time.monotonic()
    if value <= 0:
        raise TimeoutError('Memory operation deadline expired.')
    return value


@contextmanager
def operation(until=None, cancel=None):
    prior = DEADLINE.get()
    until = time.monotonic() + 170 if until is None else until
    token = DEADLINE.set(until if prior is None else min(prior, until))
    signal = CANCEL.set(CANCEL.get() or cancel)
    try:
        remaining()
        yield
    finally:
        CANCEL.reset(signal)
        DEADLINE.reset(token)


def bounded(call):
    @wraps(call)
    def run(*args, **kwargs):
        with operation():
            return call(*args, **kwargs)
    return run


def execute(call, until, cancel=None, correlation=None, proofs=None):
    token = CORRELATION.set(correlation)
    receipts = PROOFS.set(proofs)
    try:
        with operation(until, cancel):
            return call()
    finally:
        PROOFS.reset(receipts)
        CORRELATION.reset(token)


os.environ['HF_HUB_OFFLINE'] = '1'
ROOT = Path(__file__).parent
CATALOG = Path(r'D:\Raya\Models\Catalog')
MODEL = json.loads((CATALOG / 'Qwen--Qwen3-Embedding-0.6B.json').read_text(encoding='utf-8-sig'))
RANKER = json.loads((CATALOG / 'Qwen--Qwen3-Reranker-0.6B.json').read_text(encoding='utf-8-sig'))
TOKENIZER = None
GATE = threading.Lock()
KEY = Path(os.environ['RAYA_MEMORY_RETRIEVAL_TOKEN_FILE']).read_text().strip()
RELEASE = os.environ['RAYA_MEMORY_RETRIEVAL_RELEASE_SHA256']
if not hexadecimal(RELEASE, 64):
    raise Refused('Explicit reviewed downstream release selection is required.')
SIGNATURE = 'markdown-v3:300tokens:1024:normalized:local-link-labels:' + MODEL['revision']


def digest(value):
    return hashlib.sha256(value).hexdigest()


def decode(raw):
    remaining()
    import numpy as np
    remaining()
    if not isinstance(raw, bytes) or len(raw) != 1024 * 4:
        raise sqlite3.DatabaseError('Cached embedding has an invalid shape; rebuild the index.')
    vector = np.frombuffer(raw, dtype=np.float32)
    if not np.isfinite(vector).all() or abs(np.linalg.norm(vector) - 1) > 0.001:
        raise sqlite3.DatabaseError('Cached embedding is not finite and normalized; rebuild the index.')
    return vector


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def api(path, body, gate=None):
    if path == '/v1/embeddings' and isinstance(body.get('input'), str):
        body = dict(body, input=[body['input']])
    port = int(os.environ.get('RAYA_RETRIEVAL_PORT', '8873'))
    if not 1024 <= port <= 65535:
        raise ValueError('Retrieval port is outside the local service range.')
    budget = min(150, remaining() - 5)
    if budget < 0.001:
        raise TimeoutError('Insufficient memory budget for another retrieval request.')
    key = uuid.uuid4().hex
    origin = f'http://127.0.0.1:{port}'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirect())
    cancel = CANCEL.get()
    until = time.monotonic() + remaining()
    stop = threading.Event()
    errors = []
    lease = LEASE.get()
    if lease is None:
        raise Refused('Retrieval submission requires a held admission lease.')
    lease.check()
    parent = CORRELATION.get()
    proofs = PROOFS.get()
    if not hexadecimal(parent, 32) or not isinstance(proofs, list):
        raise Refused('Original Memory correlation and receipt owner are required.')
    auth = {'Authorization': 'Bearer '+KEY}
    with opener.open(urllib.request.Request(origin+'/health', headers=auth), timeout=2) as response:
        health = metadata(response.read(65537))
    if not isinstance(health, dict) or health.get('selected_release_sha256') != RELEASE or health.get('ownership_protocol') != 'raya.retrieval.retirement.v1' or health.get('ready') is not True or health.get('retirement_unconfirmed') is not False or health.get('draining') is not False or not hexadecimal(health.get('owner_epoch'), 32):
        raise Retirement('Selected downstream ownership admission differs.')
    sources, catalogs = health.get('source_sha256'), health.get('catalog_sha256')
    if not isinstance(sources, dict) or set(sources) != {'server.py', 'owner.py', 'bootstrap.py', 'worker.py', 'models.py', 'validation.py', 'namespace.py'} or not isinstance(catalogs, dict) or set(catalogs) != {'Qwen--Qwen3-Embedding-0.6B.json', 'Qwen--Qwen3-Reranker-0.6B.json'} or not all(hexadecimal(item, 64) for item in (*sources.values(), *catalogs.values())) or fingerprint({'source_sha256': sources, 'catalog_sha256': catalogs}) != RELEASE:
        raise Retirement('Selected downstream release map differs.')
    epoch = health['owner_epoch']
    auth = dict(auth, **{'X-Raya-Owner-Epoch': epoch})
    digest = fingerprint(body)
    wire = canonical(body)
    if len(wire) > 300000:
        raise ValueError('Canonical downstream body exceeds its bound.')
    record = lease.store.begin(key, port, epoch, RELEASE, parent, digest)
    completed = False
    submitted = False

    def retire():
        request = urllib.request.Request(origin + '/v1/requests/' + key, method='DELETE', headers=auth)
        try:
            with opener.open(request, timeout=2) as response:
                raw = response.read(65537)
                value = metadata(raw)
                if not isinstance(value, dict) or value.get('cancel_requested') is not True or type(value.get('active')) is not bool or value.get('request') != key or value.get('owner_epoch') != epoch or value.get('retirement_acknowledged') is not False:
                    raise RuntimeError('Retrieval cancellation acknowledgment differs.')
                return value['active']
        except urllib.error.HTTPError as err:
            err.close()
            raise

    def watch():
        while not stop.wait(0.05):
            if (cancel is not None and cancel.is_set()) or time.monotonic() >= until:
                try:
                    retire()
                except Exception as err:
                    errors.append(err)
                return

    thread = threading.Thread(target=watch, name='memory-retrieval-cancel', daemon=False)
    thread.start()
    request = urllib.request.Request(origin + path, data=wire, headers=dict(auth, **{'Content-Type': 'application/json', 'X-Raya-Timeout-Ms': str(int(budget * 1000)), 'X-Raya-Request-ID': key}))

    def cleanup():
        stop.set()
        thread.join(timeout=3)
        try:
            until = time.monotonic() + 3
            if submitted and not completed:
                retire()
            proof = None
            while True:
                with opener.open(urllib.request.Request(origin+'/v1/requests/'+key, headers=auth), timeout=2) as response:
                    value = metadata(response.read(65537))
                if isinstance(value, dict) and value.get('phase') == 'retired':
                    proof = certificate(value, key, epoch, RELEASE, digest)
                    break
                if time.monotonic() >= until:
                    raise Retirement('Original downstream terminal receipt remains unconfirmed.')
                threading.Event().wait(0.05)
        except Exception as err:
            errors.append(err)
        if thread.is_alive():
            errors.append(Retirement('Retrieval cancellation observer did not retire.'))
        if errors:
            raise Retirement('Retrieval cleanup is unconfirmed; pending ledger retained.') from BaseExceptionGroup('Downstream retirement evidence failures.', list(errors))
        try:
            lease.store.finish(record, proof)
            proofs.append(proof)
        except Exception as err:
            raise Retirement('Retirement confirmation could not be persisted.') from err

    with closing(cleanup):
        try:
            remaining()
            if gate is not None:
                gate()
            submitted = True
            with opener.open(request, timeout=budget + 5) as response:
                raw = bytearray()
                while True:
                    remaining()
                    part = response.read1(65536)
                    if not part:
                        break
                    raw.extend(part)
                    if len(raw) > 2 * 1024 * 1024:
                        raise ValueError('Retrieval response exceeds 2 MiB.')
                value = metadata(bytes(raw), 2097152)
                if not isinstance(value, dict) or 'retirement' not in value:
                    raise Retirement('Successful inference response lacks original retirement evidence.')
                proof = certificate(value['retirement'], key, epoch, RELEASE, digest)
                result = {name: item for name, item in value.items() if name != 'retirement'}
                if proof['inference_outcome'] != 'completed' or proof.get('result_sha256') != fingerprint(result):
                    raise Retirement('Inference result does not match its original terminal receipt.')
                completed = True
                remaining()
                if gate is not None:
                    gate()
                return result
        except urllib.error.HTTPError as err:
            err.close()
            if err.code == 499:
                raise Cancelled('Retrieval cancellation completed.') from err
            if err.code == 504:
                raise TimeoutError('Retrieval exhausted its operation budget.') from err
            remaining()
            raise RuntimeError('Retrieval API rejected request: ' + str(err.code)) from err


def tokenizer():
    global TOKENIZER
    remaining()
    while not GATE.acquire(timeout=min(0.05, remaining())):
        remaining()
    try:
        remaining()
        if TOKENIZER is not None:
            return TOKENIZER
        from transformers import AutoTokenizer
        remaining()
        value = AutoTokenizer.from_pretrained(MODEL['path'], local_files_only=True)
        remaining()
        TOKENIZER = value
        return value
    finally:
        GATE.release()


def tokens(text):
    remaining()
    value = tokenizer()
    remaining()
    result = len(value.encode(text, add_special_tokens=False))
    remaining()
    return result


def semantic(text):
    def replace(match):
        address = match.group(2) or match.group(3)
        if re.match(r'^[a-z][a-z0-9+.-]*:', address, re.I) and not re.match(r'^[a-z]:[/\\]', address, re.I) and not address.casefold().startswith('file:'):
            return match.group(0)
        return match.group(1)
    # Local citation destinations are provenance, not the note's subject matter.
    return re.sub(r'\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^)\n]+))\)', replace, text)


def scan(root, policy=None):
    if not isinstance(policy, Policy):
        raise ValueError("Explicit reviewed general-source policy required.")
    policy.bind(root)
    patterns = []
    ignore = root / '.rayaignore'
    if ignore.exists():
        if ignore.is_symlink():
            raise ValueError('Exclusion file cannot be a link.')
        patterns = [line.strip() for line in ignore.read_text(encoding='utf-8').splitlines() if line.strip() and not line.startswith('#')]
    result = {}
    for parent, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name.casefold() not in {'system', 'archive', '.git'} and not (Path(parent) / name).is_symlink() and not (Path(parent) / name).is_junction()]
        for name in files:
            remaining()
            path = Path(parent) / name
            if path.suffix.lower() != '.md' or path.is_symlink():
                continue
            relative = path.relative_to(root).as_posix()
            if any(fnmatch.fnmatchcase(relative.casefold(), pattern.casefold()) or (pattern.endswith('/') and relative.casefold().startswith(pattern.casefold())) for pattern in patterns):
                continue
            if not path.resolve().is_relative_to(root):
                raise ValueError('A note resolved outside the memory root.')
            if not policy.admit(relative):
                continue
            raw = path.read_bytes()
            policy.verify(relative, raw)
            if len(raw) > 256000:
                raise ValueError('Split the oversized Markdown note: ' + relative)
            text = raw.decode('utf-8-sig')
            result[relative] = {'hash': digest(raw), 'text': text}
            if len(result) > 1000:
                raise ValueError('The first index supports at most 1000 Markdown files.')
    return result


def split(path, note):
    lines = note['text'].splitlines()
    heading = ''
    section = []
    result = []
    def emit():
        nonlocal section
        if not section:
            return
        text = '\n'.join(value for _, value in section).strip()
        if text:
            source = f'Source: {path}\nSection: {heading}\n{text}'
            if tokens(source) > 300:
                raise ValueError('A single Markdown line is too long; split it: ' + path)
            start, end = section[0][0], section[-1][0]
            result.append({'id': digest(f'{path}:{start}:{len(result)}:{source}'.encode()), 'path': path, 'start': start, 'end': end, 'heading': heading, 'text': source, 'filehash': note['hash'], 'contenthash': digest(source.encode())})
        section = []
    for number, line in enumerate(lines, 1):
        if line.startswith('#') and line.lstrip('#').startswith(' '):
            emit()
            heading = line.lstrip('#').strip()
        candidate = f'Source: {path}\nSection: {heading}\n' + '\n'.join(value for _, value in section + [(number, line)])
        if tokens(candidate) > 300:
            emit()
        prefix = f'Source: {path}\nSection: {heading}\n'
        if tokens(prefix) > 100:
            raise ValueError('Use a shorter note path or heading: ' + path)
        while tokens(prefix + line) > 300:
            low, high = 1, len(line)
            while low < high:
                middle = (low + high + 1) // 2
                if tokens(prefix + line[:middle]) <= 300:
                    low = middle
                else:
                    high = middle - 1
            boundary = line.rfind(' ', 0, low)
            cut = boundary if boundary > low // 2 else low
            section.append((number, line[:cut]))
            emit()
            line = line[cut:].lstrip()
        section.append((number, line))
    emit()
    return result


class Index:
    def __init__(self, root, *, existing=False, generation=None):
        self.store = Store(root, existing=existing, generation=generation)
        self.root = self.store.root
        system = self.root / 'System'
        if system.is_symlink() or system.is_junction():
            raise ValueError('System directory cannot be a link.')
        if not existing:
            system.mkdir(exist_ok=True)
        self.db = system / 'search.sqlite'
        self.lock = system / 'search.lock'
        if self.db.is_symlink() or self.lock.is_symlink() or (self.db.exists() and self.db.stat().st_nlink > 1) or (self.lock.exists() and self.lock.stat().st_nlink > 1):
            raise ValueError('Index database and lock cannot be links.')
        self.leaves = {self.db: entry(self.db), self.lock: entry(self.lock)}

    @property
    def lease(self):
        lease = LEASE.get()
        if lease is None or lease.store is not self.store:
            raise Refused('A current admission lease is required.')
        lease.check()
        return lease

    def guard(self, snapshot):
        lease = self.lease
        current = scan(self.root, lease.policy)
        if {key: note['hash'] for key, note in current.items()} != {key: note['hash'] for key, note in snapshot.items()}:
            raise Refused('Reviewed sources or exclusions changed during retrieval.')
        lease.check()
        return current

    def rows(self, rows, snapshot):
        expected = {tuple(chunk[key] for key in ('path', 'start', 'end', 'heading', 'text', 'filehash'))
                    for path, note in snapshot.items() for chunk in split(path, note)}
        if any(tuple(row[:6]) not in expected for row in rows):
            raise Refused('Derived index contains an unapproved or altered source chunk.')

    @contextmanager
    def connect(self):
        path = self.db
        with leaf(path, self.leaves[path], self.lease.check) as (_, guard, original):
            self.leaves[path] = original
            db = sqlite3.connect(path, timeout=5)
            with closing(db.close):
                guard()
                db.execute('PRAGMA secure_delete=ON')
                with db:
                    db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
                    db.execute('CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, path TEXT, start INTEGER, end INTEGER, heading TEXT, text TEXT, filehash TEXT, contenthash TEXT, vector BLOB)')
                    yield db

    @bounded
    @admitted
    def sync(self, force=False, expected=None):
        import msvcrt
        if expected is not None:
            if not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected):
                raise ValueError('Confirmed sync requires an exact lowercase policy SHA-256.')
            if self.lease.sha != expected:
                raise Refused('Confirmed source policy changed while waiting; review sync again.')
        with leaf(self.lock, self.leaves[self.lock], self.lease.check) as (file, guard, generation):
            self.leaves[self.lock] = generation
            file.seek(0)
            if not file.read(1):
                file.write(b'0')
                file.flush()
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            def unlock():
                try:
                    file.seek(0)
                    msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
                finally:
                    guard()
            with closing(unlock):
                remaining()
                clean(self.root)
                remaining()
                if force:
                    original = self.db
                    stage = original.parent / ('search-rebuild-' + uuid.uuid4().hex + '.sqlite')
                    if stage.resolve().parent != original.parent.resolve():
                        raise ValueError('Rebuild stage escaped the index directory.')
                    self.db = stage
                    self.leaves[stage] = None
                    generation = None
                    def restore():
                        self.db = original
                        if os.path.lexists(stage):
                            self.lease.check()
                            if generation is None or entry(stage) != generation:
                                raise Refused('Rebuild staging identity changed; foreign entry is preserved.')
                            stage.unlink()
                    with closing(restore):
                        with leaf(stage, None, self.lease.check) as (_, held, generation):
                            self.leaves[stage] = generation
                            result = self.rebuild()
                            held()
                        remaining()
                        self.lease.check()
                        if entry(stage) != generation or entry(original) != self.leaves[original]:
                            raise Refused('Rebuild source or target file identity changed; preserve both entries.')
                        os.replace(stage, original)
                        self.leaves[original] = generation
                        self.lease.check()
                        if entry(original) != generation:
                            raise Refused('Published database differs from the original rebuild stage.')
                        return dict(result, rebuilt=True)
                return self.rebuild()

    def rebuild(self):
        remaining()
        import numpy as np
        remaining()
        signature = SIGNATURE + ':admission:' + self.lease.sha
        snapshot = scan(self.root, self.lease.policy)
        chunks = [chunk for path, note in snapshot.items() for chunk in split(path, note)]
        if len(chunks) > 10000:
            raise ValueError('The first index supports at most 10000 chunks.')
        with self.connect() as db:
            prior = dict(db.execute('SELECT key,value FROM meta'))
            files = json.dumps({path: note['hash'] for path, note in snapshot.items()}, sort_keys=True)
            cache = dict(db.execute('SELECT contenthash,vector FROM chunks')) if prior.get('signature') == signature else {}
            for raw in cache.values():
                remaining()
                decode(raw)
            self.guard(snapshot)
            if prior.get('signature') == signature and prior.get('files') == files:
                return {'files': len(snapshot), 'chunks': len(chunks), 'new_embeddings': 0, 'reused_embeddings': len(chunks)}
            fresh = {chunk['contenthash']: chunk['text'] for chunk in chunks if chunk['contenthash'] not in cache}
            items = list(fresh.items())
            # Amortize process/model startup; the model still forwards only two texts at a time.
            for index in range(0, len(items), 16):
                remaining()
                batch = items[index:index + 16]
                response = api('/v1/embeddings', {'input': [semantic(text) for _, text in batch], 'input_type': 'document'}, gate=lambda: self.guard(snapshot))
                if response.get('revision') != MODEL['revision'] or response.get('dimensions') != 1024 or len(response['data']) != len(batch):
                    raise RuntimeError('Embedding model or output shape changed.')
                for (key, _), item in zip(batch, response['data']):
                    vector = np.asarray(item['embedding'], dtype=np.float32)
                    if vector.shape != (1024,) or not np.isfinite(vector).all() or abs(np.linalg.norm(vector) - 1) > 0.001:
                        raise RuntimeError('Embedding is not a finite normalized vector.')
                    cache[key] = vector.tobytes()
            current = scan(self.root, self.lease.policy)
            if {key: note['hash'] for key, note in current.items()} != {key: note['hash'] for key, note in snapshot.items()}:
                raise RuntimeError('Notes changed during indexing; retry sync.')
            remaining()
            self.guard(snapshot)
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM chunks')
            db.executemany('INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)', [(chunk['id'], chunk['path'], chunk['start'], chunk['end'], chunk['heading'], chunk['text'], chunk['filehash'], chunk['contenthash'], cache[chunk['contenthash']]) for chunk in chunks])
            db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('signature', signature))
            db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('files', files))
            remaining()
            db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('updated', str(time.time())))
            self.guard(snapshot)
        return {'files': len(snapshot), 'chunks': len(chunks), 'new_embeddings': len(fresh), 'reused_embeddings': len(chunks) - len(fresh)}

    @bounded
    @admitted
    def search(self, query, top=5):
        remaining()
        import numpy as np
        remaining()
        if not isinstance(query, str) or not query.strip() or tokens(query) > 96:
            raise ValueError('Search query must contain 1–96 tokens.')
        if type(top) is not int or not 1 <= top <= 10:
            raise ValueError('top must be an integer from 1 to 10.')
        self.sync()
        snapshot = scan(self.root, self.lease.policy)
        with self.connect() as db:
            meta = dict(db.execute('SELECT key,value FROM meta'))
            if meta.get('signature') != SIGNATURE + ':admission:' + self.lease.sha:
                raise Refused('Derived index belongs to an obsolete admission policy.')
            rows = list(db.execute('SELECT path,start,end,heading,text,filehash,vector FROM chunks ORDER BY id'))
        self.rows(rows, snapshot)
        self.guard(snapshot)
        if not rows:
            return []
        response = api('/v1/embeddings', {'input': query, 'input_type': 'query'}, gate=lambda: self.guard(snapshot))
        if response.get('revision') != MODEL['revision']:
            raise RuntimeError('Query embedding revision changed.')
        vector = np.asarray(response['data'][0]['embedding'], dtype=np.float32)
        if vector.shape != (1024,) or not np.isfinite(vector).all() or abs(np.linalg.norm(vector) - 1) > 0.001:
            raise RuntimeError('Query embedding is not a finite normalized vector.')
        matrix = np.stack([decode(row[6]) for row in rows])
        scores = matrix @ vector
        indexes = np.argsort(scores)[::-1][:min(10, len(rows))].tolist()
        self.rows(rows, self.guard(snapshot))
        ranked = api('/v1/rerank', {'query': query, 'documents': [semantic(rows[index][4]) for index in indexes], 'top_n': min(top, len(indexes))}, gate=lambda: self.guard(snapshot))
        if ranked.get('revision') != RANKER['revision']:
            raise RuntimeError('Reranker revision changed.')
        clean(self.root)
        current = scan(self.root, self.lease.policy)
        result = []
        for item in ranked['results']:
            row = rows[indexes[item['index']]]
            if row[0] not in current or current[row[0]]['hash'] != row[5]:
                continue
            result.append({'path': str(self.root / row[0]), 'relative': row[0], 'line': row[1], 'end_line': row[2], 'heading': row[3], 'text': row[4], 'source_sha256': row[5], 'embedding_similarity': float(scores[indexes[item['index']]]), 'relevance_score': item['relevance_score']})
        self.guard(snapshot)
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['sync', 'search', 'rebuild'])
    parser.add_argument('--root', default=r'D:\Raya\SecondBrain')
    parser.add_argument('--query')
    parser.add_argument('--top', type=int, default=5)
    args = parser.parse_args()
    index = Index(args.root)
    result = index.sync(force=args.command == 'rebuild') if args.command != 'search' else index.search(args.query, args.top)
    print(json.dumps(result, indent=2), flush=True)
