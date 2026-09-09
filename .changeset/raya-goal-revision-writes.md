---
"@kilocode/cli": patch
---

Preserve newer goal edits, pauses and deletions when an older operation finishes. Check goal revisions under a filesystem mutation lock, publish updates atomically, and recover locks left by stopped writers.
