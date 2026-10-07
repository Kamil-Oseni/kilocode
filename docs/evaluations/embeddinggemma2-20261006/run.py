"""Sequential, isolated CPU retrieval comparison on fixed reviewed gold queries."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

folder = Path(__file__).parent.resolve()
root = folder.parents[2]
os.environ.update(CUDA_VISIBLE_DEVICES='-1', HF_HUB_OFFLINE='1', HF_HUB_DISABLE_PROGRESS_BARS='1', TOKENIZERS_PARALLELISM='false')
parser = argparse.ArgumentParser()
parser.add_argument('model', choices=['qwen', 'gemma'])
parser.add_argument('--label')
parser.add_argument('--code-instruction', action='store_true')
parser.add_argument('--single', action='store_true')
args = parser.parse_args()
label = args.label or args.model
dataset = json.loads((folder/'dataset.json').read_text(encoding='utf-8'))

import psutil
import torch
import transformers
torch.set_num_threads(6)
process = psutil.Process()
report = dict(model=args.model, label=label, device='cpu', dtype='float32', threads=6, max_tokens=512, batch_size=2,
              torch=torch.__version__, transformers=transformers.__version__, dataset_sha256=hashlib.sha256((folder/'dataset.json').read_bytes()).hexdigest(),
              scope=dataset['scope'], code_instruction=args.code_instruction, baseline_rss=process.memory_info().rss)
start = time.perf_counter()
if args.model == 'qwen':
    path = root/'packages/kilo-vscode/script/memory/retrieval/models.py'
    spec = importlib.util.spec_from_file_location('comparison_qwen', path)
    module = importlib.util.module_from_spec(spec)
    manifest = json.loads(Path('D:/Raya/Models/Catalog/Qwen--Qwen3-Embedding-0.6B.json').read_text())
    module.MANIFESTS = {'qwen3-embedding-0.6b': manifest}
    spec.loader.exec_module(module)
    model = module.Embeddings()
    report.update(revision=manifest['revision'], source_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    def encode(texts, group, query=False):
        module.TASK = 'Given a code search query, retrieve relevant code that answers the query.' if args.code_instruction and group == 'code' else 'Given a question, retrieve relevant personal notes that directly answer the question.'
        return torch.cat([model.encode(texts[index:index+2], query=query) for index in range(0, len(texts), 2)]).numpy()
else:
    from sentence_transformers import SentenceTransformer
    manifest = json.loads(Path('D:/Raya/Models/Catalog/google--embeddinggemma-2.json').read_text())
    assert manifest['status'] == 'downloaded_verified'
    model = SentenceTransformer(manifest['path'], device='cpu', local_files_only=True,
        config_kwargs={'vision_config': None, 'audio_config': None}, model_kwargs={'dtype': torch.float32})
    model.max_seq_length = 512
    report.update(revision=manifest['revision'], sentence_transformers=__import__('sentence_transformers').__version__)
    def encode(texts, group, query=False):
        prompt = ('CodeRetrieval' if group == 'code' else 'SearchQuery') if query else 'Document'
        return model.encode(texts, prompt_name=prompt, batch_size=2, normalize_embeddings=True, show_progress_bar=False)
report['load_seconds'] = time.perf_counter()-start
report['loaded_rss'] = process.memory_info().rss
print(json.dumps(dict(stage='loaded', label=label, seconds=report['load_seconds'], rss=report['loaded_rss'])), flush=True)

if args.single:
    start = time.perf_counter()
    vector = encode(['When should the overhead lamp go dark during bedtime?'], 'memory', True)
    report.update(single_query_seconds=time.perf_counter()-start, dimensions=int(vector.shape[1]), peak_wset=getattr(process.memory_info(), 'peak_wset',0))
    (folder/(label+'-results.json')).write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report), flush=True)
    raise SystemExit(0)

import numpy as np
start = time.perf_counter()
vectors = encode([item['text'] for item in dataset['documents']], 'memory')
report['index_seconds'] = time.perf_counter()-start
assert np.isfinite(vectors).all()
assert np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=0.001)
rows = []
latency = []
for index, case in enumerate(dataset['queries']):
    stamp = time.perf_counter()
    vector = encode([case['query']], case['group'], True)[0]
    latency.append(time.perf_counter()-stamp)
    assert np.isfinite(vector).all()
    scores = vectors @ vector
    order = np.argsort(-scores, kind='stable').tolist()
    ids = [dataset['documents'][i]['id'] for i in order]
    rank = ids.index(case['expected'])+1
    row = dict(case, rank=rank, seconds=latency[-1], top5=[dict(id=ids[i], score=float(scores[order[i]])) for i in range(5)])
    if args.model == 'gemma':
        small = vectors[:, :256]
        small = small/np.linalg.norm(small, axis=1, keepdims=True)
        query = vector[:256]/np.linalg.norm(vector[:256])
        order = np.argsort(-(small @ query), kind='stable').tolist()
        ids = [dataset['documents'][i]['id'] for i in order]
        row['rank256'] = ids.index(case['expected'])+1
    rows.append(row)
    if (index+1)%8 == 0:
        print(json.dumps(dict(stage='queries', label=label, completed=index+1, total=len(dataset['queries']))), flush=True)

for group in ['all', 'memory', 'code']:
    selected = rows if group == 'all' else [row for row in rows if row['group'] == group]
    report[group] = dict(count=len(selected), top1=sum(row['rank']==1 for row in selected), top3=sum(row['rank']<=3 for row in selected),
                        top5=sum(row['rank']<=5 for row in selected), mrr=sum(1/row['rank'] for row in selected)/len(selected))
    if args.model == 'gemma':
        report[group]['top1_256'] = sum(row['rank256']==1 for row in selected)
        report[group]['top5_256'] = sum(row['rank256']<=5 for row in selected)
report.update(dimensions=int(vectors.shape[1]), parameters=sum(p.numel() for p in (model.model if args.model=='qwen' else model).parameters()),
              warm_query_median=statistics.median(latency[1:]), warm_query_p95=sorted(latency[1:])[int(0.95*(len(latency)-2))],
              rss=process.memory_info().rss, peak_wset=getattr(process.memory_info(), 'peak_wset', process.memory_info().rss), results=rows)
(folder/(label+'-results.json')).write_text(json.dumps(report, indent=2), encoding='utf-8')
np.save(folder/(label+'-vectors.npy'), vectors)
print(json.dumps({key:value for key,value in report.items() if key!='results'}), flush=True)
