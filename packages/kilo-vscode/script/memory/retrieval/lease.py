"""Bounded v2 worker frames. Completion frames never prove native retirement."""
import re
import struct
from validation import canonical, decode, fingerprint

INPUT = 300000
OUTPUT = 2097152


def take(stream, length, eof=False):
    chunks = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if chunk == b'' and eof and remaining == length:
            return None
        if not isinstance(chunk, bytes) or not 0 < len(chunk) <= remaining:
            raise ValueError('lease_frame_incomplete')
        chunks.append(chunk)
        remaining -= len(chunk)
    return b''.join(chunks)


def read(stream, maximum=INPUT):
    header = take(stream, 4, eof=True)
    if header is None:
        return None
    length = struct.unpack('!I', header)[0]
    if not 1 <= length <= maximum:
        raise ValueError('lease_frame_bound')
    return decode(take(stream, length), maximum)


def write(stream, value, maximum=OUTPUT):
    raw = canonical(value, maximum)
    if not 1 <= len(raw) <= maximum:
        raise ValueError('lease_frame_bound')
    frame = struct.pack('!I', len(raw)) + raw
    offset = 0
    while offset < len(frame):
        count = stream.write(frame[offset:])
        if type(count) is not int or not 0 < count <= len(frame) - offset:
            raise ValueError('lease_frame_write')
        offset += count
    stream.flush()


class Lease:
    def __init__(self, lease, epoch, release, kind, model, limit=32):
        if (not all(isinstance(value, str) and re.fullmatch('[a-f0-9]{32}', value) for value in (lease, epoch)) or
                not isinstance(release, str) or not re.fullmatch('[a-f0-9]{64}', release) or
                type(limit) is not int or not 1 <= limit <= 32 or
                (kind, model) not in {('embeddings', 'embeddinggemma-2'), ('embeddings', 'qwen3-embedding-0.6b'),
                                     ('rerank', 'qwen3-reranker-0.6b')}):
            raise ValueError('lease_selection')
        self.lease = lease
        self.epoch = epoch
        self.release = release
        self.kind = kind
        self.model = model
        self.limit = limit
        self.sequence = 0
        self.requests = set()
        self.current = None

    def request(self, value):
        if self.current is not None:
            raise ValueError('lease_request_busy')
        fields = {'format', 'version', 'lease', 'owner_epoch', 'selected_release_sha256',
                  'sequence', 'request', 'request_sha256', 'kind', 'body'}
        if not isinstance(value, dict) or set(value) != fields:
            raise ValueError('lease_request_fields')
        if (value['format'] != 'raya.retrieval.lease.request' or type(value['version']) is not int or value['version'] != 2 or
                value['lease'] != self.lease or value['owner_epoch'] != self.epoch or
                value['selected_release_sha256'] != self.release or value['kind'] != self.kind or
                type(value['sequence']) is not int or value['sequence'] != self.sequence + 1 or
                value['sequence'] > self.limit):
            raise ValueError('lease_request_selection')
        request = value['request']
        body = value['body']
        if (not isinstance(request, str) or not re.fullmatch('[a-f0-9]{32}', request) or request in self.requests or
                not isinstance(body, dict) or body.get('model') != self.model or
                value['request_sha256'] != fingerprint(body)):
            raise ValueError('lease_request_identity')
        self.sequence = value['sequence']
        self.requests.add(request)
        self.current = {key: value for key, value in value.items() if key not in ('body', 'kind', 'format')}
        return body

    def completion(self, result):
        # The parent must still validate result shape/revision and observe its original native owner.
        # This message carries request identity only; it cannot stand in for a process-exit receipt.
        if self.current is None:
            raise ValueError('lease_completion_identity')
        value = {**self.current, 'format': 'raya.retrieval.lease.completion', 'result': result}
        canonical(value, OUTPUT)
        self.current = None
        return value
