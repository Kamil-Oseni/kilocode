"""Actual proposal store fixture; private roots supplied by the owning test."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from proposals import Proposals

print(json.dumps(Proposals(Path(sys.argv[2])).execute(json.load(sys.stdin))))
