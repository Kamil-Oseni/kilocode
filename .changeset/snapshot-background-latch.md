---
"raya": patch
---

Fix "Undo all" and per-file undo doing nothing when the agent delegated the edits to a subagent. Delegated turns write files inside child subagent sessions, so their change records lived on the child while undo only looked at the displayed parent turn — now undo restores edits made by every subagent spawned in the chat. Also stop a slow background snapshot warmup from disabling change tracking for the whole session.
