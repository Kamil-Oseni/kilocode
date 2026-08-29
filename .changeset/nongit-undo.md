---
"@kilocode/cli": patch
---

Enable snapshots (and therefore Undo all / Keep all) in workspaces that are not git repositories. Snapshots use a private git directory with the workspace as the work tree, so requiring the workspace itself to be a git repo left undo silently dead in non-git folders: edits recorded no snapshot patch and "Undo all" had nothing to revert. The slow-repo guard still protects very large or home directories.
