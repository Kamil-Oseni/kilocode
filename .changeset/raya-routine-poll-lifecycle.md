---
"@kilocode/cli": patch
---

Keep routine polling active after reported failures and stop its timer and event subscriptions when their owning service closes.

Stop active routine event callbacks with their subscription and prevent queued events from starting new callback work after closure.

Reuse one routine subscription per project instance and clean it up when that instance is disposed.
