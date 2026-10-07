"""Explicit v2 entrypoint; protected dependency admission belongs to its launcher."""
import hashlib
import os
from pathlib import Path
import re
import sys
import uuid

from namespace import Namespace
from owner import BASE, PINS, selected
from pool import GIB, Pool
from server import CATALOGS, IMAGES, Runtime, create
from validation import decode, fingerprint

ROOT = Path(__file__).resolve().parent.parent


def build(env):
    if not sys.flags.isolated or not sys.flags.no_site or not sys.dont_write_bytecode:
        raise ValueError('reuse_fixed_interpreter_flags')
    capsule = ROOT.parent
    if (ROOT.name != 'source' or not capsule.name.startswith('raya-memory-managed-') or
            ROOT.resolve() != ROOT or capsule.resolve() != capsule):
        raise ValueError('reuse_private_source_layout')
    if Path(sys.executable).resolve() != BASE.resolve():
        raise ValueError('reuse_selected_interpreter_path')
    selected(BASE, PINS['interpreter'])
    release = env.get('RAYA_RETRIEVAL_RELEASE_SHA256', '')
    if not re.fullmatch('[a-f0-9]{64}', release):
        raise ValueError('reuse_explicit_release')
    images = {name: (ROOT/name, hashlib.sha256((ROOT/name).read_bytes()).hexdigest()) for name in IMAGES}
    catalogs = {name: (Path('D:/Raya/Models/Catalog')/name, digest) for name, digest in CATALOGS.items()}
    if fingerprint({'source_sha256': {name: digest for name, (_, digest) in images.items()},
                    'catalog_sha256': CATALOGS}, 65536) != release:
        raise ValueError('reuse_selected_release_differs')
    for path, digest in images.values():
        selected(path, digest)
    manifests = {name: decode(selected(path, digest, include=True)[1], 65536)
                 for name, (path, digest) in catalogs.items()}
    revisions = {model: manifests[name]['revision'] for model, name in (
                 ('qwen3-embedding-0.6b', 'Qwen--Qwen3-Embedding-0.6B.json'),
                 ('qwen3-reranker-0.6b', 'Qwen--Qwen3-Reranker-0.6B.json'),
                 ('embeddinggemma-2', 'google--embeddinggemma-2.json'))}
    token = Path(env['RAYA_RETRIEVAL_TOKEN_FILE'])
    receipts = Path(env['RAYA_RETRIEVAL_RECEIPT_ROOT'])
    for path in (token, receipts):
        if not path.is_absolute() or path.resolve() != path or capsule not in path.parents:
            raise ValueError('reuse_private_input_path')
    with token.open('rb') as file:
        raw = file.read(1025)
    if len(raw) > 1024:
        raise ValueError('reuse_token_bound')
    key = selected(token, hashlib.sha256(raw).hexdigest(), include=True)[1].decode('ascii').strip()
    namespace = Namespace(receipts, env['RAYA_RETRIEVAL_RECEIPT_SID'],
                          decode(env['RAYA_RETRIEVAL_RECEIPT_GENERATIONS'].encode(), 65536))
    port = env.get('RAYA_RETRIEVAL_PORT', '8873')
    reserve = env.get('RAYA_RETRIEVAL_MIN_RAM_GIB', '6')
    if (not re.fullmatch('[0-9]{4,5}', port) or not 1024 <= int(port) <= 65535 or
            not re.fullmatch('[0-9]{1,4}', reserve) or not 6 <= int(reserve) <= 1024):
        raise ValueError('reuse_bounded_port_or_reserve')
    pool = Pool(uuid.uuid4().hex, release, revisions, namespace, reserve=int(reserve)*GIB)
    return Runtime(pool, namespace, images, catalogs, key, int(port))


if __name__ == '__main__':
    RUNTIME = build(os.environ)
    try:
        import uvicorn
        uvicorn.run(create(RUNTIME), host='127.0.0.1', port=RUNTIME.port, access_log=False)
    finally:
        result = RUNTIME.close()
        if (not result['closed'] or not result['original_coordinator_joined'] or result['ownership_retained'] or
                not result['request_publications_confirmed'] or not result['request_admissions_joined']):
            raise RuntimeError('reuse_original_service_closure_unconfirmed')
