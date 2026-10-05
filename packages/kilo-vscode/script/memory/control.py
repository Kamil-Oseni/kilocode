"""Private trusted-parent control transport; no human authority is inferred."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

FILES = ('server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py', 'host.py', 'operations.py', 'retirement.py', 'namespace.py', 'dispatch.py', 'historical.py', 'proposals.py')


def directory(path):
    row = path.lstat()
    if not stat.S_ISDIR(row.st_mode) or getattr(row, 'st_file_attributes', 0) & 0x400 or not row.st_ino:
        raise ValueError('Ordinary existing directory required.')
    return row.st_dev, row.st_ino, getattr(row, 'st_birthtime_ns', None)


def local(value):
    if not isinstance(value, str) or not re.match(r'^[a-z]:[/\\]', value, re.I):
        raise ValueError('Absolute local path required.')
    path = Path(value)
    for node in reversed((path, *path.parents)):
        directory(node)
    if os.path.normcase(str(path)) != os.path.normcase(str(path.resolve())):
        raise ValueError('Canonical directory required.')
    return path.resolve()


def image(path, limit=1048576):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or getattr(before, 'st_file_attributes', 0) & 0x400 or before.st_size > limit:
        raise ValueError('Bounded ordinary single-link file required.')
    with path.open('rb') as file:
        held = os.fstat(file.fileno())
        raw = file.read(limit + 1)
        final = os.fstat(file.fileno())
    after = path.lstat()
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink')
    expected = tuple(getattr(before, field) for field in fields)
    if any(tuple(getattr(row, field) for field in fields) != expected for row in (held, final, after)) or before.st_ctime_ns != after.st_ctime_ns or held.st_ctime_ns != final.st_ctime_ns or len(raw) != before.st_size:
        raise ValueError('File changed during read.')
    return raw


def pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ValueError('Duplicate field.')
        value[key] = item
    return value


def constant(value):
    raise ValueError('Nonfinite JSON refused.')


def decode(raw):
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def fields(value, names):
    if not isinstance(value, dict) or set(value) != set(names):
        raise ValueError('Exact fields required.')


class Bridge:
    def __init__(self, path):
        local(str(path.parent))
        cfg = decode(image(path, 65536))
        fields(cfg, ('format', 'version', 'root', 'source_dir', 'source_sha256'))
        if cfg['format'] != 'raya.memory.control.setup' or type(cfg['version']) is not int or cfg['version'] != 2:
            raise ValueError('Setup protocol refused.')
        self.root = local(cfg['root'])
        self.system = self.root / 'System'
        # Capture existing directories before Host/Store can mkdir System.
        self.generation = {self.root: directory(self.root), self.system: directory(self.system)}
        self.source = local(cfg['source_dir'])
        self.generation[self.source] = directory(self.source)
        fields(cfg['source_sha256'], FILES)
        self.pins = cfg['source_sha256']
        if any(not isinstance(value, str) or not re.fullmatch('[a-f0-9]{64}', value) for value in self.pins.values()):
            raise ValueError('Exact source hashes required.')
        self.check()
        self.modules = {}
        for name in ('retirement', 'policy', 'admission', 'notes', 'host'):
            if name in sys.modules:
                raise ValueError('Unselected module already loaded.')
            file = self.source / (name + '.py')
            raw = image(file)
            if hashlib.sha256(raw).hexdigest() != self.pins[file.name]:
                raise ValueError('Import source differs.')
            spec = importlib.util.spec_from_file_location(name, file)
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module
            # Execute verified bytes, without adding source_dir to import paths.
            exec(compile(raw, str(file), 'exec'), module.__dict__)
            self.modules[name] = module
        self.check()
        for name in ('retirement', 'policy', 'admission', 'notes', 'host'):
            if Path(sys.modules[name].__file__).resolve() != self.source / (name + '.py'):
                raise ValueError('Imported module path differs.')
        self.host = sys.modules['host'].Host(self.root, existing=True,
            generation={self.root: self.generation[self.root], self.system: self.generation[self.system]})
        self.check()
        self.host.store.check()

    def check(self):
        for path, expected in self.generation.items():
            local(str(path))
            if directory(path) != expected:
                raise ValueError('Captured directory changed.')
        for name in FILES:
            if hashlib.sha256(image(self.source / name)).hexdigest() != self.pins[name]:
                raise ValueError('Selected source changed.')
        for name, module in getattr(self, 'modules', {}).items():
            if sys.modules.get(name) is not module or Path(module.__file__).resolve() != self.source / (name + '.py'):
                raise ValueError('Imported module identity or path changed.')

    def call(self, op, args):
        self.check()
        with sys.modules['admission'].closing(self.check):
            if op == 'state':
                fields(args, ())
                sha, value = self.host.state()
                return {'policy_sha256': sha, 'policy': value, 'capture_enabled': False}
            if op == 'preview':
                fields(args, ('names', 'enabled'))
                return self.host.preview(args['names'], args['enabled'])
            if op == 'discard':
                fields(args, ('id',))
                if not isinstance(args['id'], str):
                    raise ValueError('Preview identifier required.')
                return {'discarded': self.host.discard(args['id'])}
            if op == 'approve':
                fields(args, ('id', 'sha'))
                if not isinstance(args['id'], str) or not isinstance(args['sha'], str) or not re.fullmatch('[a-f0-9]{64}', args['sha']):
                    raise ValueError('Retained preview identifier and hash required.')
                return self.host.approve(args['id'], args['sha'])
            if op == 'policy_pause':
                fields(args, ('expected_policy_sha256',))
                if not isinstance(args['expected_policy_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', args['expected_policy_sha256']):
                    raise ValueError('Expected policy hash required.')
                return self.host.pause(args['expected_policy_sha256'])
            raise ValueError('Operation not allowed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    if not sys.flags.isolated:
        raise ValueError('Isolated Python required.')
    bridge = Bridge(Path(args.config))
    seq = 0
    while True:
        raw = sys.stdin.buffer.readline(65537)
        if not raw:
            return 0
        if len(raw) > 65536 or not raw.endswith(b'\n'):
            raise ValueError('Invalid input frame.')
        request = decode(raw)
        fields(request, ('format', 'version', 'seq', 'op', 'args'))
        if request['format'] != 'raya.memory.control.request' or type(request['version']) is not int or request['version'] != 1 or type(request['seq']) is not int or request['seq'] != seq + 1 or request['seq'] > 2147483647 or not isinstance(request['op'], str) or not isinstance(request['args'], dict):
            raise ValueError('Invalid request identity.')
        seq = request['seq']
        reply = {'format': 'raya.memory.control.reply', 'version': 1, 'seq': seq}
        try:
            result = bridge.call(request['op'], request['args'])
            reply.update(ok=True, result=result)
        except Exception as err:
            types = [type(item).__name__ for item in sys.modules['admission'].failures(err)]
            reply.update(ok=False, error={'kind': 'control_refused', 'message': 'Control operation refused; inspect current identity and review.',
                                         'types': types, 'publication': 'may_have_happened' if request['op'] in ('approve', 'policy_pause') else 'none'})
        output = json.dumps(reply, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8') + b'\n'
        if len(output) > 2097152:
            raise ValueError('Oversized reply; inspect original operation.')
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as err:
        # Never emit raw exception text, source content, request frames or paths.
        sys.stderr.write('control_fatal:' + type(err).__name__ + '\n')
        raise SystemExit(65)
