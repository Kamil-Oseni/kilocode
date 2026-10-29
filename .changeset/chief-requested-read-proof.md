---
"@kilocode/cli": patch
"raya": patch
---

Prevent duplicate workers for the same chat invocation. Require a successful file Read before accepting an answer to an explicit single-file Read request, and retain the same worker for corrections.
