"""Supervise only the owned benchmark process, retaining a 6 GiB RAM reserve."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import psutil

folder = Path(__file__).parent
label = sys.argv[1]
start = time.perf_counter()
peak = 0
minimum = psutil.virtual_memory().available
reason = None
children = {}
os.environ['PYTHONIOENCODING'] = 'utf-8'
sys.stdout.reconfigure(encoding='utf-8')
with (folder/(label+'.log')).open('w', encoding='utf-8') as log:
    process = subprocess.Popen(sys.argv[2:], stdout=log, stderr=subprocess.STDOUT)
    owned = psutil.Process(process.pid)
    while process.poll() is None:
        free = psutil.virtual_memory().available
        minimum = min(minimum, free)
        try:
            for child in owned.children(recursive=True):
                children[child.pid] = child
            peak = max(peak, owned.memory_info().rss + sum(child.memory_info().rss for child in children.values() if child.is_running()))
        except psutil.NoSuchProcess:
            break
        if free < 6*1024**3 or time.perf_counter()-start > 900:
            reason = 'ram_reserve' if free < 6*1024**3 else 'deadline'
            for child in children.values():
                if child.is_running():
                    child.terminate()
            process.terminate()
            break
        time.sleep(0.2)
    code = process.wait(timeout=30)
gone, alive = psutil.wait_procs(list(children.values()), timeout=30)
receipt = dict(label=label, exit_code=code, joined=not alive, aborted=reason, seconds=time.perf_counter()-start, sampled_peak_rss=peak, minimum_free_ram=minimum, remaining_owned_pids=[child.pid for child in alive])
(folder/(label+'-receipt.json')).write_text(json.dumps(receipt, indent=2), encoding='utf-8')
print(json.dumps(receipt), flush=True)
print((folder/(label+'.log')).read_text(encoding='utf-8', errors='replace')[-5000:])
assert not alive, 'Owned inference process remains unjoined'
raise SystemExit(code if code else (1 if reason else 0))
