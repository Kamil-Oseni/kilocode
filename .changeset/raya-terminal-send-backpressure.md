---
"@kilocode/cli": patch
---

Bound terminal output while readers stall and preserve ordered delivery and reconnect closure. Limit fallback close requests so stalled shutdown cannot hold terminal readers indefinitely.
