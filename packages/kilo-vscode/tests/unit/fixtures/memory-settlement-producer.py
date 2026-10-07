"""Actual protected Journal and Python codec; synthetic downstream observations."""
import base64
import importlib.util
import json
from pathlib import Path
import sys

assert len(sys.argv) == 2
root = Path(sys.argv[1]).resolve(strict=True)
sys.path.insert(0, str(root))
spec = importlib.util.spec_from_file_location('namespace_fixture', root/'namespace_publication_test.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
sys.modules['namespace'] = fixture.MODULE
sys.path.insert(0, str(root/'service'))
from operations import Journal
from retirement import certificate, fingerprint


def encoded(value):
    return base64.b64encode(json.dumps(value, ensure_ascii=False, allow_nan=False,
                                      separators=(',', ':')).encode()).decode()


case = fixture.Tests()
case.setUp()
try:
    case.folder.rmdir()
    generations = {name: fixture.MODULE.generation(case.root if name == 'root' else case.root/name)
                   for name in ('root', 'Runs', 'Requests')}
    journal = Journal(str(case.root), case.sid, generations, 'a'*32, 'b'*64,
                      'raya.retrieval.request.settlement.v2')
    rows = []
    for count, outcome in enumerate(('completed', 'failed', 'cancelled'), 1):
        result = {'capture_enabled': False, 'results': [{
            'path': 'C:/Synthetic/café 日本語.md', 'relative': 'café 日本語.md', 'line': 1,
            'end_line': 2, 'heading': 'Synthetic 😀', 'text': 'Synthetic café 日本語 😀\x7f',
            'source_sha256': 'f'*64, 'embedding_similarity': 1.0, 'relevance_score': 1e-7}]}
        proof = {'format': 'raya.retrieval.request.settlement', 'version': 2, 'phase': 'settled',
                 'request': format(100+count, '032x'), 'owner_epoch': 'c'*32,
                 'selected_release_sha256': 'd'*64, 'request_sha256': fingerprint({'input': ['Synthetic']}),
                 'inference_outcome': outcome}
        if outcome == 'completed':
            proof.update(lease='e'*32, sequence=32, original_process_running=True,
                         original_job_membership_observed=True, selected_images_unchanged=True,
                         worker={'birth_filetime': '18446744073709551615', 'image': 'C:/Synthetic/😀.exe'},
                         result_sha256=fingerprint({'values': [1.0, 1e-7, -0.0]}))
        if outcome == 'failed':
            proof.update(worker_created=True, lease='e'*32, cleanup_outcome='joined', joins_observed=True,
                         root_exit=0xffffffff, job_active=0, input_closed=True, control_closed=True,
                         output_eof=True, error_eof=True, readers_joined=True,
                         original_handles_closed=True, writer_joined=True)
        if outcome == 'cancelled':
            proof.update(worker_created=False, cleanup_outcome='not_started', joins_observed=False)
        proof['receipt_sha256'] = fingerprint(proof)
        certificate(proof, proof['request'], proof['owner_epoch'], proof['selected_release_sha256'],
                    proof['request_sha256'], journal.protocol)
        request = format(count, '032x')
        body = {'query': 'Synthetic café 日本語 😀', 'top': 5}
        pending = journal.reserve(request, 'search', body)
        terminal = journal.complete(pending, result if outcome == 'completed' else None, outcome, [proof])
        selected = {'request': request, 'epoch': journal.epoch, 'release': journal.release,
                    'kind': 'search', 'digest': fingerprint(body), 'protocol': journal.format,
                    'downstream': [{'request': proof['request'], 'epoch': proof['owner_epoch'],
                                    'release': proof['selected_release_sha256'], 'digest': proof['request_sha256']}]}
        rows.append({'selected': selected, 'pending': encoded(pending), 'terminal': encoded(terminal),
                     'response': encoded(dict(result, operation=terminal)) if outcome == 'completed' else None})
    print(json.dumps({'cases': rows, 'qualification': 'Actual protected publication; synthetic downstream metadata'}))
finally:
    case.doCleanups()
