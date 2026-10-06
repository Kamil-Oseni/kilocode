"""Production linked reader and Journal codecs over disposable notes.

The sink substitutes only namespace publication. This is a data/transport
fixture, not native ownership, ACL, tokenization or installed acceptance.
"""
import ast
import base64
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
import tempfile
import uuid
from urllib.parse import unquote

source = Path(sys.argv[1]).resolve(strict=True)
for name in ('namespace', 'retirement', 'operations', 'policy'):
    spec = importlib.util.spec_from_file_location(name, source / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
from operations import Journal
from policy import Policy
from retirement import fingerprint, canonical

pins = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source.glob('*.py')}
tree = ast.parse((source / 'index.py').read_bytes())
names = {'ordinary', 'image', 'address', 'links', 'passage', 'retrieve'}
code = ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
exec(compile(ast.fix_missing_locations(code), str(source / 'index.py'), 'exec'), globals())


class Sink:
    def publish(self, folder, name, raw):
        with (folder / name).open('xb') as file:
            file.write(raw)


with tempfile.TemporaryDirectory(prefix='raya-linked-wire-') as tmp:
    root = Path(tmp).resolve()
    notes = root / 'notes'
    notes.mkdir()
    (notes / 'Projects').mkdir()
    texts = {'INDEX.md': '# Memory\n[Eden](Projects/Eden.md)\n',
             'Projects/Eden.md': '# Eden\nEden café 日本語 😀\n'}
    policy = Policy({'format': 'raya-general-sources-v1', 'root': str(notes), 'enabled': True, 'revision': 1,
                     'files': [{'relative': name, 'sha256': hashlib.sha256(text.encode()).hexdigest(),
                                'classification': 'general', 'review': 'approved'} for name, text in texts.items()]})
    for name, text in texts.items():
        (notes / name).write_bytes(text.encode())
    context = retrieve(notes, policy, [], 'Eden', 1000, len, lambda: None)
    if '--publication' in sys.argv:
        # The trusted review callback is represented by an explicit fixture Apply;
        # this does not exercise native consent or source-policy publication.
        sys.path.insert(0, str(source))
        from proposals import Proposals
        project = root / 'project'
        project.mkdir()
        evidence = project / 'approved.md'
        content = '# Eden\nEden now uses warm amber café lighting 日本語 😀.\n'
        evidence.write_bytes(content.encode())
        name = 'Projects/Eden.md'
        previous = hashlib.sha256((notes / name).read_bytes()).hexdigest()
        store = Proposals(notes)
        pending = store.execute({'action': 'propose', 'id': str(uuid.uuid4()), 'project': str(project), 'request': {
            'sources': [{'path': str(evidence), 'sha256': hashlib.sha256(evidence.read_bytes()).hexdigest(),
                         'kind': 'document', 'event_time': None}],
            'changes': [{'path': name, 'expected': previous, 'content': content}],
        }})
        applied = store.execute({'action': 'apply', 'id': pending['id'], 'project': str(project), 'digest': pending['digest']})
        ledger = notes / 'System' / 'Proposals' / (pending['id'] + '.json')
        saved = ledger.read_bytes()
        published = (notes / name).read_bytes()
        sha = hashlib.sha256(published).hexdigest()
        stale = retrieve(notes, policy, [], 'Eden', 1000, len, lambda: None)
        texts[name] = published.decode()
        reviewed = Policy({'format': 'raya-general-sources-v1', 'root': str(notes), 'enabled': True, 'revision': 2,
                           'files': [{'relative': key, 'sha256': hashlib.sha256(text.encode()).hexdigest(),
                                      'classification': 'general', 'review': 'approved'} for key, text in texts.items()]})
        fresh = retrieve(notes, reviewed, [{'relative': name, 'sha256': sha}], 'Eden', 1000, len, lambda: None)
        oldseed = retrieve(notes, reviewed, [{'relative': name, 'sha256': previous}], 'Eden', 1000, len, lambda: None)
        print(json.dumps({'root': str(notes), 'name': name, 'previous': previous, 'sha256': sha, 'content': content,
                          'published': base64.b64encode(published).decode(),
                          'applied': applied, 'stale': stale, 'fresh': fresh, 'oldseed': oldseed,
                          'proposal_unchanged': ledger.read_bytes() == saved, 'note_unchanged': (notes / name).read_bytes() == published,
                          'qualification': 'Actual disposable proposal publication and linked reader; explicit fixture policy, character counter; no index, native consent or installed proof'}))
        sys.exit(0)
    result = {'results': [], 'context': context, 'capture_enabled': False}
    folder = root / 'receipts'
    folder.mkdir()
    journal = object.__new__(Journal)
    journal.namespace = Sink()
    journal.folder = folder
    journal.epoch = 'b' * 32
    journal.release = fingerprint(pins)
    body = {'query': 'Eden', 'top': 5, 'context_budget': 1000}
    request = 'a' * 32
    pending = journal.reserve(request, 'search', body)
    terminal = journal.complete(pending, result, 'completed', [])
    print(json.dumps({'root': str(notes), 'pins': pins, 'body': body,
                      'selected': {'request': request, 'epoch': journal.epoch, 'release': journal.release,
                                   'digest': fingerprint(body), 'kind': 'search', 'budget': 1000},
                      'response': base64.b64encode(canonical(dict(result, operation=terminal))).decode(),
                      'terminal': base64.b64encode(canonical(terminal)).decode(),
                      'qualification': 'Real note reader and Journal codecs; synthetic sink/counter, no native or installed proof'}))
