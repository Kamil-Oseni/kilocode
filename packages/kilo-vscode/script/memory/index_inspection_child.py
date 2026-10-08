"""Cold read-only inspection of a test namespace; never runs inference."""
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).parent / 'service'))
from index import Index

root = Path(sys.argv[1])
generation = {Path(name): tuple(value) for name, value in json.loads(sys.argv[2]).items()}
started = time.monotonic()
value = Index(root, existing=True, generation=generation).inspect()
assert not {'torch', 'transformers', 'numpy'} & set(sys.modules)
print(json.dumps(dict(index=value, milliseconds=1000 * (time.monotonic() - started), inferenceImports=False)))
