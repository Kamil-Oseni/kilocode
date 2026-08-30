---
"@kilocode/cli": patch
"raya": patch
---

Tell the agent when you undo its edits. "Undo all" and per-file discard restore files but leave the conversation intact, so the agent's history still showed edits that no longer existed — it could claim a change was already present or refuse to redo it. After a discard, the next turn now carries a one-shot note listing the reverted files and reminding the agent to re-read before acting.
