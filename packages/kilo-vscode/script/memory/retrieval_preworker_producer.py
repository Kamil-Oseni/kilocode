"""Actual protected ASGI RAM refusal and supervisor diagnostics; no model loading."""
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import uuid
import httpx

cfg = json.loads(Path(sys.argv[1]).read_bytes())
root = Path(cfg['root']) / 'source'
sys.path.insert(0, str(root / 'retrieval'))
sys.path.insert(0, str(root / 'retrieval_reuse'))
from namespace import Namespace
import pool
from server import CATALOGS, IMAGES, Runtime, create
from validation import fingerprint

spec = importlib.util.spec_from_file_location('reviewed_supervisor', Path(__file__).parent / 'supervise.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)
supervisor.diagnostics()
space = cfg['namespaces']['retrieval']
namespace = Namespace(space['root'], space['sid'], {name: [int(value) for value in row]
                      for name, row in space['generations'].items()})
images = {name: (root / name, hashlib.sha256((root / name).read_bytes()).hexdigest()) for name in IMAGES}
catalogs = {name: (Path('D:/Raya/Models/Catalog') / name, digest) for name, digest in CATALOGS.items()}
release = fingerprint({'source_sha256': {name: digest for name, (_, digest) in images.items()},
                       'catalog_sha256': CATALOGS}, 65536)
# Actual OS measurement cannot satisfy this reserve. Admission/settlement remain original implementation.
selected = pool.Pool(uuid.uuid4().hex, release, {'embeddinggemma-2': 'b' * 40}, namespace, reserve=1 << 50)
runtime = Runtime(selected, namespace, images, catalogs, 'synthetic-test-token-' + 'x' * 32)
app = create(runtime)


async def run():
    key = uuid.uuid4().hex
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8873') as client:
            response = await client.post('/v2/embeddings', json={'model': 'embeddinggemma-2', 'input': ['Synthetic refusal input']},
                         headers={'Authorization': 'Bearer ' + runtime.token, 'X-Raya-Owner-Epoch': selected.epoch,
                                  'X-Raya-Request-ID': key})
            assert response.status_code == 503, response.text
            proof = response.json()['settlement']
            assert proof['worker_created'] is False and proof['inference_outcome'] == 'failed'
            assert selected.owner is None
            file = namespace.root / 'Runs' / selected.epoch / key / '000000.json'
            diagnostic = json.loads(file.read_bytes())
            assert diagnostic['cause'] == 'pool_memory_reserve' and diagnostic['http_status'] == response.status_code
            assert len(diagnostic['memory']) == 1 and diagnostic['memory'][0]['available_ram_bytes'] > 0
            assert diagnostic['memory'][0]['required_ram_bytes'] == selected.reserve + 5 * pool.GIB
            assert diagnostic['settlement_authority'] is False and diagnostic['replay'] is False
            assert 'Synthetic refusal input' not in file.read_text()
            return {'proof': proof, 'diagnostic': diagnostic, 'file': str(file)}


print(json.dumps(asyncio.run(run())))
