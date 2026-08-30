---
"raya": minor
---

Fix a batch of reported issues: `/self-heal` now runs (it was misrouted as a server command) and targets Raya's own source checkout via the new `raya.selfHeal.sourcePath` setting so she can repair herself. The Auto agent and active goals can now use the ask tool to ask clarifying questions. The in-editor browser panel scrolls. In-editor Undo now actually reverts edits in non-git folders on Windows (snapshot restore used an absolute drive-less path that git rejected). Snapshot initialization no longer prompts to disable itself for the project, and the Checkpoints toggle re-enables snapshots at the correct scope. A slow `create_canvas` no longer aborts the turn, and a malformed streamed tool call (e.g. `task`) is surfaced as a recoverable tool error instead of killing the model stream.
