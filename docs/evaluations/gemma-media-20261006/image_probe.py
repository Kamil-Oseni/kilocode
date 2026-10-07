"""Actual pinned text/image encoder and catalog recall on two synthetic images."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
os.environ.update(CUDA_VISIBLE_DEVICES='-1', HF_HUB_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
import numpy as np
from PIL import Image
import psutil
import torch
from sentence_transformers import SentenceTransformer

folder = Path(__file__).parent
root = folder.parents[2]
source = root/'packages/kilo-vscode/script/memory/media/library.py'
spec = importlib.util.spec_from_file_location('media_library', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
manifest = json.loads(Path('D:/Raya/Models/Catalog/google--embeddinggemma-2.json').read_text())
assert manifest['revision'] == module.REVISION and manifest['status'] == 'downloaded_verified'
torch.set_num_threads(6)
stamp = time.perf_counter()
model = SentenceTransformer(manifest['path'], device='cpu', local_files_only=True,
    config_kwargs={'audio_config': None}, model_kwargs={'dtype': torch.float32})
model.max_seq_length = 512
report = dict(revision=module.REVISION, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), device='cpu', dtype='float32', parameters=sum(p.numel() for p in model.parameters()), load_seconds=time.perf_counter()-stamp, cases=[],
              scope='Two simple synthetic color pictures; no personal data, no general multimodal quality claim and no installed service acceptance.')
print(json.dumps(dict(stage='loaded', parameters=report['parameters'], seconds=report['load_seconds'])), flush=True)
space = dict(model=module.MODEL, revision=module.REVISION, dimensions=module.DIMENSIONS)
with tempfile.TemporaryDirectory(prefix='raya-gemma-image-smoke-') as temp:
    root = Path(temp)
    library = module.Library(root)
    ids = {}
    for color in ('red', 'blue'):
        path = root/(color+'.png')
        Image.new('RGB', (224,224), color).save(path)
        item = library.add(path, color+' synthetic image')
        decoded = module.inspect(root/item['relative'])
        assert decoded['sha256'] == item['sha256']
        stamp = time.perf_counter()
        values = model.encode({'text':'<|image|>', 'image':str(root/item['relative'])}, normalize_embeddings=True, show_progress_bar=False)
        assert values.shape == (768,) and np.isfinite(values).all()
        library.publish([dict(id=item['id'],sha256=item['sha256'],vector=values.tolist())],space)
        ids[color] = item['id']
        report['cases'].append(dict(stage='image',color=color,seconds=time.perf_counter()-stamp,sha256=item['sha256'],dimensions=768))
        print(json.dumps(report['cases'][-1]),flush=True)
    for color in ('red','blue'):
        stamp = time.perf_counter()
        query = model.encode('A solid '+color+' image',prompt_name='SearchQuery',normalize_embeddings=True,show_progress_bar=False)
        results = library.search(query.tolist(),space)
        report['cases'].append(dict(stage='recall',color=color,seconds=time.perf_counter()-stamp,correct=results[0]['id']==ids[color],scores=[dict(id=row['id'],score=row['similarity']) for row in results]))
        print(json.dumps(report['cases'][-1]),flush=True)
report['rss'] = psutil.Process().memory_info().rss
(folder/'image-smoke-results.json').write_text(json.dumps(report,indent=2))
assert all(case['correct'] for case in report['cases'] if case['stage']=='recall')
print(json.dumps(dict(stage='finished',rss=report['rss'])),flush=True)
