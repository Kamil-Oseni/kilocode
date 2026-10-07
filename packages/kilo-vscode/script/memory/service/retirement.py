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


def settlement(value, request, epoch, release, digest):
    selected = {'request': request, 'owner_epoch': epoch, 'selected_release_sha256': release, 'request_sha256': digest}
    if not all(hex(item, size) for item, size in ((request, 32), (epoch, 32), (release, 64), (digest, 64))):
        raise ValueError('Selected settlement identity differs.')
    common = set(selected) | {'format', 'version', 'phase', 'inference_outcome', 'receipt_sha256'}
    live = {'lease', 'sequence', 'original_process_running', 'original_job_membership_observed',
            'selected_images_unchanged', 'worker', 'result_sha256'}
    joined = {'lease', 'root_exit', 'job_active', 'input_closed', 'control_closed', 'output_eof',
              'error_eof', 'readers_joined', 'original_handles_closed', 'writer_joined'}
    if (not isinstance(value, dict) or any(value.get(key) != item for key, item in selected.items()) or
            value.get('format') != 'raya.retrieval.request.settlement' or type(value.get('version')) is not int or
            value['version'] != 2 or value.get('phase') != 'settled' or
            value.get('inference_outcome') not in ('completed', 'failed', 'cancelled')):
        raise ValueError('Selected settlement protocol differs.')
    if value['inference_outcome'] == 'completed':
        if (set(value) != common | live or not hex(value['lease'], 32) or
                type(value['sequence']) is not int or not 1 <= value['sequence'] <= 32 or
                any(value[name] is not True for name in ('original_process_running', 'original_job_membership_observed', 'selected_images_unchanged')) or
                not hex(value['result_sha256'], 64)):
            raise ValueError('Live settlement evidence differs.')
        worker = value['worker']
        if (not isinstance(worker, dict) or set(worker) != {'birth_filetime', 'image'} or
                not isinstance(worker['birth_filetime'], str) or not re.fullmatch('[1-9][0-9]{0,19}', worker['birth_filetime']) or
                int(worker['birth_filetime']) > 0xffffffffffffffff or not isinstance(worker['image'], str) or
                not 1 <= len(worker['image']) <= 32767 or '\x00' in worker['image']):
            raise ValueError('Original settlement worker identity differs.')
    else:
        if type(value.get('worker_created')) is not bool:
            raise ValueError('Settlement failure evidence requires booleans.')
        fields = common | {'worker_created', 'cleanup_outcome', 'joins_observed'}
        if value['worker_created']:
            if (set(value) != fields | joined or value['cleanup_outcome'] != 'joined' or value['joins_observed'] is not True or
                    not hex(value['lease'], 32) or type(value['root_exit']) is not int or not 0 <= value['root_exit'] <= 0xffffffff or
                    type(value['job_active']) is not int or value['job_active'] != 0 or
                    any(value[name] is not True for name in joined - {'lease', 'root_exit', 'job_active'})):
                raise ValueError('Original settlement retirement is unconfirmed.')
        elif set(value) != fields or value['cleanup_outcome'] != 'not_started' or value['joins_observed'] is not False:
            raise ValueError('Never-started settlement differs.')
    if (not hex(value['receipt_sha256'], 64) or len(canonical(value)) > 65536 or
            fingerprint({key: item for key, item in value.items() if key != 'receipt_sha256'}) != value['receipt_sha256']):
        raise ValueError('Settlement fingerprint differs.')
    return json.loads(canonical(value))


def certificate(value, request, epoch, release, digest, protocol='raya.retrieval.retirement.v1'):
    if protocol == 'raya.retrieval.request.settlement.v2':
        return settlement(value, request, epoch, release, digest)
    if protocol != 'raya.retrieval.retirement.v1':
        raise ValueError('Explicit downstream protocol selection differs.')
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
    if not isinstance(value, dict) or value.get('format') not in ('raya-retrieval-retirement-v2', 'raya-retrieval-settlement-v3'):
        raise ValueError('Legacy or missing ownership provenance cannot be reconciled.')
    reusable = value['format'] == 'raya-retrieval-settlement-v3'
    terminal = 'settled' if reusable else 'retired'
    status = value.get('status')
    if status not in ('pending', terminal) or set(value) != (pending | {'certificate'} if status == terminal else pending):
        raise ValueError('Ownership ledger shape differs.')
    if not hex(value['request'], 32) or not hex(value['owner_epoch'], 32) or not hex(value['selected_release_sha256'], 64) or not hex(value['parent_request'], 32) or not hex(value['request_sha256'], 64):
        raise ValueError('Ownership ledger identity differs.')
    if type(value['port']) is not int or not 1024 <= value['port'] <= 65535:
        raise ValueError('Ownership ledger port differs.')
    if status == terminal:
        certificate(value['certificate'], value['request'], value['owner_epoch'], value['selected_release_sha256'], value['request_sha256'],
                    'raya.retrieval.request.settlement.v2' if reusable else 'raya.retrieval.retirement.v1')
    return value
