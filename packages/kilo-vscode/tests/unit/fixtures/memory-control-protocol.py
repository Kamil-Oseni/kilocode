"""Disposable protocol faults only, never a synthetic policy acceptance oracle."""
import json
import sys
import time
import subprocess
import runpy

if sys.argv[1] == 'identity':
    time.sleep(0.05)
    raise SystemExit(23)

if sys.argv[1] == 'lost':
    # Execute the genuine pinned bridge unchanged. Only its reply pipe is faulted
    # after the actual Host policy publication, not the business operation.
    original = sys.stdout
    class Lost:
        def __init__(self):
            self.buffer = self
            self.seen = 0
        def write(self, raw):
            row = json.loads(raw)
            if row.get('ok') and row.get('result', {}).get('status') == 'policy_published':
                self.seen += 1
                if self.seen == 2:
                    return len(raw)
            return original.buffer.write(raw)
        def flush(self):
            original.buffer.flush()
    script = sys.argv[4]
    sys.argv = [script, '--config', sys.argv[3]]
    sys.stdout = Lost()
    runpy.run_path(script, run_name='__main__')

mode = sys.argv[1]
for raw in sys.stdin.buffer:
    row = json.loads(raw)
    if mode == 'dead':
        raise SystemExit(23)
    if mode == 'pipes':
        subprocess.Popen([sys.executable, '-I', '-c', 'import time;time.sleep(3)'],
                         stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr)
        raise SystemExit(0)
    if mode == 'hold':
        time.sleep(11)
    value = {'format': 'raya.memory.control.reply', 'version': 1, 'seq': row['seq'], 'ok': True,
             'result': {'policy_sha256': None, 'policy': {'format': 'raya-general-sources-v1',
                       'root': sys.argv[2], 'enabled': False, 'revision': 0, 'files': []},
                       'capture_enabled': False}}
    output = json.dumps(value).encode() + b'\n'
    if mode == 'duplicate':
        output = b'{"seq":1,"seq":1}\n'
    if mode == 'oversize':
        output = b'x' * 2097153 + b'\n'
    if mode == 'partial':
        sys.stdout.buffer.write(b'{')
        sys.stdout.buffer.flush()
        raise SystemExit(0)
    if mode == 'wrong':
        value['seq'] += 1
        output = json.dumps(value).encode() + b'\n'
    if mode == 'extra':
        output += output
    if mode == 'invalid':
        output = b'\xff\n'
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()
