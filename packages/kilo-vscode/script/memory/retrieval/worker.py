"""One inference process; all model allocations retire when it exits."""
import json
import sys
import time

def infer(kind, body):
    start = time.perf_counter()
    from models import Embeddings, Reranker
    model = Embeddings() if kind == 'embeddings' else Reranker()
    if kind == 'embeddings':
        vectors = model.encode(body['input'], query=body.get('input_type', 'document') == 'query')
        return {'object': 'list', 'model': 'qwen3-embedding-0.6b', 'revision': model.manifest['revision'], 'dimensions': vectors.shape[1], 'normalized': True, 'data': [{'object': 'embedding', 'index': index, 'embedding': vector} for index, vector in enumerate(vectors.tolist())], 'timing': {'seconds': round(time.perf_counter() - start, 3)}}
    ranking = model.rank(body['query'], body['documents'])
    return {'model': 'qwen3-reranker-0.6b', 'revision': model.manifest['revision'], 'results': [{'index': item['index'], 'relevance_score': item['score']} for item in ranking[:body.get('top_n', len(ranking))]], 'timing': {'seconds': round(time.perf_counter() - start, 3)}}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    try:
        result = infer(request['kind'], request['body'])
        print(json.dumps({'result': result}), flush=True)
    except ValueError as err:
        print(json.dumps({'error': str(err), 'type': 'validation'}), flush=True)
    except Exception as err:
        print(json.dumps({'error': 'Local inference failed.', 'type': type(err).__name__}), flush=True)
