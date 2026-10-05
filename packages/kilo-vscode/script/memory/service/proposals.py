"""Project-scoped, explicitly reviewed changes; capture is never enabled here."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
from notes import Store, RecoveryNeeded, clean, digest, identity, safe
from admission import closing


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


class Proposals:
    def __init__(self, root):
        self.store = Store(root)
        self.root = self.store.system / 'Proposals'
        safe(self.root)
        self.root.mkdir(exist_ok=True)
        self.lock = self.store.system / 'proposals.lock'

    @contextmanager
    def guard(self):
        import msvcrt
        self.store.admission.check()
        safe(self.root)
        safe(self.lock)
        with self.lock.open('a+b') as file:
            held = os.fstat(file.fileno())
            named = self.lock.stat()
            safe(self.lock)
            if (held.st_dev, held.st_ino, held.st_nlink) != (named.st_dev, named.st_ino, 1):
                raise ValueError('Proposal lock identity changed.')
            if os.fstat(file.fileno()).st_size == 0:
                file.write(b'0')
                file.flush()
                os.fsync(file.fileno())
            file.seek(0)
            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            def unlock():
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            with closing(unlock):
                yield

    def project(self, value):
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError('Select an absolute project directory.')
        path = Path(value)
        for part in [path, *path.parents]:
            safe(part)
        if not path.is_dir():
            raise ValueError('The project directory is unavailable.')
        return str(path.resolve())

    def path(self, key):
        path = self.root / (identity(key) + '.json')
        safe(path)
        return path

    def save(self, value):
        self.store.admission.check()
        safe(self.root)
        value = dict(value)
        value.pop('digest', None)
        value['digest'] = digest(canonical(value))
        if len(canonical(value)) > 3000000:
            raise ValueError('Proposal exceeds its durable review bound.')
        self.listing(value['project'], value)
        self.store.atomic(self.path(value['id']), canonical(value))
        return value

    def listing(self, project, replacement=None):
        result = []
        for path in sorted(self.root.iterdir()):
            safe(path)
            if path.suffix != '.json':
                raise ValueError('Unknown proposal ledger entry.')
            value = self.load(path.stem)
            if replacement is not None and value['id'] == replacement['id']:
                continue
            if value['project'] == project:
                result.append(value)
        if replacement is not None:
            result.append(replacement)
        if len(result) > 128 or len(canonical({'proposals': result})) > 2900000:
            raise ValueError('Review ledger needs local archival.')
        return result

    def pending(self):
        safe(self.root)
        return any(self.load(path.stem)['status'] == 'applying' for path in self.root.iterdir())

    def load(self, key, project=None):
        path = self.path(key)
        if not path.is_file():
            raise ValueError('Proposal is unavailable.')
        if path.stat().st_size > 3000000:
            raise ValueError('Proposal exceeds the review limit.')
        value = json.loads(path.read_text(encoding='utf-8'))
        proof = dict(value)
        proof.pop('digest', None)
        if value.get('format') != 'raya.memory.proposal.v1' or value.get('id') != key or value.get('digest') != digest(canonical(proof)):
            raise ValueError('Proposal integrity is invalid.')
        if project is not None and value['project'] != project:
            raise ValueError('Proposal belongs to another project.')
        return value

    def preview(self, key, project, request):
        if not isinstance(request, dict) or set(request) != {'changes', 'sources'}:
            raise ValueError('Supply changes and sources.')
        if not isinstance(request['changes'], list) or not 1 <= len(request['changes']) <= 16:
            raise ValueError('Supply 1–16 changes.')
        # Source authority is narrower than notes: source files must be in this project.
        if not isinstance(request['sources'], list) or not 1 <= len(request['sources']) <= 8:
            raise ValueError('Supply 1–8 sources.')
        for source in request['sources']:
            if not isinstance(source, dict) or set(source) != {'path', 'sha256', 'kind', 'event_time'} or not isinstance(source.get('path'), str) or not isinstance(source.get('kind'), str):
                raise ValueError('Supply source records.')
            path = Path(source['path'])
            if not path.is_absolute() or '..' in path.parts or not path.resolve().is_relative_to(Path(project)):
                raise ValueError('Source must be contained in the selected project.')
        with self.store.guard():
            clean(self.store.root)
            try:
                sources = self.store.sources(request['sources'])
            except FileNotFoundError as error:
                raise ValueError('Source disappeared; review again.') from error
            changes = []
            names = set()
            total = 0
            for item in request['changes']:
                if not isinstance(item, dict) or set(item) != {'path', 'expected', 'content'}:
                    raise ValueError('Supply exact note path, expected hash and content.')
                target = self.store.target(item['path'])
                name = item['path'].casefold()
                if name in names:
                    raise ValueError('Duplicate note target.')
                names.add(name)
                raw = self.store.current(target)
                if item['expected'] != (None if raw is None else digest(raw)):
                    raise ValueError('Note revision changed; review again.')
                content = item['content']
                if content is not None and (not isinstance(content, str) or not content.strip() or len(content.encode('utf-8')) > 250000):
                    raise ValueError('Supply bounded nonempty Markdown or null for deletion.')
                total += len(content.encode('utf-8')) if content is not None else 0
                if total > 1900000:
                    raise ValueError('Proposal exceeds the review limit.')
                if item['path'].startswith('Daily/') and raw is not None and (content is None or not content.startswith(raw.decode('utf-8'))):
                    raise ValueError('Daily history remains append-oriented.')
                changes.append(dict(item, before=None if raw is None else raw.decode('utf-8')))
        value = {'format': 'raya.memory.proposal.v1', 'id': identity(key), 'project': project,
                'status': 'pending', 'capture_enabled': False,
                'sources': [source for source, _ in sources], 'changes': changes,
                'provenance': 'Apply appends the journal timestamp and retained source-snapshot links to nondeleted notes.'}
        if len(canonical(value)) > 2800000:
            raise ValueError('Complete before/after review exceeds the ledger bound.')
        return value

    def execute(self, body):
        if not isinstance(body, dict) or not isinstance(body.get('action'), str):
            raise ValueError('Select a proposal action.')
        action = body['action']
        fields = {'list': {'action', 'project'}, 'read': {'action', 'project', 'id'},
                  'propose': {'action', 'project', 'id', 'request'},
                  'edit': {'action', 'project', 'id', 'digest', 'request'},
                  'cancel': {'action', 'project', 'id', 'digest'},
                  'apply': {'action', 'project', 'id', 'digest'}}
        if action not in fields or set(body) != fields[action]:
            raise ValueError('Proposal action fields are invalid.')
        project = self.project(body['project'])
        with self.guard():
            if action == 'list':
                return {'proposals': self.listing(project), 'capture_enabled': False}
            key = identity(body['id'])
            if action == 'propose':
                if self.path(key).exists() or (self.store.journal / key).exists():
                    raise ValueError('Proposal identity already exists.')
                return self.save(self.preview(key, project, body['request']))
            value = self.load(key, project)
            if action == 'read':
                return value
            if value['status'] != 'pending' or body['digest'] != value['digest']:
                raise ValueError('Proposal changed or requires reconciliation; review again.')
            if action == 'edit':
                return self.save(self.preview(key, project, body['request']))
            if action == 'cancel':
                return self.save(dict(value, status='cancelled'))
            request = {'changes': [{name: item[name] for name in ('path', 'expected', 'content')} for item in value['changes']],
                       'sources': value['sources']}
            self.preview(key, project, request)
            # Seal before the existing journal operation. Crash/failure cannot authorize replay.
            value = self.save(dict(value, status='applying', reviewed_digest=value['digest']))
            try:
                result = self.store.apply(dict(request, id=key))
                return self.save(dict(value, status='applied', receipt=result))
            except Exception as error:
                raise RecoveryNeeded('An applying proposal requires explicit reconciliation.') from error
