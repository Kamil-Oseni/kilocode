"""Explicit journaled Markdown changes. No extraction, capture or external actions."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import uuid
from admission import Store as Admission, closing

FOLDERS = {'Daily', 'Areas', 'Projects', 'People', 'Preferences', 'Decisions', 'Commitments'}
KINDS = {'user_statement', 'tool_observation', 'document', 'assistant_interpretation'}


class RecoveryNeeded(RuntimeError):
    pass


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def identity(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('Use a canonical UUID change ID.')
    return value


def safe(path):
    if path.is_symlink() or path.is_junction() or (path.is_file() and path.stat().st_nlink > 1):
        raise ValueError('Linked memory paths are refused.')


def pending(root):
    folder = Path(root) / 'System' / 'Changes'
    safe(folder)
    if not folder.exists():
        return []
    result = []
    for path in folder.iterdir():
        safe(path)
        identity(path.name)
        manifest = path / 'manifest.json'
        safe(manifest)
        if not manifest.exists():
            raise RecoveryNeeded('An incomplete note journal requires local inspection.')
        state = json.loads(manifest.read_text(encoding='utf-8'))
        if state.get('status') not in {'committed', 'aborted'}:
            result.append(path.name)
    return result


def clean(root):
    if pending(root):
        raise RecoveryNeeded('An interrupted note change requires explicit recovery before indexing.')


class Store:
    def __init__(self, root):
        self.root = Path(root).absolute()
        self.admission = Admission(self.root)
        safe(self.root)
        if not self.root.is_dir():
            raise ValueError('Memory root must already exist.')
        self.system = self.root / 'System'
        safe(self.system)
        self.system.mkdir(exist_ok=True)
        self.journal = self.system / 'Changes'
        safe(self.journal)
        self.journal.mkdir(exist_ok=True)
        self.lock = self.system / 'search.lock'
        safe(self.lock)

    @contextmanager
    def guard(self):
        # Match retrieval's order: general admission, then the search/write lock.
        # Editing does not require enabled admission, only serialization.
        with self.admission.locked(), self.search():
            yield

    @contextmanager
    def search(self):
        import msvcrt
        safe(self.lock)
        with self.lock.open('a+b') as file:
            if os.fstat(file.fileno()).st_size == 0:
                file.write(b'0')
                file.flush()
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            def unlock():
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            with closing(unlock):
                yield

    def target(self, name):
        if not isinstance(name, str) or '\\' in name:
            raise ValueError('Use a relative Markdown path with forward slashes.')
        parts = name.split('/')
        reserved = {'CON', 'PRN', 'AUX', 'NUL'} | {prefix + str(number) for prefix in ('COM', 'LPT') for number in range(1, 10)}
        if len(parts) < 2 or parts[0] not in FOLDERS or any(not part or part in {'.', '..'} or re.search(r'[<>:"|?*\x00-\x1f]', part) or part.endswith((' ', '.')) or part.split('.')[0].upper() in reserved for part in parts):
            raise ValueError('Use a normal path under an approved memory category.')
        if PurePosixPath(name).suffix.lower() != '.md':
            raise ValueError('Memory changes must target Markdown.')
        path = self.root
        for part in parts:
            path = path / part
            safe(path)
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise ValueError('Note path escapes the memory root.')
        ignore = self.root / '.rayaignore'
        safe(ignore)
        if ignore.exists():
            patterns = [line.strip().casefold() for line in ignore.read_text(encoding='utf-8').splitlines() if line.strip() and not line.startswith('#')]
            if any(name.casefold().startswith(pattern) if pattern.endswith('/') else fnmatch.fnmatch(name.casefold(), pattern) for pattern in patterns):
                raise ValueError('The note is excluded from automatic memory changes.')
        return path

    def atomic(self, path, raw):
        safe(path)
        stage = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        with stage.open('xb') as file:
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        os.replace(stage, path)

    def state(self, change):
        folder = self.journal / identity(change)
        safe(folder)
        path = folder / 'manifest.json'
        safe(path)
        state = json.loads(path.read_text(encoding='utf-8'))
        if state.get('id') != change or state.get('format') != 'raya-note-change-v1':
            raise ValueError('Note journal identity is invalid.')
        return state

    def current(self, path):
        safe(path)
        if not path.exists():
            return None
        raw = path.read_bytes()
        if len(raw) > 256000:
            raise ValueError('A note exceeds the 256 KB writer limit.')
        raw.decode('utf-8')
        return raw

    def sources(self, records):
        if not isinstance(records, list) or not 1 <= len(records) <= 8:
            raise ValueError('Supply 1–8 source records.')
        result = []
        total = 0
        for source in records:
            if not isinstance(source, dict) or set(source) != {'path', 'sha256', 'kind', 'event_time'} or source['kind'] not in KINDS:
                raise ValueError('Sources require path, sha256, kind and event_time (or null).')
            if source['event_time'] is not None:
                if not isinstance(source['event_time'], str) or len(source['event_time']) > 80:
                    raise ValueError('Use an ISO source event time or null; do not invent a date.')
                datetime.fromisoformat(source['event_time'])
            path = Path(source['path']).absolute()
            for part in [path, *path.parents]:
                safe(part)
            raw = path.read_bytes()
            total += len(raw)
            if len(raw) > 2000000 or total > 8000000:
                raise ValueError('Source snapshots exceed the bounded writer size.')
            raw.decode('utf-8')
            if digest(raw) != source['sha256']:
                raise ValueError('Source revision changed; review it before writing memory.')
            result.append((dict(source, path=str(path)), raw))
        return result

    def apply(self, request, observe=None, mode='apply'):
        if mode not in {'apply', 'restore'}:
            raise ValueError('Unknown note change mode.')
        if not isinstance(request, dict) or set(request) != {'id', 'changes', 'sources'}:
            raise ValueError('A change requires id, changes and sources.')
        change = identity(request['id'])
        signature = digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode('utf-8'))
        with self.guard():
            folder = self.journal / change
            safe(folder)
            if folder.exists():
                state = self.state(change)
                if state['request_sha256'] != signature or state['mode'] != mode:
                    raise ValueError('Change ID already belongs to a different request.')
                if state['status'] == 'committed':
                    return {'id': change, 'status': 'committed', 'duplicate': True}
                raise RecoveryNeeded('This change requires recovery instead of repeat application.')
            clean(self.root)
            changes = request['changes']
            if not isinstance(changes, list) or not 1 <= len(changes) <= 16:
                raise ValueError('Supply 1–16 note changes.')
            sources = self.sources(request['sources'])
            stamp = datetime.now(timezone.utc).isoformat()
            links = [f"[{source['kind']}](<{(folder / ('source-' + str(index) + '.txt')).as_posix()}>)" for index, (source, _) in enumerate(sources)]
            footer = '\n\nRecorded update: ' + stamp + '. Source snapshots: ' + ', '.join(links) + '.\n'
            entries = []
            names = set()
            total = 0
            for item in changes:
                if not isinstance(item, dict) or set(item) != {'path', 'expected', 'content'}:
                    raise ValueError('Each note requires path, expected hash (or null), and content (or null for logical deletion).')
                path = self.target(item['path'])
                key = item['path'].casefold()
                if key in names:
                    raise ValueError('A note appears twice in one change.')
                names.add(key)
                old = self.current(path)
                before = None if old is None else digest(old)
                if item['expected'] != before:
                    raise ValueError('Note revision changed; review before overwriting.')
                content = item['content']
                if content is not None and (not isinstance(content, str) or not content.strip()):
                    raise ValueError('Note content must be nonempty UTF-8 Markdown or null.')
                if mode != 'restore' and item['path'].startswith('Daily/') and old is not None and (content is None or not content.startswith(old.decode('utf-8'))):
                    raise ValueError('Daily history is append-oriented; use explicit restore for version recovery.')
                new = None if content is None else (content + (footer if mode == 'apply' else '')).encode('utf-8')
                total += 0 if new is None else len(new)
                if (new is not None and len(new) > 256000) or total > 2000000:
                    raise ValueError('Note changes exceed bounded writer size.')
                entries.append(({'path': item['path'], 'old_sha256': before, 'new_sha256': None if new is None else digest(new)}, old, new))
            folder.mkdir()
            state = {'format': 'raya-note-change-v1', 'id': change, 'mode': mode, 'status': 'preparing', 'request_sha256': signature, 'observed_utc': stamp, 'capture_enabled': False, 'sources': [source for source, _ in sources], 'changes': [entry for entry, _, _ in entries]}
            self.atomic(folder / 'manifest.json', json.dumps(state, indent=2).encode())
            if observe:
                observe('preparing')
            for index, (_, raw) in enumerate(sources):
                self.atomic(folder / ('source-' + str(index) + '.txt'), raw)
            for index, (_, old, new) in enumerate(entries):
                if old is not None:
                    self.atomic(folder / ('before-' + str(index) + '.md'), old)
                if new is not None:
                    self.atomic(folder / ('after-' + str(index) + '.md'), new)
            state['status'] = 'prepared'
            self.atomic(folder / 'manifest.json', json.dumps(state, indent=2).encode())
            if observe:
                observe('prepared')
            return self.publish(state, observe=observe)

    def publish(self, state, rollback=False, observe=None):
        folder = self.journal / identity(state['id'])
        for index, source in enumerate(state['sources']):
            path = folder / ('source-' + str(index) + '.txt')
            safe(path)
            if digest(path.read_bytes()) != source['sha256']:
                raise ValueError('Note journal source snapshot is damaged.')
        payloads = []
        for index, entry in enumerate(state['changes']):
            path = self.target(entry['path'])
            for label in ('before', 'after'):
                expected = entry['old_sha256' if label == 'before' else 'new_sha256']
                if expected is not None:
                    source = folder / (label + '-' + str(index) + '.md')
                    safe(source)
                    if digest(source.read_bytes()) != expected:
                        raise ValueError('Note journal payload is damaged.')
            raw = self.current(path)
            current = None if raw is None else digest(raw)
            if current not in {entry['old_sha256'], entry['new_sha256']}:
                raise ValueError('A newer external edit conflicts with recovery; no notes were overwritten.')
            expected = entry['old_sha256'] if rollback else entry['new_sha256']
            label = 'before' if rollback else 'after'
            payload = None if expected is None else (folder / (label + '-' + str(index) + '.md')).read_bytes()
            payloads.append((path, current, expected, payload))
        for index, (path, prior, expected, raw) in enumerate(payloads):
            path.parent.mkdir(parents=True, exist_ok=True)
            self.target(state['changes'][index]['path'])
            current = self.current(path)
            if (None if current is None else digest(current)) != prior:
                raise ValueError('A note changed during publication; explicit recovery is required.')
            if prior != expected:
                if raw is None:
                    path.unlink()
                else:
                    self.atomic(path, raw)
            if observe:
                observe('published:' + str(index))
        state['status'] = 'aborted' if rollback else 'committed'
        state['finished_utc'] = datetime.now(timezone.utc).isoformat()
        self.atomic(folder / 'manifest.json', json.dumps(state, indent=2).encode())
        return {'id': state['id'], 'status': state['status'], 'duplicate': False, 'note_sha256': {entry['path']: entry['old_sha256'] if rollback else entry['new_sha256'] for entry in state['changes']}}

    def recover(self, change, rollback=False):
        with self.guard():
            state = self.state(change)
            if state['status'] in {'committed', 'aborted'}:
                return {'id': change, 'status': state['status'], 'duplicate': True}
            if state['status'] == 'preparing':
                if not rollback:
                    raise RecoveryNeeded('Preparation did not finish; use explicit rollback to abort it.')
                state['status'] = 'aborted'
                self.atomic(self.journal / change / 'manifest.json', json.dumps(state, indent=2).encode())
                return {'id': change, 'status': 'aborted', 'duplicate': False}
            return self.publish(state, rollback=rollback)

    def restore(self, request):
        if not isinstance(request, dict) or set(request) != {'id', 'change', 'expected'}:
            raise ValueError('Restore requires a new id, original change and expected note hashes.')
        state = self.state(request['change'])
        if state['status'] != 'committed' or set(request['expected']) != {entry['path'] for entry in state['changes']}:
            raise ValueError('Restore requires a committed change and every current note hash.')
        changes = []
        folder = self.journal / state['id']
        for index, entry in enumerate(state['changes']):
            source = folder / ('before-' + str(index) + '.md')
            safe(source)
            raw = None if entry['old_sha256'] is None else source.read_bytes()
            if raw is not None and digest(raw) != entry['old_sha256']:
                raise ValueError('Saved version is damaged.')
            changes.append({'path': entry['path'], 'expected': request['expected'][entry['path']], 'content': None if raw is None else raw.decode('utf-8')})
        manifest = folder / 'manifest.json'
        return self.apply({'id': request['id'], 'changes': changes, 'sources': [{'path': str(manifest), 'sha256': digest(manifest.read_bytes()), 'kind': 'tool_observation', 'event_time': None}]}, mode='restore')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['apply', 'restore', 'status', 'recover', 'rollback'])
    parser.add_argument('input', help='Request JSON file for apply/restore; change UUID otherwise.')
    parser.add_argument('--root', default=r'D:\Raya\SecondBrain')
    args = parser.parse_args()
    store = Store(args.root)
    if args.command in {'apply', 'restore'}:
        if Path(args.input).stat().st_size > 2500000:
            raise ValueError('Request JSON exceeds the writer size limit.')
        request = json.loads(Path(args.input).read_text(encoding='utf-8-sig'))
        result = store.apply(request) if args.command == 'apply' else store.restore(request)
    else:
        result = store.state(args.input) if args.command == 'status' else store.recover(args.input, rollback=args.command == 'rollback')
    print(json.dumps(result, indent=2))
