"""Pinned real Journal/certificate codec fixture. No models, HTTP or native calls.

The file sink substitutes only protected namespace publication; it is not an
ownership/ACL test. Actual Journal reserve/complete and retirement validators
produce every frame and fingerprint below without copying their algorithms.
"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

assert len(sys.argv) == 2
root = Path(sys.argv[1]).resolve(strict=True)
review = root / 'source-review.json'
assert hashlib.sha256(review.read_bytes()).hexdigest() == 'f99cc7a0819bb7c2216c727e03620ca56ac3b1e8fc94ef0207ad3e7ccda7d037'
sources = json.loads(review.read_bytes())['sources']
for row in sources:
    data = root.joinpath(row['name']).read_bytes()
    assert len(data) == row['bytes'] and hashlib.sha256(data).hexdigest() == row['sha256']
for name in ('namespace', 'retirement', 'operations'):
    spec = importlib.util.spec_from_file_location(name, root / (name+'.py'))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
from operations import Journal
from retirement import certificate, fingerprint


class Files:
    def publish(self, folder, name, data):
        assert len(data) <= 65536
        with folder.joinpath(name).open('xb') as stream:
            stream.write(data)


def proof(request, created=True, outcome='completed'):
    value = {'format': 'raya.retrieval.retirement', 'version': 1, 'request': request,
             'owner_epoch': 'b'*32, 'selected_release_sha256': 'c'*64,
             'request_sha256': fingerprint({'input': ['Synthetic café 日本語 😀']}),
             'phase': 'retired', 'worker_created': created,
             'cleanup_outcome': 'joined' if created else 'not_started',
             'joins_observed': created, 'queued_never_created': not created,
             'inference_outcome': outcome}
    if created:
        value.update(root_exit=0 if outcome == 'completed' else 7, job_active=0,
                     input_closed=True, control_closed=True, output_eof=True,
                     error_eof=True, readers_joined=True, original_handles_closed=True,
                     writer_joined=True)
    if outcome == 'completed':
        value['result_sha256'] = fingerprint({'result': [1.0, 1e-7, -0.0]})
    value['receipt_sha256'] = fingerprint(value)
    return certificate(value, request, value['owner_epoch'], value['selected_release_sha256'], value['request_sha256'])


def encoded(value):
    # Same JSONResponse numeric/string rendering; fingerprint uses ASCII escapes.
    return base64.b64encode(json.dumps(value, ensure_ascii=False, allow_nan=False,
                                      separators=(',', ':')).encode()).decode()


cases = []
with tempfile.TemporaryDirectory(prefix='raya-memory-operation-codec-') as temp:
    journal = Journal.__new__(Journal)
    journal.namespace = Files()
    journal.folder = Path(temp)
    journal.epoch = 'a'*32
    journal.release = 'd'*64
    for index, (kind, outcome, rebuilt) in enumerate([
            ('search', 'completed', False), ('sync', 'completed', False),
            ('sync', 'completed', True), ('sync', 'failed', False), ('search', 'cancelled', False)]):
        request = format(index+1, '032x')
        body = {'query': 'Synthetic café 日本語 😀', 'top': 5} if kind == 'search' else {
            'force_rebuild': rebuilt, 'expected_policy_sha256': 'e'*64}
        pending = journal.reserve(request, kind, body)
        result = {'files': 1, 'chunks': 2, 'new_embeddings': 1, 'reused_embeddings': 1}
        if rebuilt:
            result['rebuilt'] = True
        if kind == 'search':
            result = {'capture_enabled': False, 'results': [{
                'path': 'C:/Synthetic/café 日本語.md', 'relative': 'café 日本語.md', 'line': 1,
                'end_line': 2, 'heading': 'Synthetic 😀', 'text': 'Synthetic café 日本語 😀\x7f',
                'source_sha256': 'f'*64, 'embedding_similarity': 1.0, 'relevance_score': 1e-7}]}
        proofs = [proof(format(100+index, '032x'), outcome=outcome),
                  proof(format(200+index, '032x'), created=False, outcome='cancelled')]
        terminal = journal.complete(pending, result if outcome == 'completed' else None, outcome, proofs)
        selected = {'request': request, 'epoch': journal.epoch, 'release': journal.release,
                    'kind': kind, 'digest': fingerprint(body)}
        expected = [{'request': value['request'], 'epoch': value['owner_epoch'],
                     'release': value['selected_release_sha256'], 'digest': value['request_sha256']} for value in proofs]
        cases.append({'name': kind+'-'+outcome+('-rebuilt' if rebuilt else ''),
                      'selected': selected, 'downstream': expected, 'pending': encoded(pending),
                      'terminal': encoded(terminal), 'response': encoded(dict(result, operation=terminal))
                      if outcome == 'completed' else None})
print(json.dumps({'format': 'raya.memory.operation.producer-fixture', 'cases': cases,
                  'sourceReviewSHA': hashlib.sha256(review.read_bytes()).hexdigest(),
                  'qualification': 'Actual pure Journal/certificate codecs; inert file sink, no namespace/native/model proof'}))
