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
| `.tmp/memory-private/integration-linked-current.log` | 12 tests, 95 assertions: actual Python note publication/reader through the client, stale policy and seed refusal, bounded context, diagnostic races |
| `.tmp/memory-private/integration-self-heal-current.log` | 15 tests, 172 assertions: actual temporary snapshot checks and durable Storage receipts; stale source, goal and audit refusal |

Logs are local evidence in the everyday worktree, not tracked release artifacts. Preserve failed reproductions alongside final results. The required pure Python producer is `D:/Raya/Services/Packaging/Python/3.12.14/python.exe`, selected using `RAYA_MEMORY_OPERATION_PYTHON`; missing this prerequisite skips ownership coverage. It does not load a personal model or enable capture.

The two additional integration runs above completed on the reviewed branch with zero failures and no skips. Linked transport additionally requires `RAYA_LINKED_TEST_PYTHON` pointing at that interpreter. Its producer exercises the actual service reader/publication implementation in temporary data. Self-heal cases execute checks in temporary Git snapshots and verify persisted receipts; their transcripts and delivery fixtures are synthetic. Neither run proves configured personal Memory, autonomous model repair, installed delivery or recovery after a real boot.

## Delivery sequence

1. Finish and retain the current integration owner's exclusive model test; this handoff is not authorization to interrupt or restart it.
2. Preserve integration checkout edits, merge the entire reviewed branch, and resolve any newer owner changes without discarding either implementation.
3. Run affected package types, lint, focused tests, Knip, shared-code annotation and Promise facade guards. Regenerate SDK endpoints and run the supported production build for the resulting commit.
4. Bind the delivered extension, bundled CLI and local services to that exact resulting commit/version. Verify preserved settings and sessions through the supported installation path.
5. Exercise configured Memory and retrieval with automatic capture disabled, then the remaining ordinary conversation, coding, voice, routine and recovery workflows. Keep test permissions consistent with current user instructions.

The installed fd11 package and preservation evidence does not cover these newer sources. A successful merge or build does not close a workflow gate. Seven installed workflow/recovery gates remain open in `Raya-Current-Readiness.md`; all 38 unfinished implementation requirements remain in scope.

## Additional cancellation feedback repair

The consolidation activity panel previously displayed “Joining cancelled request…” indefinitely when the cancellation response was lost. It now reports “Cancellation unconfirmed” after ten seconds, retains the original pending request, and offers read-only activity refresh or checkpoint inspection without dispatching another Cancel. A foreign reply cannot settle the request; a late reply with its original ID can. This deadline describes missing feedback and does not claim the worker has stopped or release its ownership.

All four mounted Chromium activity tests pass, including this lost-response case and the existing dark/light narrow-screen accessibility and stale activity-read cases. Extension/webview types, lint, bundle, Knip, marker and diff checks pass. Compilation reused the existing bundled CLI and unchanged generated SDK because this repair changes only webview behavior. Evidence: `.tmp/memory-private/consolidation-cancel-current-browser.log`, `consolidation-cancel-compile.log` and `consolidation-cancel-knip.log`. Installed delivery and actual native cancellation remain pending.

The follow-up closes recovery through an activity refresh: a newer `joined` revision for the exact original run and owner clears the pending cancellation notice without replay. Stale revisions, other owners and `uncertain` cleanup do not. All five activity browser tests pass, including both the late original Cancel reply and the read-only recovery path. Types, lint, bundle, Knip, marker and diff checks pass. Evidence: `.tmp/memory-private/consolidation-cancel-refresh-browser.log`, `consolidation-cancel-refresh-checks.log` and `consolidation-cancel-refresh-knip.log`. This projects the existing host lifecycle; it does not establish native cleanup independently.

## Live General finding and recovery guidance

A read-only observation of the running fd11 General trial on October 6 at 19:32 UTC verifies that its synthetic source and result are byte-identical: 48 bytes, SHA-256 `8065121f0d852f5d5c72dbbcf1bff9a4e7f0c7c5669730be414c1d89a7692a6c`. The persisted conversation contains completed canonical Write and result Read operations. Its initial malformed drive-relative Write was refused by the existing permission rules. The parent subsequently attempted completion with stale artifact evidence twice, despite a recovery response identifying the retained worker and required fresh source/target Read citations. It then blocked the goal with a request for user approval to fix evidence IDs. At observation time the child goal remained active. This partial evidence does not close the General gate; the original test owner retains final validation and shutdown responsibility. Evidence: `.tmp/memory-private/general-fd11-live-output-review.json` and the original trial's persisted tool outputs.

The successor source makes the rejection response explicitly distinguish audit correction from an approval requirement. It instructs the model to repair authorized work/evidence, read fresh eligible callIDs and invoke the supplied retained-worker recovery. Actual permission refusal and explicitly required human review keep their normal paths. This changes guidance only: the audit, permission, lifecycle and review checks still enforce their existing rules. Six focused Chief/goal tests pass with 594 assertions, backend typechecking and shared-source/Promise-facade guards pass. The retained test log includes synthetic model-catalog subscriber diagnostics. Evidence: `.tmp/memory-private/goal-audit-recovery-checks.log` and `goal-audit-recovery-types.log`. Source acceptance does not prove the model follows this guidance; integration and a real retest remain required.
