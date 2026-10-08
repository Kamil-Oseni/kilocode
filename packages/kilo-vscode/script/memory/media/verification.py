"""Source-bound evidence decisions, separate from nearest-neighbour ranking.

The trusted caller supplies a supervised verifier that inspects the supplied
bytes (or a transcript/frame derived from those bytes and the selected span).
Similarity and filenames alone must never produce a supported decision.
"""
import hashlib
import math
from library import inspect, read


def review(library, query, candidates, verifier):
    if not isinstance(query, str) or not query.strip() or len(query.encode('utf-8')) > 2048:
        raise ValueError('Supply a bounded nonempty media query.')
    if not isinstance(candidates, list) or len(candidates) > 10 or not callable(verifier):
        raise ValueError('Supply at most ten candidates and a supervised evidence verifier.')
    digest = hashlib.sha256(query.encode('utf-8')).hexdigest()
    result = dict(format='raya.media.recall.v1', query_sha256=digest, matches=[], rejected=[], uncertain=[])
    seen = set()
    for row in candidates:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str):
            raise ValueError('Malformed media candidate.')
        item = library.item(row['id'])
        path = library.root / item['relative']
        if row.get('sha256') != item['sha256'] or row.get('kind') != item['kind'] or row.get('path') != str(path):
            raise ValueError('Candidate source binding differs.')
        score = row.get('similarity')
        if type(score) not in (int, float) or not math.isfinite(score) or not -1.001 <= score <= 1.001:
            raise ValueError('Candidate similarity is invalid.')
        start, end = row.get('start'), row.get('end')
        if item['kind'] == 'image':
            if start is not None or end is not None:
                raise ValueError('Images cannot claim a recording timestamp.')
        elif dict(start=start, end=end) not in inspect(path)['segments']:
            raise ValueError('Verification requires the exact decoded recording span.')
        identity = (item['id'], start, end)
        if identity in seen:
            raise ValueError('Duplicate media candidate.')
        seen.add(identity)
        raw = read(path)
        if hashlib.sha256(raw).hexdigest() != item['sha256']:
            raise ValueError('Verification source changed.')
        request = dict(format='raya.media.verify.v1', query=query, query_sha256=digest,
                       id=item['id'], source_sha256=item['sha256'], kind=item['kind'], start=start, end=end)
        try:
            verdict = verifier(dict(request), raw)
        except (OSError, TimeoutError):
            verdict = dict(request, status='uncertain', evidence='Verifier unavailable.', model='unavailable')
            verdict.pop('query')
            verdict.pop('kind')
        expected = {key: request[key] for key in ('format', 'query_sha256', 'id', 'source_sha256', 'start', 'end')}
        if not isinstance(verdict, dict) or set(verdict) != set(expected) | {'status', 'evidence', 'model'}:
            raise ValueError('Malformed evidence decision.')
        if any(verdict[key] != value for key, value in expected.items()):
            raise ValueError('Evidence decision belongs to a different query, source or span.')
        if verdict['status'] not in ('supported', 'rejected', 'uncertain'):
            raise ValueError('Unknown evidence decision.')
        if not isinstance(verdict['model'], str) or not 0 < len(verdict['model']) <= 256:
            raise ValueError('Evidence model identity is required.')
        if not isinstance(verdict['evidence'], str) or len(verdict['evidence'].encode('utf-8')) > 4096:
            raise ValueError('Evidence explanation exceeds its bound.')
        if verdict['status'] == 'supported' and not verdict['evidence'].strip():
            raise ValueError('Supported evidence requires an observation or transcript excerpt.')
        library.item(item['id'])
        if hashlib.sha256(read(path)).hexdigest() != item['sha256']:
            raise ValueError('Verification source changed during review.')
        entry = dict(row, verification=verdict['status'], evidence=verdict['evidence'], verifier=verdict['model'], query_sha256=digest)
        name = {'supported': 'matches', 'rejected': 'rejected', 'uncertain': 'uncertain'}[verdict['status']]
        result[name].append(entry)
    return result
