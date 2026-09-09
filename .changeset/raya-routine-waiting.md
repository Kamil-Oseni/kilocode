---
"@kilocode/cli": patch
---

Prevent another routine run from starting while an existing run is waiting for your input.

Coordinate routine starts across backend processes and prevent automatic repetition after an uncertain startup failure.

Preserve unfinished routine runs when their goals are still active during settlement or restart.

Recover leftover startup claims from stopped backends when both the recorded run and its goal are complete.

Publish routine definitions, run history, and role memory atomically to preserve readable records during saves.

Preserve concurrent routine edits, run records, and appended role-memory summaries across backend processes.

Reject outdated run updates and avoid duplicate role-memory summaries from concurrent completion callbacks.

Reject stale callbacks even after a routine waits for input and returns to running.
