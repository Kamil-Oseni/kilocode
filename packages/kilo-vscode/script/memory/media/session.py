"""Single explicit media operation, with durable non-replayable request evidence."""
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
from library import ordinary, read


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def exact(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError('Exact media protocol fields required.')


def digest(value):
    if not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value):
        raise ValueError('Exact media SHA256 required.')
    return value


def location(value):
    if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 32 for c in value):
        raise ValueError('Bounded media path required.')
    path = Path(value)
    if not path.is_absolute() or str(path.resolve()) != str(path.absolute()):
        raise ValueError('Canonical absolute media path required.')
    return path


def selection(value, observe=True):
    exact(value, ('format', 'project', 'source', 'root', 'excluded', 'files'))
    if value['format'] != 'raya.media.selection.v1':
        raise ValueError('Media selection version refused.')
    project, source, root = location(value['project']), location(value['source']), location(value['root'])
    if observe:
        ordinary(project, directory=True)
        ordinary(source, directory=True)
        ordinary(root, directory=True)
    if not isinstance(value['excluded'], list) or len(value['excluded']) > 128:
        raise ValueError('Bounded exclusion selection required.')
    excluded = [location(item) for item in value['excluded']]
    files = value['files']
    if not isinstance(files, list) or not 1 <= len(files) <= 128:
        raise ValueError('Select one to 128 original attachments.')
    seen = set()
    for row in files:
        exact(row, ('path', 'sha256', 'bytes', 'kind', 'title'))
        path = location(row['path'])
        if path in seen or not path.is_relative_to(source) or path.is_relative_to(root) or any(path == item or path.is_relative_to(item) for item in excluded):
            raise ValueError('Original media selection leaves approved source authority or enters an excluded root.')
        seen.add(path)
        digest(row['sha256'])
        if type(row['bytes']) is not int or not 0 < row['bytes'] <= 32 * 1024 * 1024 or row['kind'] not in ('image', 'audio', 'video'):
            raise ValueError('Bounded supported attachment required.')
        if not isinstance(row['title'], str) or not row['title'].strip() or len(row['title']) > 200 or any(ord(c) < 32 for c in row['title']):
            raise ValueError('Bounded attachment title required.')
    if observe:
        verify(files)
    return value


def verify(files):
    from library import format
    for row in files:
        raw = read(row['path'])
        if len(raw) != row['bytes'] or sha(raw) != row['sha256'] or format(raw)[0] != row['kind']:
            raise ValueError('Original authorized media revision changed.')


def request(value, observe=True):
    exact(value, ('format', 'request', 'epoch', 'release', 'policySHA', 'op', 'selection', 'args', 'model'))
    if value['format'] != 'raya.media.operation.v1' or value['op'] not in ('inspect', 'import', 'index', 'search', 'forget'):
        raise ValueError('Media operation version or kind refused.')
    if any(not isinstance(value[key], str) or not re.fullmatch('[a-f0-9]{32}', value[key]) for key in ('request', 'epoch')):
        raise ValueError('Exact original media request and owner epoch required.')
    digest(value['release'])
    digest(value['policySHA'])
    selection(value['selection'], observe=observe)
    if sha(encode(value['selection'])) != value['policySHA']:
        raise ValueError('Media policy selection SHA differs.')
    if value['op'] == 'search':
        exact(value['args'], ('query', 'top'))
        args = value['args']
        if not isinstance(args['query'], str) or not args['query'].strip() or len(args['query'].encode('utf-8')) > 2048 or type(args['top']) is not int or not 1 <= args['top'] <= 10:
            raise ValueError('Bounded media query required.')
    else:
        exact(value['args'], ('id',))
        digest(value['args']['id'])
        if sum(row['sha256'] == value['args']['id'] for row in value['selection']['files']) != 1:
            raise ValueError('Select exactly one original attachment for this operation.')
    if value['op'] in ('index', 'search'):
        exact(value['model'], ('path', 'sha256', 'bytes'))
        location(value['model']['path'])
        digest(value['model']['sha256'])
        if type(value['model']['bytes']) is not int or not 0 < value['model']['bytes'] <= 32 * 1024 * 1024:
            raise ValueError('Bounded exact checkpoint manifest required.')
    elif value['model'] is not None:
        raise ValueError('Pure media operations must not select a model.')
    return value


def publish(path, value):
    raw = encode(value)
    with path.open('xb') as file:
        file.write(raw)
        file.flush()
        os.fsync(file.fileno())
    ordinary(path)
    if read(path) != raw:
        raise ValueError('Media audit publication changed.')
    return raw


def debt(root):
    count = 0
    for folder in root.iterdir():
        if folder.name == 'active.json':
            raise ValueError('Original media operation remains active; automatic replay refused.')
        ordinary(folder, directory=True)
        if not re.fullmatch('[a-f0-9]{32}', folder.name):
            raise ValueError('Unknown original media audit namespace.')
        files = list(folder.iterdir())
        count += len(files)
        if count > 8192:
            raise ValueError('Media operation audit inventory exceeded its bound.')
        names = {file.name for file in files}
        for file in files:
            ordinary(file)
            if not re.fullmatch('[a-f0-9]{32}\\.(pending|terminal|stop)\\.json', file.name):
                raise ValueError('Unknown original media audit image.')
            pending = file.with_name(file.name[:32] + '.pending.json')
            if pending.name not in names:
                raise ValueError('Orphan original media audit image.')
            if not file.name.endswith('.pending.json'):
                continue
            terminal = file.with_name(file.name.replace('.pending.json', '.terminal.json'))
            if terminal.name not in names:
                raise ValueError('Unfinished original media request remains; automatic replay refused.')
            pending = read(file)
            original = json.loads(pending)
            if not isinstance(original, dict) or original.get('format') != 'raya.media.pending.v1':
                raise ValueError('Original media pending request is invalid.')
            operation = request(original.get('operation'), observe=False)
            if original.get('requestSHA') != sha(encode(operation)) or operation['request'] != file.name[:32] or operation['epoch'] != folder.name:
                raise ValueError('Original media pending identity differs.')
            value = json.loads(read(terminal))
            if not isinstance(value, dict) or value.get('format') != 'raya.media.terminal.v1' or value.get('pendingSHA') != sha(pending) or any(value.get(key) != operation[key] for key in ('request', 'epoch', 'release', 'policySHA', 'op')) or value.get('status') not in ('completed', 'failed') or value.get('authority') is not False or value.get('replay') is not False:
                raise ValueError('Original media terminal does not bind its pending request.')
            if 'ownership' in value:
                from supervisor import joined
                if not joined(value['ownership']) or type(value.get('accepted')) is not bool or value.get('forced') is not False:
                    raise ValueError('Original media terminal ownership is unproven.')
            stop = file.with_name(file.name[:32] + '.stop.json')
            if stop.name in names:
                row = dict(format='raya.media.worker.stop.v1', request=operation['request'], epoch=operation['epoch'], release=operation['release'], policySHA=operation['policySHA'], pendingSHA=sha(pending))
                if read(stop) != encode(row):
                    raise ValueError('Original media STOP does not bind its pending request.')


class Session:
    def __init__(self, value):
        self.value = request(value)
        self.root = location(value['selection']['root']) / 'Requests'
        self.root.mkdir(exist_ok=True)
        ordinary(self.root, directory=True)
        debt(self.root)
        self.serial = threading.Lock()
        self.lock = self.root / 'active.json'
        self.dir = self.root / value['epoch']
        self.dir.mkdir(exist_ok=True)
        ordinary(self.dir, directory=True)
        self.pending = self.dir / (value['request'] + '.pending.json')
        self.terminal = self.dir / (value['request'] + '.terminal.json')
        if self.pending.exists() or self.terminal.exists():
            raise ValueError('Original media request already published; automatic replay refused.')
        self.fence = dict(format='raya.media.active.v1', request=value['request'], epoch=value['epoch'], requestSHA=sha(encode(value)))
        self.held = publish(self.lock, self.fence)
        self.raw = publish(self.pending, dict(format='raya.media.pending.v1', operation=value, requestSHA=self.fence['requestSHA'], started=time.time()))

    def stop(self):
        with self.serial:
            self.cancel()

    def cancel(self):
        if read(self.lock) != self.held or read(self.pending) != self.raw:
            raise ValueError('Media cancellation audit CAS refused.')
        path = self.dir / (self.value['request'] + '.stop.json')
        row = dict(format='raya.media.worker.stop.v1', request=self.value['request'], epoch=self.value['epoch'], release=self.value['release'], policySHA=self.value['policySHA'], pendingSHA=sha(self.raw))
        if path.exists():
            if read(path) != encode(row):
                raise ValueError('Original media cancellation changed.')
            return
        publish(path, row)

    def finish(self, status, result, ownership=None, accepted=None):
        if status not in ('completed', 'failed') or read(self.lock) != self.held or read(self.pending) != self.raw or self.terminal.exists():
            raise ValueError('Original media operation audit CAS refused.')
        row = dict(format='raya.media.terminal.v1', request=self.value['request'], epoch=self.value['epoch'], release=self.value['release'], policySHA=self.value['policySHA'], op=self.value['op'], pendingSHA=sha(self.raw), status=status, result=result, finished=time.time(), authority=False, replay=False)
        if ownership is not None:
            row.update(ownership=ownership, accepted=accepted, forced=False)
        publish(self.terminal, row)
        if read(self.lock) != self.held or read(self.pending) != self.raw:
            raise ValueError('Media operation changed before retirement fence release.')
        self.lock.unlink()
        return row
