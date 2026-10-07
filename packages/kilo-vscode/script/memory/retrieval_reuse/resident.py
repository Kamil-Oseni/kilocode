"""One selected model per framed lease; callable only after bootstrap admission."""
import time
from lease import read, write
from validation import result


class Resident:
    def __init__(self, kind, name):
        if (kind, name) not in {('embeddings', 'embeddinggemma-2'),
                               ('embeddings', 'qwen3-embedding-0.6b'),
                               ('rerank', 'qwen3-reranker-0.6b')}:
            raise ValueError('resident_selection')
        self.kind = kind
        self.name = name
        self.model = None

    def infer(self, body):
        allowed = {'model', 'input', 'input_type'} if self.kind == 'embeddings' else {'model', 'query', 'documents', 'top_n'}
        if not isinstance(body, dict) or set(body) - allowed or body.get('model') != self.name:
            raise ValueError('resident_input_selection')
        values = body.get('input') if self.kind == 'embeddings' else body.get('documents')
        limit = 32 if self.kind == 'embeddings' else 16
        if (not isinstance(values, list) or not 1 <= len(values) <= limit or
                any(not isinstance(text, str) or not 0 < len(text.strip()) <= 8000 for text in values)):
            raise ValueError('resident_input_bound')
        if self.kind == 'embeddings' and body.get('input_type', 'document') not in ('document', 'query'):
            raise ValueError('resident_input_type')
        if self.kind == 'rerank':
            query = body.get('query')
            top = body.get('top_n', len(values))
            if (not isinstance(query, str) or not 0 < len(query.strip()) <= 2000 or
                    type(top) is not int or not 1 <= top <= len(values)):
                raise ValueError('resident_rerank_input')
        start = time.perf_counter()
        if self.model is None:
            # The selected bootstrap must inject authenticated MANIFESTS and dependency images.
            from models import Embeddings, Gemma, MANIFESTS, Reranker
            self.model = (Gemma(MANIFESTS[self.name]) if self.name == 'embeddinggemma-2' else
                          Embeddings() if self.kind == 'embeddings' else Reranker())
        if self.kind == 'embeddings':
            vectors = self.model.encode(values, query=body.get('input_type', 'document') == 'query')
            value = {'object': 'list', 'model': self.name, 'revision': self.model.manifest['revision'],
                     'dimensions': vectors.shape[1], 'normalized': True,
                     'data': [{'object': 'embedding', 'index': index, 'embedding': vector}
                              for index, vector in enumerate(vectors.tolist())],
                     'timing': {'seconds': round(time.perf_counter() - start, 3)}}
        else:
            ranking = self.model.rank(query, values)
            value = {'model': self.name, 'revision': self.model.manifest['revision'],
                     'results': [{'index': item['index'], 'relevance_score': item['score']}
                                 for item in ranking[:top]],
                     'timing': {'seconds': round(time.perf_counter() - start, 3)}}
        return result(value, self.kind, body, self.model.manifest['revision'])


def run(source, sink, lease, resident):
    if lease.kind != resident.kind or lease.model != resident.name or lease.sequence != 0:
        raise ValueError('resident_lease_selection')
    # No inference executor, extra queue, reader thread, or request-selected model switch.
    # Failure terminates the lease. Parent deadlines/idle expiry must close or retire its
    # original native owner; a successful return here is not evidence of process retirement.
    while lease.sequence < lease.limit:
        frame = read(source)
        if frame is None:
            return
        body = lease.request(frame)
        write(sink, lease.completion(resident.infer(body)))
    # Keep the final completion observable through the original live handle.
    # The parent retires the lease by closing input; an extra request is refused.
    if read(source) is not None:
        raise ValueError('resident_lease_capacity')
