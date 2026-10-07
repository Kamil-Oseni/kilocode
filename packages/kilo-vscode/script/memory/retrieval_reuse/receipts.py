"""V2 request settlement metadata; live completion never claims lease retirement."""
import re
from validation import canonical, decode, fingerprint

IDENTITY = {'request', 'owner_epoch', 'selected_release_sha256', 'request_sha256'}
LIVE = {'lease', 'sequence', 'original_process_running', 'original_job_membership_observed',
        'selected_images_unchanged', 'worker'}
JOINED = {'root_exit', 'job_active', 'input_closed', 'control_closed', 'output_eof',
          'error_eof', 'readers_joined', 'original_handles_closed', 'writer_joined'}


def identity(row):
    if (not isinstance(row, dict) or set(row) != IDENTITY or
            any(not isinstance(row[key], str) or not re.fullmatch('[a-f0-9]{' + str(size) + '}', row[key])
                for key, size in (('request', 32), ('owner_epoch', 32),
                                  ('selected_release_sha256', 64), ('request_sha256', 64)))):
        raise ValueError('settlement_identity')
    return dict(row)


def seal(row):
    value = decode(canonical(row, 65536), 65536)
    value['receipt_sha256'] = fingerprint(value, 65536)
    return value


def parse(value, selected, output=None):
    selected = identity(selected)
    row = decode(canonical(value, 65536), 65536)
    common = IDENTITY | {'format', 'version', 'phase', 'inference_outcome', 'receipt_sha256'}
    if (not isinstance(row, dict) or any(row.get(key) != value for key, value in selected.items()) or
            type(row.get('version')) is not int or row['version'] != 2 or
            row.get('format') != 'raya.retrieval.request.settlement' or
            row.get('phase') != 'settled' or row.get('inference_outcome') not in ('completed', 'failed', 'cancelled')):
        raise ValueError('settlement_selection')
    completed = row['inference_outcome'] == 'completed'
    if completed:
        if (set(row) != common | LIVE | {'result_sha256'} or
                type(row['sequence']) is not int or not 1 <= row['sequence'] <= 32 or
                not isinstance(row['lease'], str) or not re.fullmatch('[a-f0-9]{32}', row['lease']) or
                any(row[key] is not True for key in LIVE - {'lease', 'sequence', 'worker'}) or
                not isinstance(row['result_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', row['result_sha256'])):
            raise ValueError('settlement_live_evidence')
        worker = row['worker']
        if (not isinstance(worker, dict) or set(worker) != {'birth_filetime', 'image'} or
                not isinstance(worker['birth_filetime'], str) or
                not re.fullmatch('[1-9][0-9]{0,19}', worker['birth_filetime']) or
                int(worker['birth_filetime']) > 0xffffffffffffffff or
                not isinstance(worker['image'], str) or not 1 <= len(worker['image']) <= 32767 or
                '\x00' in worker['image']):
            raise ValueError('settlement_worker_identity')
        if output is not None and fingerprint(output, 2097152) != row['result_sha256']:
            raise ValueError('settlement_result_changed')
    else:
        if output is not None:
            raise ValueError('settlement_failure_has_result')
        if type(row.get('worker_created')) is not bool:
            raise ValueError('settlement_failure_evidence')
        fields = common | {'worker_created', 'cleanup_outcome', 'joins_observed'}
        if row['worker_created']:
            if (set(row) != fields | JOINED | {'lease'} or
                    row['cleanup_outcome'] != 'joined' or row['joins_observed'] is not True or
                    not isinstance(row['lease'], str) or not re.fullmatch('[a-f0-9]{32}', row['lease']) or
                    type(row['root_exit']) is not int or not 0 <= row['root_exit'] <= 0xffffffff or
                    type(row['job_active']) is not int or row['job_active'] != 0 or
                    any(row[key] is not True for key in JOINED - {'root_exit', 'job_active'})):
                raise ValueError('settlement_original_retirement_unconfirmed')
        elif (set(row) != fields or row['cleanup_outcome'] != 'not_started' or row['joins_observed'] is not False):
            raise ValueError('settlement_never_started')
    digest = row.pop('receipt_sha256')
    if not isinstance(digest, str) or digest != fingerprint(row, 65536):
        raise ValueError('settlement_fingerprint')
    row['receipt_sha256'] = digest
    return row


def completion(selected, output, observation):
    selected = identity(selected)
    if (not isinstance(observation, dict) or set(observation) != IDENTITY | LIVE | {'format', 'version'} or
            observation.get('format') != 'raya.retrieval.lease.observation' or
            any(observation.get(key) != value for key, value in selected.items()) or
            type(observation.get('version')) is not int or observation['version'] != 2):
        raise ValueError('settlement_original_observation')
    row = {**selected, **{key: observation[key] for key in LIVE},
           'format': 'raya.retrieval.request.settlement', 'version': 2, 'phase': 'settled',
           'inference_outcome': 'completed', 'result_sha256': fingerprint(output, 2097152)}
    return parse(seal(row), selected, output)


def failure(selected, outcome, owner=None):
    selected = identity(selected)
    if outcome not in ('failed', 'cancelled'):
        raise ValueError('settlement_failure_outcome')
    row = {**selected, 'format': 'raya.retrieval.request.settlement', 'version': 2,
           'phase': 'settled', 'inference_outcome': outcome, 'worker_created': owner is not None and owner.created,
           'cleanup_outcome': 'not_started', 'joins_observed': False}
    if owner is not None:
        state = owner.state
        if owner.epoch != selected['owner_epoch'] or owner.release != selected['selected_release_sha256']:
            raise ValueError('settlement_original_owner_selection')
        current = owner.lease.current
        if current is not None and any(current.get(key) != value for key, value in selected.items()):
            raise ValueError('settlement_original_request_selection')
        joined = state.get('cleanup_outcome') == 'joined' and state.get('joins_observed') is True
        never = (not owner.created and state.get('never_allocated_observed') is True and
                 state.get('cleanup_outcome') == 'not_started' and state.get('joins_observed') is False)
        if (owner.handles or state.get('ownership_retained') or state.get('phase') != 'terminal' or not (joined or never)):
            raise ValueError('settlement_original_retirement_unconfirmed')
        if owner.created:
            row.update(lease=owner.request, cleanup_outcome='joined', joins_observed=True,
                       root_exit=state['root_exit'], job_active=state['job_active'],
                       input_closed=True, control_closed=True,
                       output_eof=state['outputs']['output']['eof'], error_eof=state['outputs']['error']['eof'],
                       readers_joined=True, original_handles_closed=True, writer_joined=state['writer_joined'])
    return parse(seal(row), selected)
