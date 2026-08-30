---
"@kilocode/cli": patch
"raya": patch
---

Fix Undo all, per-hunk Keep/Undo, and the live canvas in non-git workspaces on Windows. A folder that is not a git repository resolved to a work tree of "/", which made git report drive-less paths and silently break checkout-based undo of edited files and empty out review diffs (so no gutter lenses showed). The canvas panel also failed to render because embedded scripts could terminate the host script early. Undo now restores modified files, per-hunk review affordances appear, and canvases render as expected.
