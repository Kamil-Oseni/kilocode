"""Read-only historical capture effects and an exact admitted policy revision chain."""
import hashlib
import fnmatch
import importlib.abc
import importlib.util
import json
import os
import ctypes
from ctypes import wintypes as w
import msvcrt
from pathlib import Path
import stat
import sys
from datetime import datetime


def review(cfg):
    for name in [cfg['root'], cfg['source']]:
        path = Path(name)
        assert path.is_absolute()
        for item in [path, *path.parents]:
            assert not item.is_symlink() and not item.is_junction()
    root = Path(cfg['root']).resolve(strict=True)
    source = Path(cfg['source']).resolve(strict=True)
    witnesses = {}
    identities = {}

    class Filetime(ctypes.Structure):
        _fields_ = [('low', w.DWORD), ('high', w.DWORD)]

    class Information(ctypes.Structure):
        _fields_ = [('attributes', w.DWORD), ('created', Filetime), ('accessed', Filetime), ('written', Filetime), ('volume', w.DWORD), ('sizehigh', w.DWORD), ('sizelow', w.DWORD), ('links', w.DWORD), ('indexhigh', w.DWORD), ('indexlow', w.DWORD)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.POINTER(Information)]
    kernel.GetFileInformationByHandle.restype = w.BOOL

    def image(path, limit=16777216):
        path = Path(path)
        for item in [path, *path.parents]:
            assert not item.is_symlink() and not item.is_junction()
        before = path.lstat()
        assert stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit
        with path.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            information = Information()
            assert kernel.GetFileInformationByHandle(msvcrt.get_osfhandle(stream.fileno()), ctypes.byref(information))
            assert information.volume == opened.st_dev & 4294967295
            assert (information.indexhigh << 32 | information.indexlow) == opened.st_ino
            assert (information.sizehigh << 32 | information.sizelow) == opened.st_size and information.links == opened.st_nlink
            raw = stream.read(limit + 1)
            ended = os.fstat(stream.fileno())
        after = path.lstat()
        tuple = lambda item: (item.st_dev, item.st_ino, item.st_nlink, item.st_size, item.st_mtime_ns, getattr(item, 'st_birthtime_ns', None), item.st_mode)
        # Windows path stat reports birth time as legacy ctime; fstat reports change time.
        assert before.st_ctime_ns == after.st_ctime_ns and opened.st_ctime_ns == ended.st_ctime_ns
        assert len(raw) <= limit and all(tuple(item) == tuple(before) for item in [opened, ended, after])
        assert not path.is_symlink() and not path.is_junction()
        observed = (tuple(before), before.st_ctime_ns, opened.st_ctime_ns)
        assert str(path) not in identities or identities[str(path)] == observed
        identities.setdefault(str(path), observed)
        # Node/Bun dev is the actual Win32 DWORD volume serial, unlike Python's full64 volume serial.
        native = (information.volume, opened.st_ino, opened.st_nlink, opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
        assert all(type(value) is int and 0 <= value <= 18446744073709551615 for value in native)
        witnesses[str(path)] = dict(path=str(path), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(), tuple=':'.join(str(value) for value in native))
        assert len(witnesses) <= 1024
        return raw

    names = {'server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py', 'host.py', 'operations.py', 'retirement.py', 'namespace.py', 'historical.py', 'dispatch.py', 'proposals.py', 'capture.py'}
    if 'entries.py' in cfg['pins'] or 'management.py' in cfg['pins']:
        names |= {'entries.py', 'management.py'}
    assert set(cfg['pins']) == names
    modules = {}
    for name, sha in cfg['pins'].items():
        raw = image(source / name)
        assert hashlib.sha256(raw).hexdigest() == sha
        modules[name[:-3]] = raw

    class Loader(importlib.abc.Loader):
        def create_module(self, spec):
            return None

        def exec_module(self, module):
            exec(compile(modules[module.__name__], str(source / (module.__name__ + '.py')), 'exec'), module.__dict__)

    class Finder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname, path=None, target=None):
            if fullname not in modules:
                return None
            spec = importlib.util.spec_from_loader(fullname, Loader(), origin=str(source / (fullname + '.py')))
            spec.has_location = True
            return spec

    finder = Finder()
    sys.meta_path.insert(0, finder)
    try:
        from admission import serialize
        from capture import validate, snapshots, render, targets, recorded, identity
        from notes import Store, safe, digest
        from policy import Policy
        from retirement import fingerprint
    finally:
        sys.meta_path.remove(finder)

    store = Store.__new__(Store)
    store.root = root
    store.system = root / 'System'
    store.journal = store.system / 'Changes'
    for folder in [root, store.system, store.journal, store.system / 'Capture']:
        safe(folder)
        assert folder.is_dir()
    ignore = root / '.rayaignore'
    safe(ignore)
    patterns = [] if not ignore.exists() else [line.strip().casefold() for line in image(ignore, 65536).decode('utf-8').splitlines() if line.strip() and not line.startswith('#')]

    def target(name):
        assert isinstance(name, str) and '\\' not in name and all(part and part not in {'.', '..'} for part in name.split('/'))
        path = root.joinpath(*name.split('/'))
        assert path.resolve().is_relative_to(root)
        for item in [path, *path.parents]:
            safe(item)
        assert not any(name.casefold().startswith(pattern) if pattern.endswith('/') else fnmatch.fnmatch(name.casefold(), pattern) for pattern in patterns)
        return path
    def members(folder):
        names = []
        for item in folder.iterdir():
            names.append(item)
            assert len(names) <= 10000
        return sorted(names)
    names = members(store.journal)
    states = {}
    for folder in names:
        safe(folder)
        assert folder.is_dir()
        file = folder / 'manifest.json'
        raw = image(file, 65536)
        value = json.loads(raw)
        assert isinstance(value, dict) and value.get('id') == folder.name and value.get('format') == 'raya-note-change-v1'
        assert isinstance(value.get('changes'), list) and len(value['changes']) <= 128
        states[folder.name] = value

    def effect(key):
        identity(key)
        folder = store.system / 'Capture' / key
        journal = store.journal / key
        safe(folder)
        raw = image(folder / 'input.json', 65536)
        body = json.loads(raw)
        assert validate(body) == raw and body['id'] == key and body['format'] == 'raya.memory.capture.v3'
        request = json.loads(image(folder / 'request.json', 65536))
        sources = [dict(path=str(folder / (origin + '.md')), sha256=digest(data), kind=origin, event_time=body['observed_utc']) for origin, data in snapshots(body)]
        state = states[key]
        assert state['status'] == 'committed' and state['mode'] == 'apply' and state['capture_enabled'] is False
        assert state['request_sha256'] == digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode('utf-8'))
        assert request['sources'] == sources and state['sources'] == sources
        assert {row['path'] for row in state['changes']} == targets(body)
        assert len({row['path'].casefold() for row in state['changes']}) == len(state['changes'])
        stamp = datetime.fromisoformat(state['observed_utc'])
        assert stamp.utcoffset() is not None and stamp.utcoffset().total_seconds() == 0 and stamp.isoformat() == state['observed_utc']
        for index, entry in enumerate(sources):
            assert digest(image(entry['path'], 65536)) == entry['sha256']
            assert digest(image(journal / ('source-' + str(index) + '.txt'), 65536)) == entry['sha256']
        for index, entry in enumerate(state['changes']):
            old = None if entry['old_sha256'] is None else image(journal / ('before-' + str(index) + '.md'))
            new = image(journal / ('after-' + str(index) + '.md'))
            assert (None if old is None else digest(old)) == entry['old_sha256'] and digest(new) == entry['new_sha256']
            prospective = render(body, entry['path'].split('/')[0], old)
            matches = [row for row in request['changes'] if row['path'] == entry['path']]
            assert matches == [dict(path=entry['path'], expected=entry['old_sha256'], content=prospective)]
            assert (prospective + recorded(journal, state['observed_utc'], sources)).encode('utf-8') == new
        return body, state, raw

    turn = cfg['turn']
    body, original, raw = effect(turn['id'])
    assert all(body[left] == turn[right] for left, right in [('project', 'project'), ('session', 'sessionID'), ('message', 'messageID'), ('source_sha256', 'source_sha256')])
    result = dict(id=original['id'], status='committed', duplicate=False, note_sha256={row['path']: row['new_sha256'] for row in original['changes']}, input_sha256=digest(raw))
    assert fingerprint(result) == cfg['resultSHA']
    anchor = cfg['history']
    assert digest(image(store.journal / turn['id'] / 'manifest.json', 65536)) == anchor['journalSHA']
    policyfile = store.system / 'general-admission.json'
    policyraw = image(policyfile)
    policy = json.loads(policyraw)
    assert serialize(policy) == policyraw
    selected = Policy(policy)
    selected.bind(root)
    for row in policy['files']:
        if row['review'] == 'approved':
            file = target(row['relative'])
            selected.verify(row['relative'], image(file))
    current = digest(policyraw)
    rows = anchor['rows']
    if anchor.get('compact') is True:
        assert isinstance(rows, list) and len(rows) <= 64 and all(isinstance(row, list) and len(row) == 7 for row in rows)
        rows = [dict(zip(['id', 'project', 'sessionID', 'messageID', 'source_sha256', 'receipt', 'release'], row), root=cfg['root'], phase='published') for row in rows]
    assert isinstance(rows, list) and len(rows) <= 64 and len({row['id'] for row in rows}) == len(rows)
    accepted = {row['id']: row for row in rows}
    operations = anchor['operations']
    if anchor.get('compact') is True:
        roots = anchor['roots']
        assert isinstance(roots, list) and len(roots) <= 64 and len(set(roots)) == len(roots) and all(isinstance(item, str) for item in roots)
        assert isinstance(operations, list) and len(operations) <= 64 and all(isinstance(row, list) and len(row) == 7 and type(row[2]) is int and 0 <= row[2] < len(roots) for row in operations)
        operations = [dict(zip(['capture', 'bodySHA', 'root', 'epoch', 'request', 'pendingSHA', 'terminalSHA'], [*row[:2], roots[row[2]], *row[3:]])) for row in operations]
    assert isinstance(operations, list) and len(operations) <= 64
    assert len({row['capture'] for row in operations}) == len(operations)
    operations = {row['capture']: row for row in operations}

    def operation(key, later, state, data, previous):
        if key not in operations:
            return False
        assert key in accepted
        selected = operations[key]
        folder = Path(selected['root'])
        assert folder.is_absolute() and folder.name == 'Requests'
        folder = folder / selected['epoch']
        assert len(selected['epoch']) == 32 and all(char in '0123456789abcdef' for char in selected['epoch'])
        assert len(selected['request']) == 32 and all(char in '0123456789abcdef' for char in selected['request'])
        values = []
        for mode in ['pending', 'terminal']:
            raw = image(folder / (selected['request'] + '-' + mode + '.json'), 65536)
            assert digest(raw) == selected[mode + 'SHA']
            values.append(json.loads(raw))
        pending, terminal = values
        assert set(pending) == {'format', 'request', 'owner_epoch', 'selected_release_sha256', 'kind', 'request_sha256', 'status'}
        assert pending['format'] in {'raya.memory.operation.v1', 'raya.memory.operation.v2'} and pending['kind'] == 'capture' and pending['status'] == 'pending'
        assert pending['request'] == selected['request'] and pending['owner_epoch'] == selected['epoch']
        assert pending['selected_release_sha256'] == accepted[key]['release'] and pending['request_sha256'] == selected['bodySHA']
        assert set(terminal) == set(pending) | {'operation_outcome', 'downstream', 'result_sha256', 'receipt_sha256'}
        assert all(terminal[name] == pending[name] for name in pending if name != 'status')
        assert terminal['status'] == 'terminal' and terminal['operation_outcome'] == 'completed' and terminal['downstream'] == []
        assert terminal['receipt_sha256'] == fingerprint({name: value for name, value in terminal.items() if name != 'receipt_sha256'})
        result = dict(id=key, status='committed', duplicate=False, note_sha256={row['path']: row['new_sha256'] for row in state['changes']}, input_sha256=digest(data))
        assert terminal['result_sha256'] == fingerprint(result)
        return selected['bodySHA'] == fingerprint(dict(publication=later, expected_policy_sha256=digest(serialize(previous))))
    used = []
    value = json.loads(policyraw)
    # SHA-connected policy rollback establishes order; event time and reservation order are not authority.
    while digest(serialize(value)) != anchor['policySHA']:
        assert len(used) < 64 and value['revision'] > 1
        records = {row['relative'].casefold(): row for row in value['files']}
        candidates = []
        for key, state in states.items():
            if key == turn['id'] or key in used or key not in operations or not state['changes']:
                continue
            if all(records.get(row['path'].casefold()) == dict(relative=row['path'], sha256=row['new_sha256'], classification='general', review='approved') for row in state['changes']):
                later, checked, data = effect(key)
                prior = json.loads(serialize(value))
                priorrows = {row['relative'].casefold(): row for row in prior['files']}
                for change in checked['changes']:
                    name = change['path'].casefold()
                    if change['old_sha256'] is None:
                        del priorrows[name]
                    else:
                        priorrows[name]['sha256'] = change['old_sha256']
                prior['files'] = list(priorrows.values())
                prior['revision'] -= 1
                Policy(prior).bind(root)
                if operation(key, later, checked, data, prior):
                    candidates.append((key, later, checked, data, prior))
        assert len(candidates) == 1
        key, later, state, data, previous = candidates[0]
        row = accepted[key]
        assert row['phase'] == 'published' and row['root'] == cfg['root'] and row['receipt'] == digest(data)
        assert all(later[left] == row[right] for left, right in [('project', 'project'), ('session', 'sessionID'), ('message', 'messageID'), ('source_sha256', 'source_sha256')])
        value = previous
        used.append(key)
    prior = json.loads(serialize(value))
    records = {row['relative'].casefold(): row for row in prior['files']}
    for change in original['changes']:
        name = change['path'].casefold()
        assert records[name] == dict(relative=change['path'], sha256=change['new_sha256'], classification='general', review='approved')
        if change['old_sha256'] is None:
            del records[name]
        else:
            records[name]['sha256'] = change['old_sha256']
    prior['files'] = list(records.values())
    prior['revision'] -= 1
    Policy(prior).bind(root)
    previous = digest(serialize(prior))
    assert previous == anchor['previousPolicySHA']
    assert fingerprint(dict(publication=body, expected_policy_sha256=previous)) == cfg['bodySHA']
    currentrows = {row['relative'].casefold(): row for row in policy['files']}
    for key, state in states.items():
        if key == turn['id'] or key in used or not state['changes']:
            continue
        forward = all((row['old_sha256'] is None and row['path'].casefold() not in currentrows) or (row['old_sha256'] is not None and currentrows.get(row['path'].casefold()) == dict(relative=row['path'], sha256=row['old_sha256'], classification='general', review='approved')) for row in state['changes'])
        if forward:
            assert key in accepted and key in operations
            later, checked, data = effect(key)
            assert not operation(key, later, checked, data, policy)
    frontier = {row['path']: {row['new_sha256']} for row in original['changes']}
    connected = set()
    while True:
        additions = []
        for key, state in states.items():
            if key == turn['id'] or key in connected:
                continue
            if any(row['old_sha256'] in frontier.get(row['path'], set()) for row in state['changes']):
                additions.append(key)
        if not additions:
            break
        for key in additions:
            connected.add(key)
            assert key in used
            for row in states[key]['changes']:
                known = frontier.setdefault(row['path'], set())
                assert row['new_sha256'] not in known
                known.add(row['new_sha256'])
    effectvalue = dict(format='raya.memory.committed-capture.review', version=1, capture=turn['id'], inputSHA=digest(raw), journalSHA=anchor['journalSHA'], policySHA=anchor['policySHA'], previousPolicySHA=previous, result=result, requestSettlement=False, replay=False, indexConfirmed=False)
    for ref in list(witnesses.values()):
        assert digest(image(ref['path'])) == ref['sha256']
    assert [item.name for item in members(store.journal)] == [item.name for item in names]
    assert ignore.exists() == (str(ignore) in witnesses)
    return dict(format='raya.memory.capture-revisions.v1', effect=effectvalue, policySHA=current, chain=list(reversed(used)), membership=[item.name for item in names], ignore_present=ignore.exists(), witnesses=list(witnesses.values()), requestSettlement=False, replay=False, indexConfirmed=False)


def diagnostic(err):
    classes = {AssertionError: 'AssertionError', ValueError: 'ValueError', TypeError: 'TypeError', KeyError: 'KeyError', OSError: 'OSError', RuntimeError: 'RuntimeError', FileNotFoundError: 'FileNotFoundError', PermissionError: 'PermissionError', NotADirectoryError: 'NotADirectoryError', IsADirectoryError: 'IsADirectoryError'}
    name = classes.get(type(err), 'Exception')
    stage = 'main'
    line = 0
    caller = 'main'
    prior = 0
    trace = err.__traceback__
    while trace:
        code = trace.tb_frame.f_code
        if code.co_filename == __file__ and code.co_name in {'<module>', 'review', 'image', 'members', 'effect', 'operation'}:
            caller, prior = stage, line
            stage = 'main' if code.co_name == '<module>' else code.co_name
            line = trace.tb_lineno
        trace = trace.tb_next
    location = f'; caller={caller}; caller_line={prior}' if prior else ''
    return f'Historical capture revision refused; stage={stage}; line={line}{location}; class={name}.'


if __name__ == '__main__':
    try:
        assert len(sys.argv) == 2 and len(sys.argv[1].encode()) <= 8192
        print(json.dumps(review(json.loads(sys.argv[1])), sort_keys=True, separators=(',', ':')))
    except Exception as err:
        print(diagnostic(err), file=sys.stderr)
        sys.exit(1)
