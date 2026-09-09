---
"raya": minor
---

Add an indexed search box to Raya's Settings that finds any setting by keyword — including application-scoped ones like the self-heal source path that previously only appeared in VS Code's native Settings; matches jump to the owning tab or open the exact key in native Settings. Fix the `ask_options` tool being reported as "Unknown tool" so Auto can ask clarifying questions directly. Fix `/canvas` so the Auto agent can create and refine a live canvas (and follow the host's retry hint) instead of hitting "Unknown tool: update_canvas", and bound canvas compilation so a stuck build surfaces a fast error instead of leaving an empty panel. Keep the in-editor browser crisp when the window is resized by capturing at the panel's device pixel ratio.
