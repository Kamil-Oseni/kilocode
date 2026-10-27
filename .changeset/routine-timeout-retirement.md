---
"@kilocode/cli": patch
---

Stop expired workers before reporting failure or resuming their waiting parent, and retry failed stops without interrupting successor work.
