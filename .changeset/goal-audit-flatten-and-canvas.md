---
"@kilocode/cli": patch
"raya": patch
---

Fix the goal completion audit rejecting valid work and the live canvas rendering as raw code. Completing a goal now accepts the audit whether the requirements are nested under `audit` or provided at the top level (the shape models emit far more often), and a missing audit now returns the exact expected shape plus the real eligible evidence callIDs so completion succeeds in one attempt instead of looping until the goal self-blocks. The canvas panel no longer breaks when its host script contains a closing-script sequence, so canvases render instead of showing their own source.
