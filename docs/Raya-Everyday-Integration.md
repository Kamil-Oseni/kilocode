# Everyday branch integration

Checkpoint: October 6, 2026. This handoff identifies source awaiting delivery; it does not certify installed behavior.

## Latest converged source

The everyday branch now includes the full integration commit `0fecb6f41fa6e4827ce3dc2f2f18e1c121ccb977`, including authenticated Memory capture roots and the Windows SDK generator repair. The following older source boundaries are historical. Installation and workflow acceptance remain the integration owner's responsibility.

The original extension fail-fast run stopped at the locale completeness test. Its disjoint continuation completed all 418 remaining files and recorded 29 failing files; the original locale failure remains open. The setup-script timeout test spun in Bun after yielding before attaching its rejection assertion. Both the original child and a focused diagnostic child were explicitly terminated and remain failed, with forced cleanup recorded. The real task timeout and an immediately attached assertion settled normally. The fixture now observes rejection before yielding, retains timeout/stop/late-exit assertions, and passes. The message contract scan now includes the imported Memory, restore, composer and voice type sources; the session-creation fixture now supplies its required connected state. These three files pass **24 tests and 62 assertions**. Extension/webview types and diff checks pass; scoped lint reports zero errors and 14 warnings in the existing fixture patterns.

Evidence is retained in `.tmp/memory-private/extension-unit-suffix-review.json`, `setup-timeout-runner-diagnosis.json`, `setup-timeout-original-abort.json`, `suffix-first-repairs-cohort.log` and `suffix-fixture-repairs-types.log`. The broad suite is still failed; these repairs do not waive the other failures, change production authority checks, or prove installed workflows.

Further qualification uses the existing headless-browser cache explicitly: all six previously failing voice browser files pass **8 cases**. Current-source native helpers were built in this worktree's ignored asset directories, with compilation and self-tests passing. Managed-source, native task retirement, terminal lifetime and desktop metadata pass **29 cases**. The desktop check reads metadata only; it sends no input. Intentional forced retirement remains limited to synthetic test-owned processes. Follow-up fixtures now assert exact project/directory metadata, and indexing supplies isolated extension storage, subscriptions and secret boundaries; those two files pass **13 cases and 34 assertions**. Extension/webview types pass; scoped lint has zero errors and 54 fixture warnings. The original failed logs remain preserved. Fourteen suffix files and the original locale failure still need qualification. The source/hash/log receipt is `.tmp/memory-private/suffix-environment-fixture-qualification.json`; these are test results, not installed or audible acceptance.

Merge `f29836b7d869684ae23867b5a5b4b99f367fd737` includes the integration owner's audit guidance and optional Git-lock discovery fix through `791f567bd978aa9a01b4a5ffcf16574ce38c3fdd`, alongside the everyday branch's bounded evidence inspection and full Memory/Dream work. The earlier boundary below remains a historical checkpoint. The current production difference from fd11 spans 58 files, with 2,716 additions and 172 deletions. The duplicated audit-guidance changeset is consolidated into the integration owner's release note.

The combined Git-candidate, retained Chief/goal and goal-state cohort passes **126 tests, 2,040 assertions**, with no failures. Backend typechecking, shared-source annotation, Promise-facade and diff checks pass. Evidence: `.tmp/memory-private/converged-goal-git-tests.log` and `converged-goal-git-types.log`. These use temporary repositories and synthetic goal transcripts; they do not establish the native-process trial, real model recovery or an installed workflow gate. Preserve the integration owner's uncommitted work before merging the full branch.

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

The integration owner's four additional rejection-output assertions are now retained in this branch's existing actual Task/goal regression. The focused retained-worker follow case passes with 550 assertions, covering the correction instructions alongside existing phase, authority and evidence behavior. Evidence: `.tmp/memory-private/goal-audit-recovery-regression.log`. This is one source regression, not another real-model run or installed gate.

## Bounded goal evidence inspection

`get_goal` now returns the twenty most recent eligible tool records, with the total count and `evidencePage.nextBefore`. Passing that original part ID as `before` retrieves older results; a concurrent newer record does not shift the anchored older page. Missing cursors are refused explicitly. Completion validation still searches the full eligible history and rechecks cited artifacts. A recent snapshot is not automatically current proof. The rejection's bounded evidence menu also prioritizes recent tool start times instead of the oldest twenty results.

The regression exercises 45 fixture results, insertion of a concurrent newer result, all older pages, missing-cursor refusal, the recent rejection menu and successful citation of the oldest result. It uses the actual goal service, persisted Storage and tool handler with synthetic transcript inputs. No model quality or installed behavior is claimed.

The broader cohort initially passed 120 cases and failed its pre-existing late-descendant fixture. A baseline run with both changed production files restored to HEAD reproduced the same failure; current source was restored byte-exactly afterward. The fixture attempted admission inside an already closing parent finalizer. It now distinguishes a racing descendant admitted before closure (which is cancelled) from finalizer admission after closure (which must be refused and leave no registered descendant). The full final cohort passes **121 tests, 1,495 assertions**, with backend types and applicable source guards passing. Earlier fixture setup and expectation failures remain in their logs. Evidence: `.tmp/memory-private/goal-evidence-pages-cohort-qualified.log`, `goal-evidence-pages-types-qualified.log`, `goal-pages-baseline-cancellation.log` and `goal-evidence-pages-focused-qualified.log`. Integration and a real recovery/context test remain pending.

## Recall frame recovery qualification

An additional actual recall-tool regression now holds its service request while replacing the outgoing frame, then supplies a synthetically sourced response through the real bus/service protocol. Publication is refused as superseded. Aborting a second request removes it from the pending service and refuses its late reply. A third request in the current frame succeeds with the original permission and context owner. These checks retain automatic capture off and use synthetic note content, not personal files or model inference.

The combined Ask, Code, Voice, recall service and context-owner cohort passes **21 tests, 185 assertions across six files**, including the real assembled fixed-prompt 32K budget checks. Backend typechecking passes. Evidence: `.tmp/memory-private/memory-recall-frame-cohort.log`, `memory-recall-frame-recovery.log` and `memory-recall-frame-types.log`. These estimates do not prove long-conversation model quality or close the configured Memory/Voice workflow gates.
