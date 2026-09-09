---
"@kilocode/cli": patch
---

Bound goal recovery when turns produce only failed or unverified tool results. Require a recorded zero exit code for successful shell work, and suppress new continuation while tool results remain pending or running.
