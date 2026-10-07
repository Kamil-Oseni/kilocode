---
"@kilocode/cli": patch
---

Avoid redundant Windows cleanup commands when the original child has already exited but its callback and buffered output are still pending.
