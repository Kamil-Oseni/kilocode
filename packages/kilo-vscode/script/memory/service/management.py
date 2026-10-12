"""Reviewed personal-entry proposals; project-file proposals remain unchanged."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat

from admission import image as held
from capture import policy, validate as capture_validate, render as capture_render
from entries import records, render, supersede, fingerprint
from notes import FOLDERS, RecoveryNeeded, clean, digest, identity, safe, recorded
from proposals import Proposals, canonical
from policy import Policy


def image(path, bound=1048576):
    path = Path(path)
    if type(bound) is not int or not 1 <= bound <= 8000000:
        raise ValueError('Bounded retained image required.')
    if bound <= 1048576:
        raw = held(path)
        if len(raw) > bound:
            raise ValueError('Retained image exceeds its bound.')
        return raw
    safe(path)
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > bound:
        raise ValueError('Bounded ordinary retained image required.')
    with path.open('rb') as file:
        first = os.fstat(file.fileno())
        raw = file.read(bound + 1)
        last = os.fstat(file.fileno())
    after = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
    expected = tuple(getattr(before, name) for name in fields)
    if (any(tuple(getattr(row, name) for name in fields) != expected for row in (first, last, after)) or
            before.st_ctime_ns != after.st_ctime_ns or first.st_ctime_ns != last.st_ctime_ns or len(raw) != before.st_size):
        raise ValueError('Retained image changed while reading.')
    return raw


def source(value, span, mode):
    if not isinstance(value, dict) or set(value) != {'sessionID', 'messageID', 'created_utc', 'text', 'source_sha256'}:
        raise ValueError('Exact original user source required.')
    for key in ('sessionID', 'messageID'):
        if not isinstance(value[key], str) or not 1 <= len(value[key]) <= 256:
            raise ValueError('Original user identity differs.')
    text = value['text']
    if not isinstance(text, str) or not text.strip() or len(text.encode('utf-8')) > 24000 or len(text.encode('utf-16-le')) // 2 > 16000:
        raise ValueError('Original user text exceeds its bound.')
    if re.search(r'\b(?:password|passphrase|api[- ]?key|access[- ]?token|secret)\s*(?:is|=|:)\s*\S', text, re.I):
        raise ValueError('Sensitive original user source refused.')
    stamp = datetime.fromisoformat(value['created_utc'])
    if stamp.utcoffset() != timezone.utc.utcoffset(stamp) or stamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z') != value['created_utc']:
        raise ValueError('Canonical original UTC timestamp required.')
    framed = json.dumps([value['sessionID'], value['messageID'], value['created_utc'], text], ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if digest(framed) != value['source_sha256']:
        raise ValueError('Original user source hash differs.')
    if mode == 'forget':
        if span is not None:
            raise ValueError('Forgetting does not accept replacement text.')
        return None
    if not isinstance(span, dict) or set(span) != {'start', 'end'} or any(type(span[key]) is not int for key in span):
        raise ValueError('Exact original UTF-16 fact span required.')
    raw = text.encode('utf-16-le')
    if not 0 <= span['start'] < span['end'] <= len(raw) // 2:
        raise ValueError('Original fact span is outside its source.')
    # Strict decoding rejects an offset inside either half of a surrogate pair.
    fact = raw[span['start'] * 2:span['end'] * 2].decode('utf-16-le')
    if not fact.strip() or len(fact.encode('utf-8')) > 4096 or '<!-- raya.memory.' in fact:
        raise ValueError('Bounded complete original fact required.')
    return fact


def captured(store, name, row):
    """Validate immutable capture/source/journal receipts, not Markdown headings."""
    folder = store.system / 'Capture' / identity(row['capture'])
    for file in (folder, folder / 'input.json', folder / 'request.json'):
        safe(file)
    raw = image(folder / 'input.json', 65536)
    body = json.loads(raw)
    if body['format'] != 'raya.memory.capture.v3' or capture_validate(body) != raw or body['id'] != row['capture']:
        raise ValueError('Captured entry has no exact structured original source.')
    item = next((item for item in body['entries'] if item['key'] == row['key'] and item['category'] == name.split('/')[0]), None)
    if item is None:
        raise ValueError('Captured entry key differs from its original receipt.')
    request = json.loads(image(folder / 'request.json', 2100000))
    state = store.state(body['id'])
    if state['status'] != 'committed' or state['mode'] != 'apply' or state['capture_enabled'] is not False:
        raise RecoveryNeeded('Captured entry publication is not confirmed.')
    if state['request_sha256'] != digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode('utf-8')) or state['sources'] != request['sources']:
        raise ValueError('Captured entry journal differs from its retained request.')
    journal = store.journal / body['id']
    for number, original in enumerate(state['sources']):
        if digest(image(journal / ('source-' + str(number) + '.txt'), 2000000)) != original['sha256']:
            raise ValueError('Captured original source snapshot changed.')
    matches = [(number, entry) for number, entry in enumerate(state['changes']) if entry['path'] == name]
    if len(matches) != 1:
        raise ValueError('Captured note differs from its original publication scope.')
    number, entry = matches[0]
    old = None if entry['old_sha256'] is None else image(journal / ('before-' + str(number) + '.md'), 256000)
    after = image(journal / ('after-' + str(number) + '.md'), 256000)
    if (old is not None and digest(old) != entry['old_sha256']) or digest(after) != entry['new_sha256']:
        raise ValueError('Captured note snapshots changed.')
    expected = capture_render(body, name.split('/')[0], old)
    if (expected + recorded(journal, state['observed_utc'], state['sources'])).encode('utf-8') != after:
        raise ValueError('Captured publication differs from its original structured facts.')
    _, original, _, _ = records(name, after.decode('utf-8'))
    selected = [item for item in original if item['entry'] == row['entry']]
    if len(selected) != 1 or selected[0]['raw'] != row['raw']:
        raise ValueError('Captured entry no longer has its exact original boundary.')


class Management(Proposals):
    def __init__(self, root, gate=None):
        super().__init__(root)
        self.gate = gate
        self.candidates_root = self.store.system / 'ManagementCandidates'
        self.sources_root = self.store.system / 'ManagementSources'

    def check(self):
        self.store.admission.check()
        if self.gate is not None:
            self.gate()

    def entry(self, name, row):
        if row['kind'] == 'capture':
            captured(self.store, name, row)
        if row['kind'] == 'managed':
            value = self.load(identity(row['entry']))
            state = self.publication(value, current=False)
            matches = [(number, item) for number, item in enumerate(state['changes']) if item['path'] == name]
            if len(matches) != 1:
                raise ValueError('Managed entry differs from its original journal scope.')
            number, _ = matches[0]
            raw = image(self.store.journal / value['id'] / ('after-' + str(number) + '.md'), 256000)
            _, original, _, _ = records(name, raw.decode('utf-8'))
            selected = [item for item in original if item['entry'] == row['entry']]
            if len(selected) != 1 or selected[0]['raw'] != row['raw']:
                raise ValueError('Managed entry lacks its exact retained original publication.')

    def immutable(self, folder, name, raw):
        safe(folder)
        folder.mkdir(exist_ok=True)
        file = folder / name
        safe(file)
        if file.exists():
            if image(file, 262144) != raw:
                raise ValueError('Original management identity already differs.')
            return file
        if len(list(folder.iterdir())) >= 128:
            raise ValueError('Management review retention needs explicit archival.')
        with file.open('xb') as stream:
            stream.write(raw)
            stream.flush()
            import os
            os.fsync(stream.fileno())
        return file

    def candidates(self, body, project):
        if set(body) != {'action', 'project', 'query', 'expected_policy_sha256'} or not isinstance(body['query'], str) or not body['query'].strip() or len(body['query']) > 2000:
            raise ValueError('Bounded original target query required.')
        _, _, selected = policy(self.store.root, body['expected_policy_sha256'])
        terms = set(re.findall(r'\w+', body['query'].casefold()))
        if not terms:
            raise ValueError('A meaningful entry query is required.')
        found = []
        matched = 0
        with self.store.guard():
            clean(self.store.root)
            for decision in sorted(selected.files.values(), key=lambda row: row['relative']):
                name = decision['relative']
                if not selected.admit(name) or name.split('/')[0] not in FOLDERS:
                    continue
                try:
                    target = self.store.target(name)
                except ValueError:
                    continue
                raw = self.store.current(target)
                if raw is None:
                    raise ValueError('An approved Memory source disappeared.')
                selected.verify(name, raw)
                filehash = digest(raw)
                _, entries, retired, _ = records(name, raw.decode('utf-8'))
                for entry in entries:
                    if entry['entry'] in retired or not terms.intersection(re.findall(r'\w+', entry['excerpt'].casefold())):
                        continue
                    self.entry(name, entry)
                    row = {'relative': name, 'note_sha256': filehash, 'start': entry['start'], 'end': entry['end'],
                           'excerpt': entry['excerpt'], 'excerpt_sha256': digest(entry['excerpt'].encode('utf-8')),
                           'entry_sha256': digest(entry['raw']), 'kind': entry['kind'], 'entry': entry['entry']}
                    row['id'] = digest(canonical([project, body['expected_policy_sha256'], row]))
                    matched += 1
                    found.append(row)
                    if len(found) > 13:
                        found.sort(key=lambda row: (-len(terms.intersection(re.findall(r'\w+', row['excerpt'].casefold()))), row['relative'], row['start']))
                        found.pop()
            if digest(image(self.store.admission.file)) != body['expected_policy_sha256']:
                raise ValueError('Original approved source policy changed.')
        found.sort(key=lambda row: (-len(terms.intersection(re.findall(r'\w+', row['excerpt'].casefold()))), row['relative'], row['start']))
        for row in found[:12]:
            self.immutable(self.candidates_root, row['id'] + '.json', canonical({'project': project, 'policy': body['expected_policy_sha256'], 'candidate': row}))
        return {'candidates': found[:12], 'truncated': matched > 12, 'capture_enabled': False}

    def plan(self, body, project):
        allowed = {'action', 'project', 'id', 'mode', 'source', 'expected_policy_sha256', 'fact', 'candidate', 'category'}
        required = {'action', 'project', 'id', 'mode', 'source', 'expected_policy_sha256'}
        if not required <= set(body) <= allowed or body['mode'] not in {'remember', 'correct', 'forget'}:
            raise ValueError('Exact personal-entry plan required.')
        key = identity(body['id'])
        if body['mode'] == 'forget' and 'fact' in body:
            raise ValueError('Forgetting does not accept a fact field.')
        fact = source(body['source'], body.get('fact'), body['mode'])
        _, _, selected = policy(self.store.root, body['expected_policy_sha256'])
        if body['mode'] == 'remember':
            if 'candidate' in body or body.get('category') not in FOLDERS:
                raise ValueError('An approved new-entry category is required.')
            category = body['category']
            name = 'Daily/' + body['source']['created_utc'][:10] + '.md' if category == 'Daily' else category + '/Raya.md'
            target = self.store.target(name)
            old = self.store.current(target)
            if old is not None:
                selected.verify(name, old)
            elif name.casefold() in selected.files:
                raise ValueError('An earlier source decision cannot be replaced.')
            if old is None and len(selected.files) >= 128:
                raise ValueError('Reviewed source capacity needs attention before adding a note.')
            content = ('' if old is None else old.decode('utf-8')) + render(key, body['source']['source_sha256'], fact)
        else:
            if 'category' in body or not isinstance(body.get('candidate'), str) or not re.fullmatch('[a-f0-9]{64}', body['candidate']):
                raise ValueError('Select one retained exact entry candidate.')
            candidate = json.loads(image(self.candidates_root / (body['candidate'] + '.json'), 16384))
            if candidate['project'] != project or candidate['policy'] != body['expected_policy_sha256']:
                raise ValueError('Candidate belongs to another original scope.')
            row = candidate['candidate']
            name = row['relative']
            old = self.store.current(self.store.target(name))
            if old is None or digest(old) != row['note_sha256']:
                raise ValueError('Selected note revision changed; review again.')
            selected.verify(name, old)
            _, entries, retired, _ = records(name, old.decode('utf-8'))
            matches = [entry for entry in entries if entry['entry'] == row['entry'] and entry['start'] == row['start'] and entry['end'] == row['end'] and digest(entry['raw']) == row['entry_sha256'] and digest(entry['excerpt'].encode('utf-8')) == row['excerpt_sha256']]
            if len(matches) != 1 or matches[0]['entry'] in retired:
                raise ValueError('Selected exact active entry differs.')
            entry = matches[0]
            self.entry(name, entry)
            # Append for all categories: immutable history, exact unrelated bytes,
            # and the same active-entry rule also cover Daily without exceptions.
            content = old.decode('utf-8') + supersede(key, entry, body['mode'])
            if body['mode'] == 'correct':
                content += render(key, body['source']['source_sha256'], fact)
        if len(content.encode('utf-8')) > 250000:
            raise ValueError('Personal entry plan exceeds the note writer bound.')
        return {'path': name, 'expected': None if old is None else digest(old), 'content': content,
                'before': None if old is None else old.decode('utf-8')}

    def preview(self, key, project, body):
        with self.store.guard():
            clean(self.store.root)
            change = self.plan(body, project)
            raw = canonical(body)
            sourcefile = self.immutable(self.sources_root, key + '.json', raw)
            original = {'path': str(sourcefile), 'sha256': digest(raw), 'kind': 'user_statement', 'event_time': body['source']['created_utc']}
            self.store.sources([original])
        return {'format': 'raya.memory.proposal.v1', 'id': key, 'project': project, 'status': 'pending',
                'capture_enabled': False, 'sources': [original], 'changes': [change], 'management': body,
                'provenance': 'Exact original user conversation source; entry-specific change. History and source snapshots are retained.'}

    def verified(self, value):
        body = value.get('management')
        if not isinstance(body, dict) or body['id'] != value['id'] or body['project'] != value['project']:
            raise ValueError('Exact original conversation proposal required.')
        raw = image(self.sources_root / (value['id'] + '.json'), 65536)
        original = {'path': str(self.sources_root / (value['id'] + '.json')), 'sha256': digest(raw),
                    'kind': 'user_statement', 'event_time': body['source']['created_utc']}
        if raw != canonical(body) or value['sources'] != [original]:
            raise ValueError('Original conversation source snapshot changed.')
        source(body['source'], body.get('fact'), body['mode'])
        return body

    def publication(self, value, current=True):
        body = self.verified(value)
        pending = dict(value, status='pending')
        for name in ('digest', 'reviewed_digest', 'receipt'):
            pending.pop(name, None)
        if value['status'] not in {'applying', 'applied'} or value.get('reviewed_digest') != digest(canonical(pending)):
            raise ValueError('Original reviewed manual plan digest differs.')
        state = self.store.state(value['id'])
        request = {'id': value['id'], 'changes': [{name: entry[name] for name in ('path', 'expected', 'content')} for entry in value['changes']], 'sources': value['sources']}
        if state['status'] != 'committed' or state['mode'] != 'apply' or state['capture_enabled'] is not False or state['request_sha256'] != digest(json.dumps(request, sort_keys=True, ensure_ascii=False).encode('utf-8')):
            raise RecoveryNeeded('Original manual publication is not confirmed.')
        if state['sources'] != value['sources'] or len(state['changes']) != len(value['changes']):
            raise ValueError('Manual journal scope differs.')
        journal = self.store.journal / value['id']
        for number, original in enumerate(state['sources']):
            if digest(image(journal / ('source-' + str(number) + '.txt'), 2000000)) != original['sha256']:
                raise ValueError('Manual journal source changed.')
        for number, entry in enumerate(state['changes']):
            change = value['changes'][number]
            expected = (change['content'] + recorded(journal, state['observed_utc'], value['sources'])).encode('utf-8')
            if entry['path'] != change['path'] or entry['old_sha256'] != change['expected'] or digest(expected) != entry['new_sha256']:
                raise ValueError('Manual journal effect differs from its exact plan.')
            if entry['old_sha256'] is not None:
                prior = image(journal / ('before-' + str(number) + '.md'), 256000)
                if digest(prior) != entry['old_sha256'] or prior != change['before'].encode('utf-8'):
                    raise ValueError('Original manual before-image changed.')
            if image(journal / ('after-' + str(number) + '.md'), 256000) != expected or (current and self.store.current(self.store.target(entry['path'])) != expected):
                raise ValueError('Actual note differs from the original reviewed publication.')
            _, rows, retired, changes = records(entry['path'], expected.decode('utf-8'))
            if body['mode'] != 'forget' and not any(row['entry'] == value['id'] and row['entry'] not in retired for row in rows):
                raise ValueError('Published personal entry is not active.')
            if body['mode'] != 'remember' and not any(row['id'] == value['id'] and row['target'] in retired for row in changes):
                raise ValueError('Original selected entry remains active.')
        return state

    def execute(self, body):
        self.check()
        if not isinstance(body, dict) or body.get('action') not in {'candidates', 'preview', 'read', 'cancel', 'apply'}:
            raise ValueError('Select a dedicated personal Memory action.')
        project = self.project(body.get('project'))
        if body['project'] != project:
            raise ValueError('Canonical original project required.')
        with self.guard():
            if body['action'] == 'candidates':
                return self.candidates(body, project)
            key = identity(body.get('id'))
            if body['action'] == 'preview':
                if self.path(key).exists() or (self.store.journal / key).exists():
                    raise ValueError('Original management attempt exists; inspect it instead of repeating.')
                return self.save(self.preview(key, project, body))
            fields = {'action', 'project', 'id'} | (set() if body['action'] == 'read' else {'digest'})
            if set(body) != fields:
                raise ValueError('Exact original personal proposal fields required.')
            value = self.load(key, project)
            self.verified(value)
            if body['action'] == 'read':
                if value['status'] == 'applied':
                    self.publication(value)
                if value['status'] == 'applying':
                    # Observation only: retain the applying ledger and original
                    # digest. A committed note journal can qualify publication,
                    # but does not claim the index or authorize reapplication.
                    try:
                        state = self.publication(value)
                    except (OSError, ValueError, RecoveryNeeded):
                        return dict(value, publication_confirmed=False, index_confirmed=False)
                    return dict(value, publication_confirmed=True, index_confirmed=False,
                                changes_observed=[{'relative': row['path'], 'note_sha256': row['new_sha256']} for row in state['changes']])
                return value
            if value['status'] != 'pending' or body['digest'] != value['digest']:
                raise RecoveryNeeded('Original proposal changed or publication is unconfirmed; inspect without replay.')
            if body['action'] == 'cancel':
                return self.save(dict(value, status='cancelled'))
            with self.store.guard():
                clean(self.store.root)
                if self.plan(value['management'], project) != value['changes'][0]:
                    raise ValueError('Original entry plan changed; review again.')
            value = self.save(dict(value, status='applying', reviewed_digest=value['digest']))
            try:
                request = {'id': key, 'changes': [{name: entry[name] for name in ('path', 'expected', 'content')} for entry in value['changes']], 'sources': value['sources']}
                def check(phase):
                    self.check()
                    if digest(image(self.store.admission.file)) != value['management']['expected_policy_sha256']:
                        raise ValueError('Original manual source policy changed before publication.')
                result = self.store.apply(request, observe=check)
                self.publication(value)
                self.check()
                return self.save(dict(value, status='applied', receipt=result))
            except Exception as err:
                raise RecoveryNeeded('Original manual proposal requires explicit reconciliation; it was not replayed.') from err


def authorize(root, key, signature, expected):
    api = Management(root)
    with api.guard(), api.store.guard():
        value = api.load(identity(key))
        if value['status'] != 'pending' or value['digest'] != signature:
            raise ValueError('Exact pending reviewed manual proposal required.')
        api.verified(value)
        if value['management']['expected_policy_sha256'] != expected or api.plan(value['management'], value['project']) != value['changes'][0]:
            raise ValueError('Original manual source or policy changed.')


def refresh(root, key, signature, expected, gate):
    if not callable(gate):
        raise ValueError('Original manual proposal generation gate required.')
    api = Management(root)
    with api.guard():
        value = api.load(identity(key))
        if value['status'] not in {'applying', 'applied'} or value.get('reviewed_digest') != signature or value['management']['expected_policy_sha256'] != expected:
            raise ValueError('Exact accepted manual proposal required.')
        admission, old, selected = policy(root, expected)
        state = api.publication(value)
        rows = {row['relative'].casefold(): dict(row) for row in old['files']}
        for entry in state['changes']:
            before = selected.files.get(entry['path'].casefold())
            if entry['old_sha256'] is not None:
                if before is None or before['review'] != 'approved' or before['sha256'] != entry['old_sha256']:
                    raise ValueError('Only the approved prior manual source may advance.')
            elif before is not None:
                raise ValueError('An earlier source decision cannot be replaced.')
            rows[entry['path'].casefold()] = {'relative': entry['path'], 'sha256': entry['new_sha256'], 'classification': 'general', 'review': 'approved'}
        successor = dict(old, revision=old['revision'] + 1, files=list(rows.values()))
        Policy(successor)
        def check():
            gate()
            if api.publication(value) != state:
                raise ValueError('Original manual publication changed during policy advancement.')
        sha = admission.replace(successor, expected, gate=check)
        return {'policy_sha256': sha, 'policy': successor, 'capture_enabled': False,
                'proposal_id': key, 'journal_id': state['id'], 'source_policy_refreshed': True,
                'publication_confirmed': True, 'index_confirmed': False,
                'changes': [{'relative': row['path'], 'note_sha256': row['new_sha256']} for row in state['changes']]}


def publish(root, key, signature, expected, gate):
    """Trusted original native command owns publication before policy advancement."""
    if not callable(gate):
        raise ValueError('Original manual publication generation gate required.')
    gate()
    authorize(root, key, signature, expected)
    api = Management(root, gate)
    value = api.load(identity(key))
    api.execute({'action': 'apply', 'project': value['project'], 'id': key, 'digest': signature})
    gate()
    return refresh(root, key, signature, expected, gate)
