"""Read-only historical provenance foundation, never cold admission or debt clearing.

Selection must come from the original Journal or an independently selected native
Namespace. Serialized provenance is inert; it cannot select paths or mint authority.
The host still needs original-owner retirement and cross-host exclusion before CAS.
"""
import hashlib
import os
import re
import stat
from pathlib import Path
from namespace import Namespace, acl, generation
from operations import Journal
from retirement import canonical, certificate, decode, fingerprint, hex

KEYS = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink')
ISSUER = object()
SOURCES = ('server.py', 'index.py', 'notes.py', 'policy.py', 'admission.py',
           'host.py', 'operations.py', 'retirement.py', 'namespace.py', 'historical.py', 'dispatch.py')
FIELDS = {'format', 'request', 'owner_epoch', 'selected_release_sha256', 'kind', 'request_sha256', 'status'}


def request(value):
    if not isinstance(value, dict) or set(value) != FIELDS or value['format'] != 'raya.memory.operation.v1' or value['status'] != 'pending' or value['kind'] not in ('sync', 'search') or not hex(value['request'], 32) or not hex(value['owner_epoch'], 32) or not hex(value['request_sha256'], 64) or not hex(value['selected_release_sha256'], 64):
        raise ValueError('Historical original request differs.')


def sources(value):
    if not isinstance(value, dict) or set(value) != set(SOURCES):
        raise ValueError('Exact reviewed source set required.')
    for name, digest in value.items():
        path = Path(__file__).resolve().parent / name
        before = path.lstat()
        if not hex(digest, 64) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 1048576 or getattr(before, 'st_file_attributes', 0) & 0x400:
            raise ValueError('Reviewed source image differs.')
        raw = path.read_bytes()
        after = path.lstat()
        if tuple(getattr(before, key) for key in KEYS) != tuple(getattr(after, key) for key in KEYS) or hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError('Original selected source changed.')


def decimal(value):
    if not isinstance(value, str) or not re.fullmatch(r'0|[1-9]\d{0,19}', value) or int(value) > 18446744073709551615:
        raise ValueError('Historical generation decimal differs.')
    return int(value)


def image(namespace, path):
    namespace.check()
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 65536 or getattr(before, 'st_file_attributes', 0) & 0x400:
        raise ValueError('Historical image identity differs.')
    with path.open('rb') as file:
        opened = os.fstat(file.fileno())
        raw = file.read(65537)
        final = os.fstat(file.fileno())
    after = path.lstat()
    # Windows path and descriptor ctime are independently stable channels.
    common = tuple(key for key in KEYS if key != 'st_ctime_ns')
    if len(raw) != before.st_size or len(raw) > 65536 or any(tuple(getattr(row, key) for key in common) != tuple(getattr(before, key) for key in common) for row in (opened, final, after)) or before.st_ctime_ns != after.st_ctime_ns or opened.st_ctime_ns != final.st_ctime_ns:
        raise ValueError('Historical image changed during read.')
    acl(path, namespace.principal)
    namespace.check()
    return raw, {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                 'identity': [str(getattr(after, key)) for key in KEYS]}


class Selection:
    def __init__(self, issuer, namespace, value):
        if issuer is not ISSUER or not isinstance(namespace, Namespace):
            raise ValueError('Original selected namespace required.')
        self.namespace = namespace
        self.value = decode(canonical(value))

    def record(self):
        return decode(canonical(self.value))


def capture(journal, pending, source):
    # Validate every caller field before constructing any receipt path.
    request(pending)
    sources(source)
    if not isinstance(journal, Journal) or pending.get('owner_epoch') != journal.epoch or pending.get('selected_release_sha256') != journal.release or fingerprint(source) != journal.release:
        raise ValueError('Original Journal selection differs.')
    namespace = journal.namespace
    with namespace.lock:
        namespace.check()
        if journal.folder != namespace.root / 'Requests' / journal.epoch or journal.folder not in namespace.generations:
            raise ValueError('Original selected epoch folder differs.')
        raw, row = image(namespace, journal.folder / (pending['request'] + '-pending.json'))
        if decode(raw) != pending:
            raise ValueError('Original pending publication differs.')
        value = {'format': 'raya.memory.historical.provenance.v1',
                 'generations': {name: [str(item) for item in namespace.generations[namespace.root if name == 'root' else namespace.root / name]] for name in ('root', 'Runs', 'Requests')},
                 'epoch_generation': [str(item) for item in generation(journal.folder)],
                 'pending': pending, 'pending_image': row, 'source_sha256': source}
        return Selection(ISSUER, namespace, value)


def restore(namespace, record):
    """Native host must select namespace independently; record cannot select a path."""
    if not isinstance(namespace, Namespace) or not isinstance(record, dict) or set(record) != {'format', 'generations', 'epoch_generation', 'pending', 'pending_image', 'source_sha256'} or record['format'] != 'raya.memory.historical.provenance.v1':
        raise ValueError('Historical provenance shape differs.')
    sources(record['source_sha256'])
    if not isinstance(record['generations'], dict) or set(record['generations']) != {'root', 'Runs', 'Requests'}:
        raise ValueError('Historical namespace generations differ.')
    for name, values in record['generations'].items():
        if not isinstance(values, list) or len(values) != 3:
            raise ValueError('Historical namespace tuple differs.')
        path = namespace.root if name == 'root' else namespace.root / name
        if [decimal(item) for item in values] != namespace.generations[path]:
            raise ValueError('Original native-selected namespace differs.')
    if not isinstance(record['epoch_generation'], list) or len(record['epoch_generation']) != 3:
        raise ValueError('Historical epoch tuple differs.')
    for item in record['epoch_generation']:
        decimal(item)
    return Selection(ISSUER, namespace, record)


def inspect(selected):
    if not isinstance(selected, Selection):
        raise ValueError('Selected historical provenance required.')
    namespace = selected.namespace
    value = selected.record()
    # Selection is only an inert provenance carrier; mutable fields never confer authority.
    value = restore(namespace, value).record()
    pending = value['pending']
    request(pending)
    fields = FIELDS
    if pending['selected_release_sha256'] != fingerprint(value['source_sha256']):
        raise ValueError('Historical original request differs.')
    with namespace.lock:
        namespace.check()
        folder = namespace.root / 'Requests' / pending['owner_epoch']
        if generation(folder) != [decimal(item) for item in value['epoch_generation']]:
            raise ValueError('Original epoch directory changed.')
        acl(folder, namespace.principal)
        raw, row = image(namespace, folder / (pending['request'] + '-pending.json'))
        if row != value['pending_image'] or decode(raw) != pending:
            raise ValueError('Original pending bytes or generation changed.')
        raw, terminal = image(namespace, folder / (pending['request'] + '-terminal.json'))
        operation = decode(raw)
        if not isinstance(operation, dict):
            raise ValueError('Original terminal object required.')
        keys = fields | {'operation_outcome', 'downstream', 'receipt_sha256', 'result_sha256'}
        if pending['kind'] == 'sync':
            keys |= {'counts'}
        if 'rebuilt' in operation:
            keys |= {'rebuilt'}
        if set(operation) != keys or operation['operation_outcome'] != 'completed' or operation['status'] != 'terminal' or any(operation[key] != pending[key] for key in fields - {'status'}) or not hex(operation['result_sha256'], 64):
            raise ValueError('Original completed terminal required.')
        if fingerprint({key: item for key, item in operation.items() if key != 'receipt_sha256'}) != operation['receipt_sha256']:
            raise ValueError('Original terminal fingerprint differs.')
        if 'counts' in operation:
            counts = operation['counts']
            if not isinstance(counts, dict) or set(counts) != {'files', 'chunks', 'new_embeddings', 'reused_embeddings'} or any(type(item) is not int or not 0 <= item <= 10000 for item in counts.values()) or counts['files'] > 128 or counts['new_embeddings'] + counts['reused_embeddings'] != counts['chunks']:
                raise ValueError('Original aggregate differs.')
        if 'rebuilt' in operation and (pending['kind'] != 'sync' or operation['rebuilt'] is not True):
            raise ValueError('Original rebuild marker differs.')
        if not isinstance(operation['downstream'], list) or len(operation['downstream']) > 256:
            raise ValueError('Historical downstream bound differs.')
        seen = set()
        for proof in operation['downstream']:
            if not isinstance(proof, dict) or not all(key in proof for key in ('request', 'owner_epoch', 'selected_release_sha256', 'request_sha256')):
                raise ValueError('Original downstream object required.')
            if proof['request'] in seen:
                raise ValueError('Duplicate original downstream proof.')
            seen.add(proof['request'])
            certificate(proof, proof['request'], proof['owner_epoch'], proof['selected_release_sha256'], proof['request_sha256'])
        if operation['downstream']:
            # Correlation against a certificate's own fields is insufficient. The
            # original native Runs ledger/parent selection is not yet available.
            raise ValueError('Independent original downstream ledger selection required.')
        namespace.check()
        if generation(folder) != [decimal(item) for item in value['epoch_generation']]:
            raise ValueError('Original epoch changed after inspection.')
        return {'pending_image': row, 'terminal_image': terminal, 'operation': operation,
                'sourceOnly': True, 'coldAdmission': False,
                'qualification': 'Zero-downstream original receipt foundation only; nonempty downstream remains refused until independent original native ledger selection. Host retirement, durable provenance authentication and cross-host CAS remain required.'}
