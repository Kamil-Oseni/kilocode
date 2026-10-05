"""Synthetic coordinator fixture: genuine pinned bridge, only EOF exit is faulted."""
import runpy
import sys

script = "D:/Raya/Services/Memory/Candidates/TrustedHostStdio-20261003-v2/bridge.py"
sys.argv = [script, "--config", sys.argv[1]]
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as outcome:
    if outcome.code not in (None, 0):
        raise
raise SystemExit(23)
