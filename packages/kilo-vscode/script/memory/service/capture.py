"""Publish an authorized, redacted completed turn through the existing note journal.

This module is not an authorization boundary or a service endpoint. Its caller
must bind the payload to the original turn, current owner and capture consent.
"""
from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import re

from admission import closing
from notes import FOLDERS, RecoveryNeeded, Store, clean, digest, identity, safe


def validate(body):
    fields = {'format', 'id', 'project', 'session', 'message', 'observed_utc', 'source', 'entries'}
    if not isinstance(body, dict) or set(body) != fields or body['format'] != 'raya.memory.capture.v1':
        raise ValueError('Use the exact completed-turn capture payload.')
    if not isinstance(body['id'], str):
        raise ValueError('Capture requires a canonical UUID string.')
    identity(body['id'])
    if not isinstance(body['project'], str) or not Path(body['project']).is_absolute():
        raise ValueError('Capture requires an absolute original project.')
    for name in ('project', 'session', 'message', 'observed_utc'):
        value = body[name]
        if not isinstance(value, str) or not value.strip() or len(value) > 4096 or any(ord(char) < 32 for char in value):
            raise ValueError('Capture identity fields must be bounded nonempty strings.')
    stamp = datetime.fromisoformat(body['observed_utc'])
    if stamp.utcoffset() is None or stamp.utcoffset().total_seconds() != 0:
        raise ValueError('Capture observation must have an explicit UTC offset.')
    if not isinstance(body['source'], str) or not body['source'].strip() or len(body['source'].encode('utf-8')) > 65536:
        raise ValueError('Capture source must be nonempty and at most 64 KiB.')
    if not isinstance(body['entries'], list) or not 1 <= len(body['entries']) <= 8:
        raise ValueError('Capture requires 1–8 organized entries.')
    keys = set()
    for item in body['entries']:
        if (not isinstance(item, dict) or set(item) != {'category', 'key', 'text'} or
                not isinstance(item['category'], str) or item['category'] not in FOLDERS):
            raise ValueError('Entries require an approved category, stable key and text.')
        key = item['key']
        if not isinstance(key, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,79}', key):
            raise ValueError('Use a bounded lowercase entry key.')
        if re.search(r'(^|[-_])(password|secret|credential|token|medical|health|financial|bank)([-_]|$)', key):
            raise ValueError('Restricted capture entries require a separate reviewed flow.')
        if key in keys:
            raise ValueError('Capture entry keys must be unique.')
        keys.add(key)
        if not isinstance(item['text'], str) or not item['text'].strip() or len(item['text'].encode('utf-8')) > 4096:
            raise ValueError('Entry text must be nonempty and at most 4 KiB.')
    return json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


@contextmanager
def guard(store):
    import msvcrt
    path = store.system / 'capture.lock'
    safe(path)
    with path.open('a+b') as file:
        held = os.fstat(file.fileno())
        named = path.stat()
        safe(path)
        if (held.st_dev, held.st_ino, held.st_nlink) != (named.st_dev, named.st_ino, 1):
            raise ValueError('Capture lock identity changed.')
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


def immutable(path, raw):
    safe(path)
    with path.open('xb') as file:
        file.write(raw)
        file.flush()
        os.fsync(file.fileno())


def publish(root, body, observe=None, cancel=None):
    raw = validate(body)
    root = Path(root)
    if not root.is_absolute():
        raise ValueError('Capture requires the selected absolute notes root.')
    for path in [root, *root.parents]:
        safe(path)
    store = Store(root)
    signature = digest(raw)
    with guard(store):
        if cancel and cancel():
            raise ValueError('Capture cancelled before publication.')
        folder = store.system / 'Capture'
        safe(folder)
        folder.mkdir(exist_ok=True)
        folder = folder / body['id']
        safe(folder)
        if folder.exists():
            path = folder / 'input.json'
            safe(path)
            if not path.exists():
                raise RecoveryNeeded('Incomplete capture input requires local inspection.')
            if path.read_bytes() != raw:
                raise ValueError('Capture ID already belongs to another original input.')
            manifest = store.journal / body['id'] / 'manifest.json'
            safe(manifest.parent)
            safe(manifest)
            if not manifest.exists():
                raise RecoveryNeeded('Capture preparation has no completed journal; inspect it before retrying.')
            state = store.state(body['id'])
            if state['status'] != 'committed':
                raise RecoveryNeeded('Interrupted capture journal requires explicit recovery.')
            path = folder / 'request.json'
            safe(path)
            request = json.loads(path.read_text(encoding='utf-8'))
            if state['request_sha256'] != digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode('utf-8')):
                raise ValueError('Capture journal differs from its immutable request.')
            # A duplicate must not quietly adopt later edits or damaged evidence.
            store.sources(request['sources'])
            journal = store.journal / body['id']
            for index, entry in enumerate(state['sources']):
                path = journal / ('source-' + str(index) + '.txt')
                safe(path)
                if digest(path.read_bytes()) != entry['sha256']:
                    raise ValueError('Capture journal source snapshot is damaged.')
            for index, entry in enumerate(state['changes']):
                for label, field in (('before', 'old_sha256'), ('after', 'new_sha256')):
                    if entry[field] is not None:
                        path = journal / (label + '-' + str(index) + '.md')
                        safe(path)
                        if digest(path.read_bytes()) != entry[field]:
                            raise ValueError('Capture journal note snapshot is damaged.')
                current = store.current(store.target(entry['path']))
                if current is None or digest(current) != entry['new_sha256']:
                    raise ValueError('A newer note edit conflicts with this capture receipt.')
            return {'id': body['id'], 'status': 'committed', 'duplicate': True, 'input_sha256': signature}
        clean(store.root)
        changes = []
        for category in sorted({item['category'] for item in body['entries']}):
            name = category + '/Raya.md'
            old = store.current(store.target(name))
            text = '' if old is None else old.decode('utf-8')
            text += '\n\n## Raya capture ' + body['id'] + '\n'
            text += '\nInterpretation of a recorded conversation; not independently verified.\n'
            for item in body['entries']:
                if item['category'] == category:
                    text += '\n### ' + item['key'] + '\n\n' + item['text'] + '\n'
            changes.append({'path': name, 'expected': None if old is None else digest(old), 'content': text})
        folder.mkdir()
        immutable(folder / 'input.json', raw)
        source = folder / 'source.md'
        snapshot = ('# Original completed turn\n\n' + json.dumps({name: body[name] for name in
                    ('project', 'session', 'message', 'observed_utc')}, ensure_ascii=False) +
                    '\n\nKind: assistant_interpretation\n\n' + body['source']).encode('utf-8')
        immutable(source, snapshot)
        request = {'id': body['id'], 'changes': changes, 'sources': [{'path': str(source),
                   'sha256': digest(snapshot), 'kind': 'assistant_interpretation', 'event_time': body['observed_utc']}]}
        immutable(folder / 'request.json', json.dumps(request, sort_keys=True, ensure_ascii=False).encode('utf-8'))
        if observe:
            observe('captured')
        if cancel and cancel():
            raise RecoveryNeeded('Capture cancelled; immutable preparation retained for inspection.')
        def checkpoint(stage):
            if observe:
                observe(stage)
            if stage in {'preparing', 'prepared'} and cancel and cancel():
                raise RecoveryNeeded('Capture cancelled before notes changed; journal retained for recovery.')
        result = store.apply(request, observe=checkpoint)
        return dict(result, input_sha256=signature)
