"""Actual selected Journal codec, inert temporary sink, no server/model/native ownership proof."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

root = Path(sys.argv[1]).resolve(strict=True)
cfg = json.loads(sys.stdin.buffer.read(16384))
pins = cfg['release']
names = {'server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py', 'host.py',
         'operations.py', 'retirement.py', 'namespace.py', 'historical.py', 'dispatch.py', 'proposals.py'}
assert isinstance(pins, dict) and set(pins) == names
for name, expected in pins.items():
    assert isinstance(expected, str) and len(expected) == 64 and set(expected) <= set('0123456789abcdef')
    raw = (root / name).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == expected
for name in ('namespace', 'retirement', 'operations'):
    spec = importlib.util.spec_from_file_location(name, root / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
from operations import Journal
from retirement import fingerprint

class Files:
    def publish(self, folder, name, raw):
        assert len(raw) <= 65536
        with (folder / name).open('xb') as file:
            file.write(raw)

with tempfile.TemporaryDirectory(prefix='raya-memory-host-codec-') as temp:
    owner = Journal.__new__(Journal)
    owner.namespace = Files()
    owner.folder = Path(temp)
    owner.epoch = cfg['epoch']
    owner.release = fingerprint(pins)
    pending = owner.reserve(cfg['id'], cfg['kind'], cfg['body'])
    result = {'files': 1, 'chunks': 2, 'new_embeddings': 1, 'reused_embeddings': 1}
    if cfg['kind'] == 'search':
        result = {'capture_enabled': False, 'results': []}
        if 'context_budget' in cfg['body']:
            result['context'] = {'sources': [], 'diagnostics': [], 'tokens': 0,
                                 'truncated': False, 'capture_enabled': False}
    # Empty downstream is a genuine no-inference codec case, not a fabricated worker claim.
    terminal = owner.complete(pending, result, 'completed', [])
    print(json.dumps({'terminal': terminal, 'response': dict(result, operation=terminal)},
                    ensure_ascii=False, allow_nan=False, separators=(',', ':')))
