---
"@kilocode/cli": patch
---

Preserve process start identity in interrupted routine claims and recovery permits so a reused PID does not prevent supported recovery.

Keep routine recovery held when a saved process timestamp is malformed or noncanonical.
