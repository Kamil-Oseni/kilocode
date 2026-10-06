# Everyday branch integration

Checkpoint: October 6, 2026. This handoff identifies source awaiting delivery; it does not certify installed behavior.

## Source boundary

- Integration base: `fd11bde5e956fadb2dd7075b6a5c32b74ba2cf40`.
- Reviewed everyday source: `fdf8fbb4f26b5d5487ffc69f783a7a0cc2d16616` on `codex/raya-everyday-experience`.
- The everyday branch already merges the integration base. Merge the full branch through the integration owner's checkout; selecting only its latest fixes omits existing feature work.
- The integration checkout currently has local edits to `docs/Raya-Implementation-Progress.md` and `docs/Raya-New-PC-Setup.md`. Preserve these before merging, then reconcile their classifications against actual delivery evidence.

The production source difference spans 55 files, with 2,632 additions and 166 deletions. It includes Memory/Dream controls and lifecycle handling, linked retrieval context, self-heal history, request ownership, and worker failure explanations with read-only Refresh. Associated tests, fixtures, release notes and generated SDK changes must travel with the implementation. Regenerate SDK output through the documented generator; do not hand-edit generated files.

Reproduce the boundary from either checkout after fetching the everyday branch:

```powershell
git merge-base --is-ancestor fd11bde5e956fadb2dd7075b6a5c32b74ba2cf40 fdf8fbb4f26b5d5487ffc69f783a7a0cc2d16616
git diff --stat fd11bde5e956fadb2dd7075b6a5c32b74ba2cf40 fdf8fbb4f26b5d5487ffc69f783a7a0cc2d16616 -- packages/opencode/src packages/kilo-vscode/src packages/kilo-vscode/webview-ui/src
git diff --name-only fd11bde5e956fadb2dd7075b6a5c32b74ba2cf40 fdf8fbb4f26b5d5487ffc69f783a7a0cc2d16616
```

## Existing verification

| Evidence | Scope |
|---|---|
| `.tmp/memory-private/fd11-memory-merge-tests.log` | 121 tests, 355 assertions: merged conversation, request ownership and worker state |
| `.tmp/memory-private/fd11-memory-backend-merge-tests.log` | 29 tests, 135 assertions: backend Memory, Dream tracking and context |
| `.tmp/memory-private/fd11-memory-dream-producer-qualified.log` | 58 tests, 468 assertions; pinned Python protocol producer, synthetic settings and credentials |
| `.tmp/memory-private/fd11-memory-v2-producer-qualified.log` | 18 tests, 282 assertions; actual client/host orchestration with controlled transport |
| `.tmp/memory-private/worker-retry-unit.log` | 53 tests, 174 assertions: worker state and controlled SDK failures |
| `.tmp/memory-private/worker-retry-browser-qualified.log` | Five mounted Chromium checks: failure details, bounded text, Refresh and revision-scoped Stop |
| `.tmp/memory-private/worker-retry-compile.log` | SDK regeneration, extension/webview types, lint and complete source compilation |

Logs are local evidence in the everyday worktree, not tracked release artifacts. Preserve failed reproductions alongside final results. The required pure Python producer is `D:/Raya/Services/Packaging/Python/3.12.14/python.exe`, selected using `RAYA_MEMORY_OPERATION_PYTHON`; missing this prerequisite skips ownership coverage. It does not load a personal model or enable capture.

## Delivery sequence

1. Finish and retain the current integration owner's exclusive model test; this handoff is not authorization to interrupt or restart it.
2. Preserve integration checkout edits, merge the entire reviewed branch, and resolve any newer owner changes without discarding either implementation.
3. Run affected package types, lint, focused tests, Knip, shared-code annotation and Promise facade guards. Regenerate SDK endpoints and run the supported production build for the resulting commit.
4. Bind the delivered extension, bundled CLI and local services to that exact resulting commit/version. Verify preserved settings and sessions through the supported installation path.
5. Exercise configured Memory and retrieval with automatic capture disabled, then the remaining ordinary conversation, coding, voice, routine and recovery workflows. Keep test permissions consistent with current user instructions.

The installed fd11 package and preservation evidence does not cover these newer sources. A successful merge or build does not close a workflow gate. Seven installed workflow/recovery gates remain open in `Raya-Current-Readiness.md`; all 38 unfinished implementation requirements remain in scope.
