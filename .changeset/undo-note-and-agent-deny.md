---
"@kilocode/cli": patch
"raya": patch
---

Tell the agent when you undo its edits, and stop blaming you for Auto's own deny-all rule. After Undo all or a per-file undo, the next prompt includes a one-shot reminder that those files were restored, so the agent re-reads and re-applies instead of claiming the change is still there. A `/goal` Auto turn that tries a tool it must delegate no longer reports that "the user specified a rule" — it says the agent must use the task tool instead.
