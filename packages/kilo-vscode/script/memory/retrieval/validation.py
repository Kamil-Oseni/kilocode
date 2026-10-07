"""Strict request/result validation; no imports of models or service runtime."""
import hashlib
import json
import math


def fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_json_field')
        result[key] = value
    return result


def decimal(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('nonfinite_json_decimal')
    return result


def decode(raw, bound):
    if not isinstance(raw, bytes) or len(raw) > bound:
        raise ValueError('json_bound')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=fields, parse_float=decimal,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite_json')))


def canonical(value, bound):
    raw = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > bound:
        raise ValueError('canonical_bound')
    return raw


def fingerprint(value, bound=300000):
    return hashlib.sha256(canonical(value, bound)).hexdigest()


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def result(value, kind, body, revision):
    if not isinstance(value, dict):
        raise ValueError('model_result_object')
    timing = value.get('timing')
    if not isinstance(timing, dict) or set(timing) != {'seconds'} or not number(timing['seconds']) or timing['seconds'] < 0:
        raise ValueError('model_result_timing')
    if value.get('revision') != revision:
        raise ValueError('model_result_revision')
    if kind == 'embeddings':
        model = body.get('model', 'qwen3-embedding-0.6b')
        dimensions = {'qwen3-embedding-0.6b': 1024, 'embeddinggemma-2': 768}.get(model)
        if dimensions is None or set(value) != {'object', 'model', 'revision', 'dimensions', 'normalized', 'data', 'timing'} or value['object'] != 'list' or value['model'] != model or type(value['dimensions']) is not int or value['dimensions'] != dimensions or value['normalized'] is not True:
            raise ValueError('embedding_result_identity')
        rows = value['data']
        if not isinstance(rows, list) or len(rows) != len(body['input']):
            raise ValueError('embedding_result_cardinality')
        for index, row in enumerate(rows):
            if not isinstance(row, dict) or set(row) != {'object', 'index', 'embedding'} or row['object'] != 'embedding' or type(row['index']) is not int or row['index'] != index:
                raise ValueError('embedding_result_index')
            vector = row['embedding']
            if not isinstance(vector, list) or len(vector) != dimensions or not all(number(item) for item in vector):
                raise ValueError('embedding_result_finite_dimensions')
            if abs(math.sqrt(math.fsum(item*item for item in vector))-1) > 0.001:
                raise ValueError('embedding_result_normalization')
    else:
        if set(value) != {'model', 'revision', 'results', 'timing'} or value['model'] != 'qwen3-reranker-0.6b':
            raise ValueError('rerank_result_identity')
        rows = value['results']
        if not isinstance(rows, list) or len(rows) != body.get('top_n', len(body['documents'])):
            raise ValueError('rerank_result_cardinality')
        indices = set()
        prior = 1.0
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'index', 'relevance_score'} or type(row['index']) is not int or not 0 <= row['index'] < len(body['documents']) or row['index'] in indices:
                raise ValueError('rerank_result_index')
            score = row['relevance_score']
            if not number(score) or not 0 <= score <= prior:
                raise ValueError('rerank_result_score')
            indices.add(row['index'])
            prior = score
    canonical(value, 2097152)
    return value
