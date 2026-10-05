"""Strict metadata validators; no models, filesystem writes or credentials."""
import hashlib
import json
import math
import re


def fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate metadata field.')
        result[key] = value
    return result


def decimal(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Nonfinite JSON decimal.')
    return result


def decode(raw, bound=65536):
    if not isinstance(raw, bytes) or len(raw) > bound:
        raise ValueError('Retirement metadata exceeds its bound.')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=fields, parse_float=decimal,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite metadata.')))


def hex(value, count):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{'+str(count)+'}', value) is not None


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def fingerprint(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def certificate(value, request, epoch, release, digest):
    common = {'format', 'version', 'request', 'owner_epoch', 'selected_release_sha256',
              'phase', 'worker_created', 'cleanup_outcome', 'joins_observed',
              'queued_never_created', 'receipt_sha256', 'request_sha256', 'inference_outcome'}
    worker = {'root_exit', 'job_active', 'input_closed', 'control_closed',
              'output_eof', 'error_eof', 'readers_joined', 'original_handles_closed', 'writer_joined'}
    if not hex(request, 32) or not hex(epoch, 32) or not hex(release, 64):
        raise ValueError('Retained retirement identity is invalid.')
    if not isinstance(value, dict):
        raise ValueError('Retirement certificate fields differ.')
    inference = value.get('inference_outcome')
    if inference not in ('completed', 'failed', 'cancelled'):
        raise ValueError('Inference outcome differs.')
    if inference == 'completed':
        common = common | {'result_sha256'}
        if not hex(value.get('result_sha256'), 64):
            raise ValueError('Result fingerprint differs.')
    if set(value) not in (common, common | worker):
        raise ValueError('Retirement certificate fields differ.')
    if value['format'] != 'raya.retrieval.retirement' or type(value['version']) is not int or value['version'] != 1:
        raise ValueError('Retirement certificate protocol differs.')
    if value['request'] != request or value['owner_epoch'] != epoch or value['selected_release_sha256'] != release or value['phase'] != 'retired' or not hex(digest, 64) or value['request_sha256'] != digest:
        raise ValueError('Original request retirement identity differs.')
    for name in ('worker_created', 'joins_observed', 'queued_never_created'):
        if type(value[name]) is not bool:
            raise ValueError('Retirement evidence requires actual booleans.')
    if value['worker_created']:
        if set(value) != common | worker or value['cleanup_outcome'] != 'joined' or not value['joins_observed'] or value['queued_never_created']:
            raise ValueError('Original worker joins are unconfirmed.')
        if type(value['root_exit']) is not int or not 0 <= value['root_exit'] <= 0xffffffff or type(value['job_active']) is not int or value['job_active'] != 0:
            raise ValueError('Original root/job terminal evidence differs.')
        if any(value[name] is not True for name in worker - {'root_exit', 'job_active'}):
            raise ValueError('Original stream/reader/handle joins are unconfirmed.')
    elif set(value) != common or value['cleanup_outcome'] != 'not_started' or value['joins_observed'] or not value['queued_never_created']:
        raise ValueError('Queued never-created proof differs.')
    if not hex(value['receipt_sha256'], 64):
        raise ValueError('Terminal receipt fingerprint is invalid.')
    raw = json.dumps({key: item for key, item in value.items() if key != 'receipt_sha256'},
                     sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if hashlib.sha256(raw).hexdigest() != value['receipt_sha256']:
        raise ValueError('Terminal receipt fingerprint differs.')
    return json.loads(canonical(value))


def ledger(value):
    pending = {'format', 'request', 'port', 'status', 'owner_epoch',
               'selected_release_sha256', 'parent_request', 'request_sha256'}
    if not isinstance(value, dict) or value.get('format') != 'raya-retrieval-retirement-v2':
        raise ValueError('Legacy or missing ownership provenance cannot be reconciled.')
    status = value.get('status')
    if status not in ('pending', 'retired') or set(value) != (pending | {'certificate'} if status == 'retired' else pending):
        raise ValueError('Ownership ledger shape differs.')
    if not hex(value['request'], 32) or not hex(value['owner_epoch'], 32) or not hex(value['selected_release_sha256'], 64) or not hex(value['parent_request'], 32) or not hex(value['request_sha256'], 64):
        raise ValueError('Ownership ledger identity differs.')
    if type(value['port']) is not int or not 1024 <= value['port'] <= 65535:
        raise ValueError('Ownership ledger port differs.')
    if status == 'retired':
        certificate(value['certificate'], value['request'], value['owner_epoch'], value['selected_release_sha256'], value['request_sha256'])
    return value
