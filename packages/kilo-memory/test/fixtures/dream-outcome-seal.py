"""Seal an intentionally inconsistent test outcome with the actual producer codec."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from proposals import canonical
from notes import digest

value = json.loads(sys.stdin.buffer.read())
value.pop('digest', None)
value['digest'] = digest(canonical(value))
print(json.dumps(value))
