"""Compare candidate lists using the same existing production CPU reranker."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import time

folder = Path(__file__).parent.resolve()
root = folder.parents[2]
os.environ.update(CUDA_VISIBLE_DEVICES='-1', HF_HUB_OFFLINE='1', HF_HUB_DISABLE_PROGRESS_BARS='1', TOKENIZERS_PARALLELISM='false')
import psutil
import torch
import transformers
torch.set_num_threads(6)
path = root/'packages/kilo-vscode/script/memory/retrieval/models.py'
spec = importlib.util.spec_from_file_location('comparison_ranker', path)
module = importlib.util.module_from_spec(spec)
manifest = json.loads(Path('D:/Raya/Models/Catalog/Qwen--Qwen3-Reranker-0.6B.json').read_text())
module.MANIFESTS = {'qwen3-reranker-0.6b': manifest}
spec.loader.exec_module(module)
dataset = json.loads((folder/'dataset.json').read_text(encoding='utf-8'))
docs = {item['id']:item['text'] for item in dataset['documents']}
start = time.perf_counter()
model = module.Reranker()
report = dict(revision=manifest['revision'], source_sha256=hashlib.sha256(path.read_bytes()).hexdigest(), dataset_sha256=hashlib.sha256((folder/'dataset.json').read_bytes()).hexdigest(),
              dtype='float32', device='cpu', threads=6, max_tokens=512, torch=torch.__version__, transformers=transformers.__version__, load_seconds=time.perf_counter()-start)
for label in ['qwen-current-v2', 'qwen-matched', 'gemma-v3']:
    candidate = json.loads((folder/(label+'-results.json')).read_text(encoding='utf-8'))
    assert candidate['dataset_sha256'] == report['dataset_sha256']
    rows = []
    for index, item in enumerate(candidate['results']):
        ids = [row['id'] for row in item['top5']]
        stamp = time.perf_counter()
        try:
            ranking = model.rank(item['query'], [docs[key] for key in ids])
        except ValueError as error:
            rows.append(dict(query=item['query'], expected=item['expected'], group=item['group'], error=str(error)))
            continue
        order = [ids[row['index']] for row in ranking]
        rows.append(dict(query=item['query'], expected=item['expected'], group=item['group'], rank=order.index(item['expected'])+1 if item['expected'] in order else None,
                         seconds=time.perf_counter()-stamp, order=order))
        if (index+1)%8 == 0:
            print(json.dumps(dict(stage='rerank', label=label, completed=index+1, total=len(candidate['results']))), flush=True)
    result = dict(results=rows, errors=sum('error' in row for row in rows))
    for group in ['all', 'memory', 'code']:
        selected = rows if group=='all' else [row for row in rows if row['group']==group]
        result[group] = dict(count=len(selected), top1=sum(row.get('rank')==1 for row in selected),
                             top3=sum(row.get('rank') is not None and row['rank']<=3 for row in selected),
                             mrr=sum(1/row['rank'] if row.get('rank') else 0 for row in selected)/len(selected))
    times = [row['seconds'] for row in rows if 'seconds' in row]
    result['median_seconds'] = statistics.median(times)
    report[label] = result
    (folder/'reranker-results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
report.update(rss=psutil.Process().memory_info().rss, peak_wset=getattr(psutil.Process().memory_info(), 'peak_wset',0))
(folder/'reranker-results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({key:({k:v for k,v in value.items() if k!='results'} if isinstance(value,dict) else value) for key,value in report.items()}), flush=True)
