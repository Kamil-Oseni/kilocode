---
"@kilocode/cli": patch
---

Prevent scheduled routine goals from automatically resuming or retrying when their queued run belongs to another backend, has an expired lease, or lacks matching execution records.
