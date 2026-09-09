---
"@kilocode/cli": patch
---

Ignore replayed provider-error notifications when retrying persistent goals. Preserve retry receipts across reloads and resume, and avoid blocking a goal when its last allowed retry notification is replayed.
