# Raya remaining implementation and agent handoff

> **CURRENT STATUS (2026-09-12):** grok Deleted-file virtual review buffers are installed as `3bac23d766`. Remaining: leftover 39-requirement work that is still implementable here, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent. Codex-derived work stays deferred.

> **CURRENT ROUTINES REQUIREMENT:** Implement the agent-DM inbox, in-place reports/follow-ups and tracked worker-to-worker delegation specified in [Routines direction](#routines-direction-agent-dm-inbox-and-company-delegation). This expands current OVR-05 acceptance; it is not deferred Codex work.

> **LATEST PRIORITY:** Continue GPT-Live 1 and the remaining 39-requirement scope before Codex-derived additions. See [Codex research and deferred backlog](Raya-Codex-Research-Deferred.md). Keep updating this handoff and the progress ledger during implementation.

Updated 2026-09-12. This is a continuation guide, not a completion certificate.

**Latest delivered product:** grok installed snapshot `3bac23d766` (`eden.raya@7.4.23-snapshot+3bac23d766.kamil-oseni.1789226754719`). Opening a deleted reviewed file loads a virtual editor buffer with Keep/Undo. Reload VS Code to pick up the snapshot.

## Scope and reading order

Implement all **39 requirements**: PR-01–06, EN-01–15, UX-01–05, UI-01–03, and OVR-01–10. Read [the comprehensive audit](Raya-Comprehensive-Audit.md), especially sections 6, 11 and 12, for the full specification. Read [implementation progress](Raya-Implementation-Progress.md) for chronological evidence, and [voice architecture mapping](Raya-Voice-Architecture-Implementation.md) plus [voice architecture](Raya-Voice-Architecture.md) for the intended experience. The user's latest direction selects GPT-Live 1 instead of rebuilding provider-owned voice machinery.

Status excerpts below are historical records, not a fresh certification of every feature. Git, current code and actual terminal results are authoritative. Older failures in the progress log may have been superseded; use the latest matching checkpoint. Do not call a requirement complete because a narrower test passes.

## Checkpoint and standing authorization

- Workspace: `C:\Users\User\Desktop\raya`; PowerShell; branch `main`; origin `https://github.com/Kamil-Oseni/kilocode.git`.
- Last verified pushed product checkpoint: `8b01e7231172ad8916065bcef2e7dc78cb5ec76a`, pending-approval policy snapshot.
- Installed: `eden.raya@7.4.23-snapshot+8b01e72311.kamil-oseni.1789091821099`.
- VSIX: `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-8b01e72311-kamil-oseni-1789091821099.vsix`; SHA-256 `446FC10C1FAA687194561707B5A49F55671FCD68B45ABCE07DD84121D85F9DE7`.
- The user authorizes two parallel workers plus root, batched checks, periodic normal commits/pushes to `origin/main`, and `snapshot:install` outside the sandbox. Do not ask again. No force push, hook bypass or forced VS Code reload.
- At approximately $10 remaining, as reported by the user, stop opening broad work, settle current processes, update this handoff and give the continuation prompt below. Do not invent a credit balance.

## Immediate uncommitted work

These three items were listed as uncommitted at e74508a063 recovery. They are now committed, pushed, and part of later installs, including the current snapshot. Re-verified 2026-09-11. Do not treat this section as outstanding source. Codex-deferred research stays untracked.

### Recorder binary secret refusal — EN-13

**States:** committed and pushed in `e74508a063`; present in later snapshots including `9f6864dba8`. Re-verified: `bun test ./test/record-replay.test.ts --timeout 30000` in `packages/http-recorder` → 37 pass / 0 fail / 185 expect / exit 0.

Files: `packages/http-recorder/src/redaction.ts`, `packages/http-recorder/test/record-replay.test.ts`, `docs/Raya-Diagnostic-Data-Boundaries.md`, `.changeset/raya-recorder-binary-secrets.md`.

Strict canonical base64 inspection for declared HTTP response bodies and binary WebSocket frames, with an aggregate 8 MiB decoded budget per inspected interaction. Known-token/environment-secret detection checks decoded UTF-8 without rewriting safe replay bytes. Arbitrary private prose, compressed/encrypted content and undeclared encodings remain outside this detector.

### Support/release contract — PR-06

**States:** committed and pushed in `e74508a063`; present in later snapshots including `9f6864dba8`. Re-verified: `bun test --config .tmp/bunfig-script.toml ./script/kilocode/raya-support.test.ts --timeout 30000` → 7 pass / 0 fail / 26 expect / exit 0. `bun run script/check-workflows.ts` → exit 0.

Files: `docs/Raya-Support-Contract.json`, `docs/Raya-Supported-Clients.md`, `script/kilocode/raya-support.ts`, `script/kilocode/raya-support.test.ts`, `.github/workflows/raya-release.yml`, `.github/workflows/check-opencode-annotations.yml`, `.changeset/raya-support-contract.md`.

Shared identity/editor-range/target/runner/asset contract, generated matrix block, drift guard and source-pinned release-note preamble. Configured macOS/Linux targets are not installation evidence. Do not publish a release to test the notes.

### Telemetry connection lifecycle — EN-13

**States:** diagnostic transport committed in `e74508a063`; awaited settlement committed as `a0024a4f77`. Re-verified: `bun test tests/unit/telemetry-proxy-boundary.test.ts tests/unit/telemetry-proxy-utils.test.ts --timeout 30000` in `packages/kilo-vscode` → 13 pass / 0 fail / 25 expect / exit 0.

Files: `packages/kilo-vscode/src/services/telemetry/telemetry-proxy.ts`, `packages/kilo-vscode/src/extension.ts`, `packages/kilo-vscode/tests/unit/telemetry-proxy-boundary.test.ts`, `.changeset/raya-telemetry-connection-lifecycle.md`.

Endpoint/password invalidation on disconnect/shutdown, cancellation of obsolete requests, scope and consent rechecks after property enrichment/JSON serialization, redirect refusal, 10-second deadlines and generic failure logs. Capture admission caps pending requests at 32; consent requests are not covered by that cap. Receiving-side consent ordering is NOT fixed: an old enable request can still apply after a later opt-out. Aborting the client request cannot prove a server mutation was undone.

## GPT-Live 1 migration takes priority over more Realtime infrastructure

Official pages fetched on 2026-09-10 confirm `gpt-live-1`: [model](https://developers.openai.com/api/docs/models/gpt-live-1), [getting started](https://developers.openai.com/api/docs/guides/live), [migration](https://developers.openai.com/api/docs/guides/live-migration). Search initially found nothing; direct official retrieval succeeded.

GPT-Live supports full-duplex conversation with independently selected backend delegation. Its documented voice charge is duration-based and separate from backend model/tool usage. The model page lists audio/text, not native image/video input. Account access and live quality still need testing. [Model details](https://developers.openai.com/api/docs/models/gpt-live-1)

Client delegation is the proposed fit for Raya's existing runtime. Keep its tools, permissions, parent task and durable state. Live has different session/audio/transcript events; old manual response triggers and response-completion assumptions cannot simply be retained. Delegation notification is not itself an executable structured work request. [Migration guidance](https://developers.openai.com/api/docs/guides/live-migration)

Implementation sequence:

1. Fetch the Live WebRTC, sideband, managing-sessions, client-delegation and API reference pages before coding. Use official OpenAI Docs search/fetch when available. Keep keys in the trusted host/server, never the webview.
2. Create a compatibility table for setup/SDP, readiness, sideband, context acknowledgement, captions, interruption, delegation, termination and usage. Update `Raya-Voice-Architecture-Implementation.md`. Preserve the architecture's experience goals, not obsolete provider plumbing.
3. Add a Kilo-owned Live adapter alongside `src/speech/openai-broker.ts`. Preserve `service.ts` reservation-before-admission and exact cleanup ownership. Fence immutable server configuration, parent and directory. Keep Realtime only as an explicit tested compatibility path; do not silently substitute it for the requested model.
4. Bridge documented client delegation into `packages/opencode/src/kilocode/voice/openai.ts`/task-worker or a versioned successor. Preserve immutable IDs, exact-message cancellation, previous-owner refusal and actual result receipts. Acquire delegated context through the documented contract rather than inventing arguments from notification metadata.
5. Adapt `webview-ui/src/context/openai-voice.ts`, `native-projection.ts`, controls and message types. Input/output captions are independent; generated text is not confirmed playback. Preserve distinct mute, stop-speaking, stop-work and end-call behavior through supported Live controls.
6. Reuse `packages/core/src/kilocode/voice.sql.ts`, `openai-store.ts` and `openai-retention.ts`. Version model/protocol data and migrate old records without adopting work. Late saves stay UPDATE-only. Call closure and task deletion remain distinct.
7. Add authoritative Live duration receipts separately from delegated model/tool costs. Do not turn guessed wall time into invoice evidence. Keep unknown/pending settlement, rate provenance and budget reservations explicit.
8. Route screenshots/images through the supported backend visual path, preserving attachment authorization, identity and grounded result delivery. Do not carry over a claim of native image/video support from Realtime.
9. Use Live's supported context/reconnect lifecycle before inventing warm handoff. Any required local transcript snapshot must be bounded, versioned, provenance-labelled, gap-aware, expired by actual erasure policy and deleted with the task. Historical context must never replay work.
10. Validate actual HTTP/WebSocket/WebRTC adapters and then the packaged extension with an account/microphone. Cover duplicates, reordering, lost acknowledgements, steering during work, permission prompts, cancellation distinctions, expiry, reconnect and cost settlement. Measure conversation quality, acoustic interruption and task correctness separately.

Preserve current `openai-context.ts` parent/directory/revert fences, `openai-prefill.ts` exact acknowledgement and `voice-recovery.ts` dual local/host cleanup gate until equivalent Live behavior is verified. Installed voice still uses `gpt-realtime-2.1`. Do not implement the earlier Realtime-only durable transcript proposal first merely because it is easier. Generated speech is not proof of heard words; spoken confirmation still needs scoped business authorization.

## Requirement-by-requirement remaining work

The following sections retain the full 39-item scope. Related findings and overhauls overlap: implement shared foundations once, then verify each acceptance criterion. Status excerpts are copied from the current progress record and may predate the pending batch above.

### PR-01 — Establish an outcome-led default experience

**Recorded status:** In progress. Outcome-focused Welcome and secondary configuration disclosure use the real mode/model/reasoning selectors. Six Chromium theme/width cases and 163 prompt regressions pass, including scoped shortcuts, rapid-picker focus, and failed-send text/file recovery. Screenshots inspected; remaining surface redesign, forced-color icon contrast and moderated first-success acceptance remain open.

**Implementation and verification:**

1. Finish recommended setup and the first successful task using existing provider/configuration services; keep advanced overrides secondary.
2. Complete composer unavailable-provider, reconnect, denied-access and retained-draft states without adding another settings store.
3. Verify real outcome/attachment/access/start/result interactions, then moderated nontechnical first-success tasks; measure setup abandonment and help needed.

**Source entry points:** [packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx](../packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx), [packages/kilo-vscode/webview-ui/src/components/settings/ProvidersTab.tsx](../packages/kilo-vscode/webview-ui/src/components/settings/ProvidersTab.tsx).

**Original acceptance:** In moderated tasks, a nontechnical colleague can connect or use the recommended setup, submit a task with context, and locate its result without understanding a routing score. Measure time to first success, setup abandonment, and requests for help.

### PR-02 — Make completion an inspectable agreement

**Recorded status:** In progress. Existing editable criteria, retained evidence and human review are now presented as separate guarantees. Optional exact-command bindings require the saved command, explicit normalized directory and successful eligible evidence. The 5199 harness now mounts a production `GoalBannerView` result package and the production criteria editor. Broader semantic acceptance and live packaged visual acceptance remain open.

**Implementation and verification:**

1. Finish a result package linking outcome, artifacts, required checks, caveats and human review.
2. Bind evidence to artifact revisions; invalidate affected checks after edits and preserve previous evidence when criteria change.
3. Test successful but irrelevant commands, changed artifacts and amended criteria; inspect completed tasks in the actual goal/result UI.

**Source entry points:** [packages/opencode/src/kilocode/goal/index.ts](../packages/opencode/src/kilocode/goal/index.ts).

**Original acceptance:** A successful but irrelevant command cannot alone make a configured required check appear satisfied. Opening a completed task reveals the actual artifacts and verification, including explicit unverified aspects.

### PR-03 — Make routine scheduling explicit before activation

**Recorded status:** In progress. Structured creation/editing, absolute date controls, explicit timezone, backend occurrence preview and version-checked confirmation implemented. Real view DOM interactions verified; migration review and full live UI verification remain open.

**Implementation and verification:**

1. Close packaged structured-schedule creation/edit/preview/activation behavior; persist phrase, timezone, recurrence and version together.
2. Preserve rejection and draft state for ambiguous language, missing timezone and concurrent edits; never activate a guessed interpretation.
3. Test Monday/Friday/interval phrases, DST folds/gaps, timezone-less migration, stale preview versions and user-supplied schedule examples.

**Source entry points:** [packages/kilo-vscode/src/kilo-provider/routines.ts](../packages/kilo-vscode/src/kilo-provider/routines.ts).

**Original acceptance:** Monday and Friday remain distinct; interval recurrence is either represented accurately or rejected; ambiguous input never activates silently. Test daylight-saving transitions and examples supplied by actual company users.

### PR-04 — Define a routine's authority in capabilities, not its persona

**Recorded status:** In progress. Brief routines now deny unlisted permission categories; saved tool wildcards cannot enable shell, browser actions or delegation. Creation/access review explains broad full access and the lack of OS confinement. Targeted policy, scheduler and rendered view tests pass. Per-path/service grants, trusted-plugin confinement and full dispatch acceptance remain open.

**Implementation and verification:**

1. Add enforceable readable/writable paths, external service grants and action/approval capabilities independently of persona.
2. Propagate authority through delegation, plugins/MCP, browser actions and bridges; deny unlisted categories in narrow profiles and disclose unsupported Windows confinement.
3. Try mutation through each alternate category and child task; verify explicit recorded escalation and no silent widening of an approved run.

**Source entry points:** [packages/opencode/src/kilocode/task/index.ts](../packages/opencode/src/kilocode/task/index.ts), [packages/kilo-sandbox/src/backend.ts](../packages/kilo-sandbox/src/backend.ts).

**Original acceptance:** A routine configured for read-only work cannot mutate through an alternate tool category. Permission changes are visible and recorded. Tests cover direct tools, delegated tasks, plugin tools, and browser actions where supported.

### PR-05 — Make spending understandable and bounded where needed

**Recorded status:** In progress. Provenance-aware model cost views are installed; exact-window/project usage summary copy and retry controls are implemented with focused tests. Cross-child budget reservations, overrides and full billing coverage remain open.

**Implementation and verification:**

1. Implement one parent/child budget: atomically reserve before admission, reconcile immutable receipts and retain uncertain reservations after lost replies.
2. Define pause and attributable override behavior; preserve rate-backed estimates and unknown-price coverage in goal, routine and usage consumers.
3. Test concurrent children at the limit, retries, late usage, failed admission and restart; assert no double debit and no unknown-as-zero totals.

**Source entry points:** [packages/opencode/src/kilocode/session/project-usage.ts](../packages/opencode/src/kilocode/session/project-usage.ts), [packages/opencode/src/session/session.ts](../packages/opencode/src/session/session.ts).

**Original acceptance:** Missing price data renders as unavailable, not free. A run's limit applies across its children, and an override is attributable. Exercise unknown pricing, late usage, retries and partial failures.

### PR-06 — Publish a supported-client and feature matrix

**Recorded status:** In progress. Source-backed client/platform/feature matrix and README entry point added. Company support ownership, non-Windows rollout and full client acceptance remain open.

**Implementation and verification:**

1. Review and finish the pending support-contract batch above; CI, release targets and notes must use that same contract.
2. Keep exact source-pinned matrix references and distinguish configured build targets from verified installations.
3. Test identity/editor/target/runner/asset drift; verify the actual installer on every certified OS and record company support ownership.

**Source entry points:** [packages/kilo-jetbrains](../packages/kilo-jetbrains), [packages/extensions](../packages/extensions).

**Original acceptance:** A colleague can identify the correct installer and expected features without reading source. CI and release notes use the same support matrix.

### EN-01 — Gate destructive session migration on an explicit upgrade policy

**Recorded status:** In progress. Transactional recovery archive and CLI export verified; deployed-version lineage and rollout policy remain open.

**Implementation and verification:**

1. Inventory shipped database generations and encode which upgrade paths preserve data or permit an explicitly approved reset.
2. Keep backup capture and destructive transition in the same transaction; finish recovery restore/import with actual old-version fixtures.
3. For each supported predecessor, compare history/workspace/artifacts before and after, interrupt migration, then restore the backup; never use user data.

**Source entry points:** [packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts](../packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts).

**Original acceptance:** Every supported upgrade preserves the agreed data or explicitly records the approved reset condition. An automated fixture verifies pre/post history, workspace references and recoverability.

### EN-02 — Give routines atomic execution ownership and restart semantics

**Recorded status:** In progress. Overlap exclusion, startup claims, schedule versions and immutable trigger evidence implemented. Transactional occurrence store, migration and timer runner integration implemented. Automatic goal resume/retry checks queue ownership. Interrupted-start recovery, atomic execution fencing, full transaction boundaries and lifecycle semantics remain open. A loaded contention test timed out; its isolated rerun passed.

**Implementation and verification:**

1. Finish durable queued/claimed/running/waiting/paused/terminal ownership with immutable occurrence IDs and stale-worker generations.
2. Use one transactional overlap policy for manual, timer and event triggers; reconcile abandoned claims idempotently on startup.
3. Race real processes sharing a database and kill at claim/session/history boundaries, including waiting-for-user runs; an in-process mutex is insufficient.

**Source entry points:** [packages/opencode/src/kilocode/task/index.ts](../packages/opencode/src/kilocode/task/index.ts), [packages/opencode/src/kilocode/task/runner.ts](../packages/opencode/src/kilocode/task/runner.ts), [packages/core/src/session/run-coordinator.ts](../packages/core/src/session/run-coordinator.ts).

**Original acceptance:** Simultaneous manual/timer/event triggers follow the declared policy; waiting for a user does not create unintended duplicate work. Kill/restart at each claim/session/history boundary and verify exactly the expected recoverable runs.

### EN-03 — Implement timezone and event-filter semantics end to end

**Recorded status:** In progress. Stored timezone evaluation, exact event filters and read-only forecasts verified. Legacy calendars without a timezone now hold automatic admission until explicit review; queued rows and history remain preserved. CLI, real queue migration and actual editor checks pass. Deployed event and full packaged acceptance remain open.

**Implementation and verification:**

1. Finish deployed timezone/filter/catch-up acceptance using the same evaluator for UI preview and execution.
2. Store scheduled occurrence separately from start time and preserve the review hold on legacy timezone-less schedules.
3. Run the same routine under different host zones; cover DST, sleep/resume, missing/mismatched event filters, queued edits and restart.

**Source entry points:** [packages/opencode/src/kilocode/task/index.ts](../packages/opencode/src/kilocode/task/index.ts), [packages/opencode/src/kilocode/task/cron.ts](../packages/opencode/src/kilocode/task/cron.ts).

**Original acceptance:** The same routine produces the same intended local occurrences on hosts in different zones. Missing/mismatched event filters do not trigger it. Sleep/resume follows the stated catch-up policy.

### EN-04 — Acknowledge review actions before dismissing them

**Recorded status:** In progress. Correlated editor/chat acknowledgement and delivery, saved retry identities, atomic backend receipts, inherited Keep boundaries, and manual-edit preconditions verified. Uncertain-outcome reconciliation, cross-process workspace transactions, retention, and live/packaged validation remain open.

**Implementation and verification:**

1. Reconcile uncertain Keep/Undo outcomes from authoritative receipts after lost acknowledgements; preserve request ID on retry.
2. Keep session/directory/file/revision immutable throughout; finish independent-writer transaction coverage and a receipt-retention policy that preserves idempotency.
3. Drop a successful reply, switch tasks/restart, retry and concurrently edit the file; inspect filesystem state and actual editor/chat dismissal.

**Source entry points:** [packages/kilo-vscode/src/edit-review/InEditorReview.ts](../packages/kilo-vscode/src/edit-review/InEditorReview.ts).

**Original acceptance:** Rejected and error-valued responses leave the review available with an actionable error. Switching sessions mid-request never updates the wrong session. Retrying is idempotent.

### EN-05 — Identify reviewed content by revision, not line positions

**Recorded status:** In progress. Content and persisted patch-generation fingerprints, stale-command rejection, Keep acceptance hydration, historical Undo hydration, and deletion/rename anchors verified in targeted tests. Chat now offers Keep/Undo on apply_patch and multiedit files, including deletions and renames. Opening a reviewed path that is gone on disk loads a virtual editor buffer with the deleted text and the same Keep/Undo CodeLens. Packaged live interaction in a real VS Code session remains open.

**Implementation and verification:**

1. Finish packaged live VS Code interaction with a renamed or deleted buffer after reload.
2. Preserve acceptance across unrelated line shifts but reject stale content revisions; make deletion-only actions discoverable.
3. Change the same lines twice, rename/edit/delete, reopen and undo historical work; inspect anchors, Keep boundaries and focus.

**Source entry points:** [packages/kilo-vscode/src/edit-review/InEditorReview.ts](../packages/kilo-vscode/src/edit-review/InEditorReview.ts).

**Original acceptance:** A second change to the same lines reopens review; deletion-only and renamed-file changes remain discoverable; stale actions are rejected or refreshed safely.

### EN-06 — Preserve the last working canvas across failed updates and restarts

**Recorded status:** In progress. Candidate/render identity, durable current/previous records, retention, restart/late-error recovery, draft repair, and local-edit preservation implemented and covered by targeted tests. Independent-writer/crash reconciliation, saved-manifest corruption recovery, and live/packaged verification remain open.

**Implementation and verification:**

1. Finish independent-writer canvas promotion and crash/corrupt-manifest recovery using immutable candidate/current/previous identities.
2. Promote only coherent source/data/bundle revisions after render acknowledgement; preserve manual edits and inspectable failed candidates.
3. Crash at write/build/render/promote boundaries, race owners and deliver late errors; restart must show the last good artifact.

**Source entry points:** [packages/kilo-vscode/src/services/canvas/canvas-compiler.ts](../packages/kilo-vscode/src/services/canvas/canvas-compiler.ts), [packages/kilo-vscode/src/services/canvas/canvas-panel.ts](../packages/kilo-vscode/src/services/canvas/canvas-panel.ts).

**Original acceptance:** Syntax errors, runtime errors, late messages and extension restart leave the last working artifact accessible. A failed candidate is inspectable without becoming the committed version.

### EN-07 — Use explicit compatibility contracts during the runtime migration

**Recorded status:** In progress. Added a versioned capability manifest following existing optional server authentication and connection-specific pre-mutation support checks for command-bound goal edits. Unsupported or replaced backends preserve the draft. Actual auth, SDK regeneration and affected package typechecks pass; broader feature/event and client-version contracts remain open.

**Implementation and verification:**

1. Expand capability negotiation from goal checks to other new mutation/event surfaces and publish endpoint ownership across runtime generations.
2. Keep conversions narrow, explicit omissions documented and generated SDKs authoritative; unavailable features must preserve drafts.
3. Run supported client/backend contract pairs, unknown events, missing capabilities, stale connections and generated-drift checks.

**Source entry points:** [packages/protocol/src/api.ts](../packages/protocol/src/api.ts), [packages/client/src/contract.ts](../packages/client/src/contract.ts).

**Original acceptance:** Each supported client has a contract suite against its supported backend. Unknown events are safely handled, required features fail clearly when unavailable, and generated outputs are checked for drift.

### EN-08 — Repair schema regression checks and isolate contract-test state

**Recorded status:** Verified. Named contract manifests, Windows paths, and automatic temporary state isolation; schema 17, client 16, core migration 27 tests pass. All three package typechecks pass.

**Implementation and verification:**

1. Preserve the repaired manifest identities and isolated test initialization; do not replace semantic checks with updated counts.
2. Revalidate the recorded Verified status on supported-platform CI when related contracts change.
3. Schema/client suites must avoid real user state on Windows/Linux and still fail on intentional event removal or incompatible payload changes.

**Original acceptance:** Schema and client suites pass on supported Windows/Linux environments with no writes to real user state. Deliberate event removal or incompatible payload change still produces a clear failure.

### EN-09 — Harden the update path and credential storage

**Recorded status:** In progress. Release eligibility, SecretStorage migration, exact platform filenames, bounded streamed downloads, SHA-256 verification, credential-safe redirects, and temporary staging tested. VSIX internal identity, bounded release-response validation/pagination, and persistent installation intent are also tested. Credential lifecycle edges, cross-window ownership, actual interruption/rollback, clean dependency installation, and packaged validation remain open.

**Implementation and verification:**

1. Finish cross-window update ownership with one persistent exact source/asset/hash/version install intent.
2. Reconcile restart before retrying; complete credential revocation/migration edges and rollback to the prior working artifact.
3. Test competing installers, wrong identity/platform, truncated downloads, revoked credentials, integrity failure and interruption; independently verify installed version.

**Source entry points:** [packages/kilo-vscode/src/services/update-checker.ts](../packages/kilo-vscode/src/services/update-checker.ts).

**Original acceptance:** Prerelease ordering, unrelated tags, wrong-platform assets, truncated downloads, verification failure, revoked credentials and interrupted installation have deterministic safe outcomes. No new token is written to settings.

### EN-10 — Specify the supported local-service security topology

**Recorded status:** In progress. Managed extension launch pins loopback, ephemeral port and disabled discovery. Media JSON control requests now have a 1 MiB cap and HTTP read/write/header/idle deadlines; real boundary and incomplete-body tests pass. Broker, media callback and context delivery now refuse credential/context redirects with real local HTTP coverage. Companion rebuild, media authentication, initial destination validation and handler/resource lifecycle limits remain open.

**Implementation and verification:**

1. Finish explicit managed-local versus remote trust contracts and authenticated media control before remote exposure.
2. Validate initial destinations and redirects; bound admission, request bodies and lifecycle resources; rebuild the companion when its maintained code changes.
3. Exercise bad credentials, malicious destination, oversized/incomplete bodies and teardown; directory routing must not be presented as tenant isolation.

**Source entry points:** [packages/server/src/auth.ts](../packages/server/src/auth.ts), [services/raya-mf/cmd/raya-mf/main.go](../services/raya-mf/cmd/raya-mf/main.go).

**Original acceptance:** Supported launch paths bind and authenticate as documented. A configuration that exposes an unsupported unauthenticated service is rejected or requires an explicit supported setup. Cross-directory isolation is tested independently from authentication.

### EN-11 — Give browser identity and captured authentication a lifecycle

**Recorded status:** In progress. Workspace-owned profiles, explicit capture/restore/delete, seven-day expiry, persisted authentication provenance and reset/recovery controls implemented. Native Chromium checks cover storage replacement, restart, expiry, active capture deletion and competing owners. Windows recased drive-letter and user-name spellings of the same folder now pass the storage-identity guard; a junction or symlink that redirects the folder still refuses. Final host/package validation and broader acceptance remain open.

**Implementation and verification:**

1. Finish packaged browser profile/capture/reset/expiry ownership and cleanup.
2. Prevent active contexts or competing owners from restoring deleted/expired authentication across workspaces.
3. Use actual Chromium storage/cookies, two owners, active deletion, expiry and restart; verify packaged host behavior and scope isolation.

**Source entry points:** [packages/kilo-vscode/src/services/browser-automation/browser-session.ts](../packages/kilo-vscode/src/services/browser-automation/browser-session.ts), [packages/kilo-vscode/src/services/browser-automation/browser-smoke.ts](../packages/kilo-vscode/src/services/browser-automation/browser-smoke.ts).

**Original acceptance:** Expired login, profile lock, missing browser, restart and takeover all give actionable recovery. Deleting captured authentication removes the intended persisted files and subsequent runs cannot reuse them.

### EN-12 — Make media failures observable and session ownership atomic

**Recorded status:** In progress. Active SpeechService broker reserves ownership before admission, suppresses late ready after Stop and retains uncertain teardown without replay. Synthetic HTTP tests and actual VoiceProvider fixture pass. Production microphone, provider termination and latency acceptance remain open.

**Implementation and verification:**

1. Preserve reservation-before-admission and exact cleanup ownership during the GPT-Live migration.
2. Model connecting/live/stopping/failed/uncertain teardown; distinguish speech interruption from parent-work cancellation.
3. Run real microphone denial/removal, network loss, provider termination and repeated Start/Stop; prove no second owner during uncertain cleanup and measure latency.

**Source entry points:** [services/raya-mf](../services/raya-mf).

**Original acceptance:** Duplicate starts allocate one owned session; disconnect/reconnect does not leak rooms or goroutines; interruptions stop the intended speech; engine/room failures produce a specific recovery action. Run the service tests in a known-good Go environment before release claims.

### EN-13 — Treat recordings and telemetry as separate data products

**Recorded status:** In progress. Added a local diagnostic summary with allowlisted fields and minimized snapshot identity; synthetic export checks pass. Removed telemetry console disclosure before opt-out; actual calling-boundary HTTP tests pass. Outbound consent synchronization, property policy, recorder-format acceptance and retention remain open.

**Implementation and verification:**

1. Finish the pending recorder/transport batch. Then add acknowledged receiving-side consent ordering and capture generation checks; stale enable must not override newer opt-out.
2. Define reconnect/multi-client ownership, inventory outbound properties and apply versioned allowlists. Establish destination retention/deletion and separate recording/export consent.
3. Use actual receiver/outbound synthetic transports for reordered controls, failures, queued events and identity updates; preserve safe cassette bytes and secret-free errors.

**Source entry points:** [packages/http-recorder/src/redaction.ts](../packages/http-recorder/src/redaction.ts), [packages/http-recorder/src/redactor.ts](../packages/http-recorder/src/redactor.ts), [packages/kilo-telemetry/src/client.ts](../packages/kilo-telemetry/src/client.ts), [packages/kilo-telemetry/src/identity.ts](../packages/kilo-telemetry/src/identity.ts).

**Original acceptance:** A documented diagnostic bundle contains only approved fields; synthetic secrets are removed across supported formats; opt-out behavior is verified at the calling boundary, not just in the telemetry library.

### EN-14 — Measure recovery and streaming performance across client boundaries

**Recorded status:** In progress. Routine refresh now coalesces bursts, cancels obsolete client/directory reads, bounds deadlines and preserves explicitly stale partial history. Actual SDK/HTTP workload: 40 routines plus 100 invalidations produces 84 reads/max two concurrent; rendered comparison/recovery checks pass. Repair source copying now uses bounded batches with integrity/failure-drain coverage; a local 1,003-file benchmark reduces median copy time 16.56%. O(N) per-cycle reads, aggregate summaries and general streaming/reconnect performance budgets remain open.

**Implementation and verification:**

1. Add aggregate routine/history queries where current O(N) reads dominate; retain cancellation, coalescing and honest stale-state display.
2. Set measured budgets for streaming rendering, reconnect recovery and bounded queues using representative histories.
3. Record dataset size, request/concurrency counts and latency distributions before/after with the same real workload; avoid tiny-fixture performance claims.

**Source entry points:** [packages/core/src/session/run-coordinator.ts](../packages/core/src/session/run-coordinator.ts).

**Original acceptance:** Large histories and multiple active sessions remain responsive under an agreed workload; reconnect reconciles authoritative state without duplicate messages or stuck spinners; routine refresh request volume is bounded and measured.

### EN-15 — Make release confidence reproducible across the fork

**Recorded status:** In progress. Windows path normalization repaired in the Promise-facade guard; classified the existing real HTTP routine fixture with an exact reference count. Cross-package/snapshot checks are recorded per checkpoint. Broader reproducible release coverage remains open.

**Implementation and verification:**

1. Complete reproducible fork release gates around schema/annotation/facade/support contracts and pinned tooling/source.
2. Ensure CLI, SDK and extension artifacts derive from the same reviewed commit; distinguish baseline failures from introduced regressions.
3. Run normal push hooks and production packaging, clean-install checks, archive/hash inspection and independent installed-version checks on supported platforms.

**Original acceptance:** A maintainer can reproduce the required release checks from documented commands; every required workflow has a usable runner; the release evidence identifies exactly what was and was not exercised.

### UX-01 — Match review labels to action scope

**Recorded status:** In progress. Keep file / Undo file labels and scope tooltips implemented. File-level summary includes additions and deletions. Concurrent-edit acceptance and live interaction validation remain open.

**Implementation and verification:**

1. Finish actual review-scope interactions across editor/chat with file-level labels, counts and revision-bound tooltips.
2. Keep pending/failure states and selected review; never imply line-only scope for a whole-file action.
3. Test partial selection, mixed additions/deletions and concurrent edits; verify file scope, retry, dismissal and focus return.

**Source entry points:** [packages/kilo-vscode/src/edit-review/patch-ranges.ts](../packages/kilo-vscode/src/edit-review/patch-ranges.ts), [packages/kilo-vscode/src/edit-review/InEditorReview.ts](../packages/kilo-vscode/src/edit-review/InEditorReview.ts).

**Original acceptance:** Users correctly predict what a click changes. Two-hunk, deletion-only, concurrent edit and stale patch scenarios preserve unaffected work according to the declared scope.

### UX-02 — Present progress as current work and next decision

**Recorded status:** In progress. Paused/blocked next action and plan-task hierarchy implemented; activity counts disclosed separately. Rendered fixtures pass; live visual and workflow acceptance remain open.

**Implementation and verification:**

1. Complete progress views as current work, verified outcomes and next decision across goals/plans/routines.
2. Keep activity counts distinct from completion and paused/blocked distinct from failed; make next actions clear without hiding detail.
3. Exercise real running/waiting/paused/blocked/completed tasks, reconnect and late updates in both themes/narrow layouts with keyboard navigation.

**Original acceptance:** In a five-second scan, users can explain what Raya is doing, whether they must act, and how to stop it. Paused, waiting and blocked states are distinguishable without relying on color.

### UX-03 — Use a consistent interruption and recovery vocabulary

**Recorded status:** In progress. Typed routine errors preserve specific causes and provide recovery guidance across routine views. Output conflicts offer a correlated read-only comparison and retain the draft until explicit save. Focused unit, real HTTP and rendered-view checks pass; broader cross-surface recovery vocabulary remains open.

**Implementation and verification:**

1. Apply one typed recovery vocabulary across chat, routines, voice, browser, canvas, history, settings and repair.
2. Map each cause to a specific safe action, preserve drafts and distinguish known versus uncertain execution; retry must not silently replay work.
3. Trigger network/auth/conflict/permission/cancellation/stale-version failures per surface and verify both copy and actual recovery behavior.

**Source entry points:** [packages/kilo-vscode/src/kilo-provider/routines.ts](../packages/kilo-vscode/src/kilo-provider/routines.ts).

**Original acceptance:** Invalid schedules, denied capabilities and network errors receive different correct guidance. Dismissal is never interpreted as successful completion. Restart/reconnect returns users to the pending decision.

### UX-04 — Expose context provenance and control where work happens

**Recorded status:** In progress. Actual transcript now exposes recorded startup/recall receipts with bounded sources, preserved preparation time and verified startup project/worktree scope where available. Legacy counts/time/scope remain explicitly unrecorded; snippets stay hidden. Metadata, backend and real component checks pass. Historical inspection/correction ownership, attached/indexed provenance and indexing status remain open.

**Implementation and verification:**

1. Complete attached/recalled/indexed/prepared context provenance and explicit correction/removal ownership.
2. Expose freshness and scope without leaking hidden snippets; connect indexing and historical inspection to bounded startup receipts.
3. Test legacy missing metadata, stale index, changed worktree, removed attachment and corrected memory through actual transcript controls.

**Source entry points:** [packages/kilo-vscode/webview-ui/src/components/settings/ContextTab.tsx](../packages/kilo-vscode/webview-ui/src/components/settings/ContextTab.tsx), [packages/kilo-indexing/src/indexing/orchestrator.ts](../packages/kilo-indexing/src/indexing/orchestrator.ts).

**Original acceptance:** Users can identify and correct the source of a stale remembered fact. Disabled or failed indexing is not presented as an empty but healthy index. A worktree switch shows the correct scope.

### UX-05 — Make history a route back to work, not just a list

**Recorded status:** In progress. Correlated cloud-history replies, scoped errors, retry, retained rows and active selection are implemented. Actual rendered checks pass 36 assertions, including displaced row-focus restoration and stale replies. Cloud previews now disclose host-owned destinations, retain failed drafts/attachments, and preserve known/uncertain import outcomes with per-host reservations. Final HTTP/correlation15 tests52 assertions and two actual composer theme cases pass. Cross-process idempotency, revision pinning, journal reset/new-copy UX and project/result/action metadata remain open.

**Implementation and verification:**

1. Finish cross-process idempotent cloud import with revision-pinned source identity and retained outcome journal.
2. Add explicit reset/new-copy UX for ambiguity and enrich history with project/result/next-action metadata.
3. Drop replies after commit, race hosts, edit cloud source and restart; preserve drafts/files/selection and verify exact destination without duplicates.

**Source entry points:** [packages/kilo-vscode/webview-ui/src/components/history/HistoryView.tsx](../packages/kilo-vscode/webview-ui/src/components/history/HistoryView.tsx).

**Original acceptance:** Users can find an interrupted task, determine its project and resume safely. Failed import and unavailable worktree states preserve the item with a clear explanation.

### UI-01 — Test real components in the visual harness

**Recorded status:** In progress. Preview labels distinguish production from illustrative fixtures. Memory, routines, composer, history, review, slash, topnav, transcript, conversation, result, and criteria-editor now use real components in the 5199 harness. Thirty-seven Chromium checks pass. Live packaged visual acceptance remains open.

**Implementation and verification:**

1. Replace remaining illustrative composer/history/review/result previews with real components and narrow fixture adapters.
2. Label any remaining demos and avoid maintaining parallel markup disconnected from production.
3. Render real loading/empty/error/retry/busy/long-content states; verify interactions and inspect screenshots.

**Original acceptance:** A production markup/style change appears in the corresponding preview. The visual report identifies real versus illustrative components and never attributes a fixture-only failure to production.

### UI-02 — Establish measurable accessibility gates

**Recorded status:** In progress. Memory receipt browser gate covers two themes, 320/460px widths, keyboard disclosure, focus outline, label separation, overflow and scoped automated rules. Full surface, assistive-technology, high-contrast and zoom acceptance remain open.

**Implementation and verification:**

1. Extend semantics, keyboard order, focus return/visibility, contrast, zoom, reduced motion and forced-color gates to every named surface.
2. Add actual assistive-technology acceptance; automated accessibility rules are necessary but insufficient.
3. Test light/dark, narrow/wide and 200% zoom; exercise dialogs/forms/live status/virtualized history with keyboard and screen reader.

**Original acceptance:** Every primary action is keyboard-operable and visibly focused; dialogs restore focus; asynchronous errors/status are announced appropriately; supported narrow layouts and zoom remain usable. Automated checks supplement, not replace, manual validation.

### UI-03 — Consolidate component semantics while preserving host-specific styling

**Recorded status:** In progress. Destructive buttons share a Kilo-owned semantic variant across four confirmations. Nine Chromium cases pass across focused runs for Cancel-first focus, narrow translated labels, Escape return and owned-dialog disposal. Broader component consolidation and full assistive-technology acceptance remain open.

**Implementation and verification:**

1. Consolidate remaining dialog/button/form/disclosure/status semantics in Kilo-owned primitives while preserving host theme/layout behavior.
2. Migrate usages incrementally without globally restyling inherited clients.
3. Check destructive/default/Cancel distinctions, Escape, focus return, translations and busy/disabled states for every migrated use.

**Original acceptance:** Equivalent actions have consistent meaning, naming and disabled/pending behavior across supported clients. A small component matrix covers themes, sizes, focus, loading, error and long translated labels.

### OVR-01 — OpenAI native realtime multimodal voice

**Recorded status:** In progress. Native OpenAI WebRTC and trusted sideband use the parent conversation. Semantic VAD, distinct controls, images, narration, interrupted captions and usage receipts are installed. Current checkpoint adds acknowledged saved task context and explicit same-task restart with dual cleanup ownership. Durable spoken snapshots, warm handoff, live account/microphone quality, spoken decisions and full realtime accounting remain open.

**Implementation and verification:**

1. Prioritize the GPT-Live 1 migration described above. Read the official client delegation contract before editing; preserve one parent task, execution permissions, durable receipts and cancellation ownership.
2. Adapt session startup, continuous audio, independent transcript streams, controls and duration accounting. Do not treat a model-name substitution as a migration or transcript generation as proof of playback.
3. Verify the real protocol and packaged microphone path, overlapping speech, interruption, reconnect, task switches and permission waits. Record acoustic quality acceptance separately from automated protocol checks.

**Source entry points:** [SpeechService](../packages/kilo-vscode/src/speech/service.ts); [RealtimeVoice](../packages/kilo-vscode/webview-ui/src/context/realtime-voice.ts); [voice protocol](../packages/opencode/src/kilocode/voice/protocol.ts); [voice service](../packages/opencode/src/kilocode/voice/service.ts); [Official model documentation](https://developers.openai.com/api/docs/models/gpt-realtime-2.1); [WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc); [Server-side controls](https://developers.openai.com/api/docs/guides/realtime-server-controls); [Conversation lifecycle and interruption guide](https://developers.openai.com/api/docs/guides/realtime-conversations)

### OVR-02 — A first-class browser skill for agents

**Recorded status:** In progress. Browser skills, stable tab/frame targeting, dialogs, durable downloads and authorized uploads are installed and checkpoint-tested. Upload checks cover staged-byte ownership, destination targeting, lost acknowledgements and restart; file selection does not establish server acceptance. The profile-storage identity guard now treats Windows case and long-path spelling as the same folder and still refuses redirected junctions. Full model-driven workflow evaluation remains open.

**Implementation and verification:**

1. Complete browser skill playbooks using stable tab/frame identities, dialogs, downloads and uploads. Each workflow must observe, act and verify within the granted authority.
2. Connect these playbooks to actual model execution and retain evidence of the resulting page or server state, including stale observations and authentication boundaries.
3. Run held-out workflows with real agents and browser peers. File selection alone is not upload acceptance; verify server receipt and rejection paths.

**Source entry points:** [browser protocol](../packages/opencode/src/kilocode/browser/protocol.ts); [Playwright locator documentation](https://playwright.dev/docs/locators)

### OVR-03 — Smarter Auto routing and orchestration

**Recorded status:** In progress. Exact configured model/variant selection, same-provider implicit Auto fallback, and refusal before child/session mutation implemented. All 40 targeted cases have passing evidence across combined and isolated runs; CLI types pass. Actual AI SDK permission-aware tool correction passes separately. Actual Task invocations now retain model/variant selection sources; 29 real backend cases, eight consumer cases and two Chromium rendering cases pass. Routing quality, route correlation, original capability provenance and held-out evaluation remain open.

**Implementation and verification:**

1. Separate user intent, model capabilities, delegation choices and execution authority. Persist route correlation and the original capability provenance.
2. Build held-out tasks and compare successful outcomes, latency, cost and unnecessary delegation against the existing baseline.
3. Exercise actual model permission and tool paths, including unavailable capabilities, fallback and cancellation. Avoid routing heuristics that silently broaden authority.

**Source entry points:** [Chief routing](../packages/opencode/src/kilocode/chief/index.ts); [Tool-model selection](../packages/opencode/src/kilocode/chief/tool-model.ts)

**Original acceptance:** Simple tasks can complete directly; complex tasks produce appropriate bounded plans; manual choices remain honored; no recovery widens authority; model outages do not cause an unbounded reroute loop; successful routing is demonstrated by better held-out outcomes, not higher self-reported confidence. Roll out in shadow mode first, then opt-in, then default after evidence.

### OVR-04 — Calculated, explainable token and tool costs

**Recorded status:** In progress. Persisted accounting provenance, rate evidence, extension disclosure, TUI, direct-run and CLI stats are installed. Current checkpoint adds immutable native voice token/duration receipts and incomplete-observation disclosure. Voice pricing, reservations, historical recovery, modality/tool reconciliation and remaining budget/export consumers are open.

**Implementation and verification:**

1. Complete a normalized cost ledger with provider-reported amounts, versioned rate estimates and explicitly unavailable amounts. Preserve provenance and coverage in every consumer.
2. Account for GPT-Live duration separately from backend model tokens and tools. Add reservations and reconciliation without counting duplicate or late receipts twice.
3. Test cache/context/reasoning usage, refunds, late events, concurrent reservations and exports. Surface partial coverage rather than a misleading complete total.

**Source entry points:** [session.ts:417](../packages/opencode/src/session/session.ts); [Realtime cost guide](https://developers.openai.com/api/docs/guides/realtime-costs); [project usage query](../packages/opencode/src/kilocode/session/project-usage.ts)

**Original acceptance:** Test cache-inclusive usage, reasoning-inclusive output, context tiers, zero versus missing prices, custom rates, provider-reported zero, audio/image buckets, tool fees, retries, late events, historical rate changes, credit units and parent/child aggregation. Every displayed estimate must be reproducible from the stored ledger and rate version. Add a UI disclosure explaining the calculation without requiring users to read SQL or token schemas.

### OVR-05 — A durable, understandable routine system

**Recorded status:** In progress. Structured scheduling and durable occurrence/ownership work are implemented as recorded below. Full routine lifecycle, policy and UI acceptance remain open.

**Implementation and verification:**

1. Finish routine creation, permissions, schedules, durable occurrences, ownership fencing, missed-run policy, restart recovery and result history.
2. Connect notifications and company history to durable occurrence identity; define behavior for disabling or archiving a routine with work in flight.
3. Exercise create/edit/disable/archive, manual/timer/event runs, permission waits, crashes and conflicting outputs through actual UI and runtime boundaries.

**Source entry points:** [task schemas](../packages/opencode/src/kilocode/task/index.ts); [runner](../packages/opencode/src/kilocode/task/runner.ts); [RoutinesView](../packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx)

### OVR-06 — An outcome-driven Goal system

**Recorded status:** In progress. Goal ownership, continuation, review/evidence and repair completion have targeted and checkpoint verification. The full outcome-driven lifecycle and UI acceptance remain open.

**Implementation and verification:**

1. Complete outcome criteria, artifacts, decomposition and steering while preserving historical evidence. Share continuation ownership and budget accounting.
2. Keep current relevant evidence distinct from human acceptance; failure learning must not silently rewrite the requested goal.
3. Verify concurrent owners, criteria edits, restart, budget exhaustion, cancellation and review through the actual lifecycle and UI.

**Source entry points:** [goal implementation](../packages/opencode/src/kilocode/goal/index.ts); [Continuation](../packages/opencode/src/kilocode/goal/continuation.ts)

### OVR-07 — Complete Raya UI and UX redesign

**Recorded status:** In progress. Outcome-focused Welcome and secondary configuration disclosure use the real mode/model/reasoning selectors. Six Chromium theme/width cases and 163 prompt regressions pass, including scoped shortcuts, rapid-picker focus, and failed-send text/file recovery. Screenshots inspected; remaining surface redesign, forced-color icon contrast and moderated first-success acceptance remain open.

**Implementation and verification:**

1. Redesign and verify each remaining surface: navigation, composer, AskCard, ThinkingThoughts, goals/plans, routines, review/results, history, memory/index, providers/settings, browser/canvas, voice and repair.
2. Use production actions and real loading, empty, error, pending and recovery states. Keep a surface acceptance matrix rather than extrapolating from Welcome screenshots.
3. Cover host themes, narrow widths, zoom, long translations, keyboard and assistive technology; inspect rendered screenshots and record remaining moderated usability acceptance.

**Source entry points:** [designer.md](designer.md); [eden.css](../packages/kilo-vscode/webview-ui/src/styles/eden.css)

### OVR-08 — Broad work tools with discoverable capabilities

**Recorded status:** In progress. Added bounded local-work discovery from known builtin identities after final turn filtering; no authority expansion. Actual permission filtering and XLSX-to-Markdown artifact workflow pass four tests/35 assertions. Connected domain packs, deferred schemas, rich artifact generation/export and broader work evaluations remain open.

**Implementation and verification:**

1. Build permissioned domain capability packs for documents, spreadsheets, slides, research and communications, with deferred schemas and explicit input/output contracts.
2. Preserve artifact identity through generation, rendering and export. Missing integrations must produce an actionable unsupported state.
3. Evaluate usable exported artifacts, not only tool invocation. External sending still requires user authorization; capabilities must not bypass existing permissions.

**Source entry points:** [core tools](../packages/core/src/tool); [opencode tools](../packages/opencode/src/tool); [plugins](../packages/plugin); [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

**Original acceptance:** An agent can discover and complete representative research, document, spreadsheet, browser and repository tasks end to end. Test disconnected/expired tools, wrong account, large output, cancellation, duplicate requests, malformed responses and partial mutation. A result links a usable artifact or verified external record. Measure tool-selection accuracy and task completion, not catalog size alone.

### OVR-09 — Self-heal as verified recovery and repair

**Recorded status:** In progress. Captured-source completion now produced a real review artifact with verified archive/CLI hashes and source-check lineage. Fresh read-only inspection exits0; original build helper hit its shutdown watchdog after producing the valid artifact (exit2). Publication/install/rollback/post-install acceptance and full-build cleanup remain open.

**Implementation and verification:**

1. Keep diagnosis, recovery and isolated source repair separate. Preserve the existing captured-source lineage and archive/CLI hash checks.
2. Fix the build-helper shutdown watchdog: producing a valid artifact followed by exit 2 is not a clean build. Then implement reviewed publication, install intent, post-install verification and rollback.
3. Reproduce the original failure after installation and reload before claiming repair success. Archive validity alone does not establish product recovery.

**Source entry points:** [self-heal/index.ts](../packages/opencode/src/kilocode/self-heal/index.ts); [shared/self-heal.ts](../packages/kilo-vscode/src/shared/self-heal.ts); [the refinement tool](../packages/opencode/src/kilocode/tool/self-heal.ts); [KiloProvider.ts](../packages/kilo-vscode/src/KiloProvider.ts)

### OVR-10 — Browser runtime and product overhaul

**Recorded status:** In progress. Tab/frame identity, manual control, dialogs, durable downloads and authorized uploads are installed and checkpoint-tested. Real Chromium upload coverage includes 40 MiB files, delayed submission, server rejection, frames and multiple/empty files. Selection remains distinct from submission acceptance. Workspace profile roots survive Windows recasing and still refuse redirected storage. Full runtime/product workflow acceptance remains open.

**Implementation and verification:**

1. Complete persistent browser profiles, stable tab/frame ownership, manual/agent handoff, reliable observations and the remaining audited capabilities.
2. Connect user controls and model playbooks to the same ownership and authorization state, including restarts and stale navigation.
3. Verify actual Chromium and packaged-host dialogs, popups, frames, downloads/uploads, authentication, destructive actions and owner transitions.

**Source entry points:** [BrowserSession](../packages/kilo-vscode/src/services/browser-automation/browser-session.ts); [panel](../packages/kilo-vscode/src/services/browser-automation/browser-panel.ts); [bridge](../packages/kilo-vscode/src/services/browser-automation/browser-bridge.ts); [smoke service](../packages/kilo-vscode/src/services/browser-automation/browser-smoke.ts)

## Codex architecture review and adaptation backlog

The user explicitly requested inspection of the open-source Codex architecture. Initial source review on 2026-09-10 confirms the official [OpenAI Codex repository](https://github.com/openai/codex), whose root identifies an Apache-2.0 license. This is an initial adaptation backlog, not a claim that the entire repository has been reviewed or ported. Before copying code, pin a commit and inspect its LICENSE and NOTICE, record provenance, and assess Rust-to-TypeScript/Effect integration costs.

The inspected [app-server source documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) describes request-scoped cancellation, owner-controlled internal workers, typed failure envelopes, and durable thread attachments with idempotent identities and lifecycle exclusion. These patterns suggest the following Raya work; the proposed implementation is our inference, not a claim that Codex already solves Raya's requirements.

1. **Cancellation and late results (EN-02, EN-12, OVR-01, OVR-06).** Trace Raya's operation IDs from host request through runtime and provider. Define acknowledgement as receipt of a cancellation signal, separately from worker termination. Fence late results with owner/generation identity, and reject stale commits after cancellation or task deletion. Test cancel-before-start, during execution, after a completed effect, disconnect and reconnect. Preserve completed effects as evidence instead of pretending they were rolled back.
2. **Worker ownership (EN-02, OVR-03, OVR-06).** Inspect Codex's implementation behind the documented internal-worker lifecycle, then compare Raya goal/routine/delegation ownership. Add owner-controlled shutdown and durable fencing where missing. Test concurrent stop/archive/delete against active children and restart recovery; avoid introducing a second competing orchestration runtime.
3. **Artifact associations (EN-04, EN-06, OVR-08).** Adapt the identity and lifecycle pattern to task artifacts: canonical identity, idempotent association, bounded pagination, explicit association removal distinct from deleting an underlying file, and parent-deletion exclusion. First inventory existing Raya artifact tables and receipts so this extends their contracts. Test duplicate creation, absent removal, queued mutation during parent deletion and UI event ordering.
4. **Typed recovery (UX-03, EN-07).** Inventory errors crossing CLI/SDK/host/webview boundaries. Introduce a closed error classification where clients currently inspect message text; preserve private diagnostic detail only in the appropriate local diagnostic channel. Regenerate SDK for public contract changes and verify each recovery action against actual state.
5. **Broader source inspection, still pending.** Pin and inspect actual Codex core execution, app-server protocol generation, sandbox/approval boundaries, tool dispatch, compaction/resume, rollout persistence, skills discovery and eval/test infrastructure. For each candidate record exact source commit/path, Raya counterpart, measured gap, proposed change, license obligations and an acceptance test. Public CLI/app-server source proves those components only; documented desktop/browser behavior can guide Raya UX, but do not claim its uninspected implementation is open source or identical to the CLI. See the deferred research document for the evidence boundary. Prioritize durable lifecycle and permission correctness over importing a second agent framework.

## Verification and delivery instructions

- Read root and touched-package AGENTS.md. Keep new functionality in Kilo-owned boundaries where possible; annotate necessary shared upstream changes. Never modify another checkout.
- **Progress file encoding:** update `Raya-Implementation-Progress.md` with bytes-preserving edits/appends only. This handoff is normal UTF-8 and can be edited normally.
- Do not run root `bun test`. Run CLI tests from `packages/opencode`, extension tests from `packages/kilo-vscode`, and recorder tests from `packages/http-recorder`. Use isolated test state rather than user databases or the installed production backend.
- For extension changes run relevant unit tests, typecheck, lint, knip and the Kilo marker guard. For CLI changes run relevant tests/typecheck and annotation/facade guards. Run workflow and Markdown guards when affected. Regenerate SDK for public endpoint/schema edits; regenerate source links for affected source URL changes.
- Support-contract checks: `bun test script/kilocode/raya-support.test.ts` and `bun run script/kilocode/raya-support.ts`. Inspect the script's CLI before generating release notes.
- Batch broad root lint/type checks and production packaging after a coherent feature batch; retain targeted checks that prevent propagating broken contracts. A normal push runs repository hooks, including cross-package checks. Do not bypass hooks. Inspect Java only if a Java/Gradle failure requires it.
- `.tmp` contains ignored local logs and helper scripts; do not stage it. PowerShell redirected logs may be UTF-16: use Get-Content. Record terminal exit codes, not just successful-looking output.
- The telemetry run 77926 was explicitly stopped with exit 1 after a Bun native HTTP teardown spin. It did not pass. Do not repeatedly restart a spinning fixture: await transport settlement or use a real Node HTTP peer, preserve the production transport and document the failure. The reported support lint handle 85331 no longer exists; its log reports zero errors/warnings, but rerun if a terminal receipt is required.
- Before commit, review the exact staged path manifest and diff. Freeze source during checkpoint production checks. Commit and push normally using standing authorization; do not force push.
- Existing local snapshot helpers are `.tmp/run-voice-retention-snapshot.ps1` and `.tmp/verify-checkpoint-snapshot.ps1`. Inspect before reuse, update checkpoint expectations, validate workspace paths before cleanup, and use isolated build/test state. Run the authorized snapshot install workflow, then independently verify archive hashes, packaged CLI and installed extension identity. Do not force a VS Code reload.

## Sequence and credit-warning handoff

Finish the telemetry fixture and review the pending recorder/support changes first, then verify and deliver that coherent checkpoint. Next prioritize GPT-Live 1 protocol integration while two workers take independent, non-overlapping audit work. Pair browser runtime work with agent playbooks; share budget/receipt foundations across goals, routines and voice; verify product UI alongside the feature it exposes. Do not mark all 39 requirements complete based on a subset of tests.

When the user reports approximately $10 remaining, stop starting broad new work. Settle owned processes and current edits, record exact dirty files, failed checks, live handles, next edit, and commit/push/install state in this document. Preserve safe unfinished work with explicit status. Provide the continuation prompt below with any new immediate blocker inserted.

## Continuation prompt

```text
Continue implementing Raya in C:\Users\User\Desktop\raya. Read AGENTS.md, docs/Raya-Remaining-Implementation-Handoff.md, docs/Raya-Implementation-Progress.md, docs/Raya-Comprehensive-Audit.md and docs/Raya-Voice-Architecture.md first. The scope is all 39 requirements, not just the current batch. Preserve existing uncommitted work and edit the progress file using bytes-preserving operations because it contains mixed encoding.

I authorize root plus two subagents, normal periodic commits/pushes to origin/main, and snapshot builds/reinstallation outside the sandbox without asking again. Do not force push, bypass hooks or force reload VS Code. Batch broad testing at coherent checkpoints, but verify relevant contracts before calling features working. If repeated attempts fail, document the exact cause and next approach, move to independent work and revisit.

First inspect current git/process state against the handoff. Preserve remaining uncommitted telemetry and Codex-deferred files. Live HTTP contracts and the routine inbox conversation UI are the latest verified local increments; do not package Live. Next: follow-up dispatch into the selected worker, then RDM-04. Keep Raya task ownership, permissions, durable receipts and execution authority. Do not replay historical text as new work or claim generated captions prove heard audio.

Defer new Codex-derived implementation until existing Raya work, including GPT-Live and all 39 requirements, is complete. Use the deferred research document later; do not start a new porting track now. Keep the 39-requirement ledger honest. When I warn that credits are near $10, promptly update the full remaining-work handoff, settle the current work and provide an updated continuation prompt.
```

## Latest continuation update

Telemetry transport settlement is now returned to callers. The loopback fixtures await settlement before shutting down their peers; all 13 boundary/utility tests pass with 25 assertions and terminal exit 0. Recorder binary-secret tests pass 37/185. Support-contract tests pass 7/26. These landed in `e74508a063` and `a0024a4f77` and remain on `origin/main`. Receiving-side consent ordering remains open.

The final extension knip and Kilo marker checks also passed (terminal 0), and the Markdown table guard passed. All local Markdown links in this handoff resolve. Root lint handle 82630 stalled and was explicitly stopped with exit 1. The authorized retry outside the sandbox, handle 26906, completed with terminal exit 0. Root lint passes; the first attempt remains a stopped run.

## GPT-Live contract research: concrete next implementation

Research completed against official documentation; no Live code or paid session created yet. Build a separate adapter and preserve existing behavior until the replacement meets its acceptance criteria.

- **Creation and attachment:** replace SDP-only creation/Location parsing with JSON POST `/v1/live/sessions`, supplying `session` and `transport: {type: "webrtc", sdp}`; consume `session.id` and `transport.sdp`. Attach trusted sideband at `/v1/live/sessions/{session_id}/attach`, retaining the opaque ID. Wait for `session.started`, attach before enabling microphone input, and do not assume replay of earlier events. Preserve reservation and parent/directory fences; do not automatically retry session creation. [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live), [sideband](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live).
- **Client authority:** set `session.client.data_channel.allowed_client_events: []`; omission allows all client events. Route mutation commands through the trusted host and expose only required lifecycle/caption events to the webview. Verify denied browser commands against the actual transport. [Creation schema](https://developers.openai.com/api/reference/resources/live/methods/create).
- **Delegation:** configure `delegation: {type: "client"}`. Created events carry delegation ID, target and offset, without task text. Build bounded context from independent transcript streams plus authoritative task state; explicitly handle incomplete fragments and steering revisions. Keep delegation IDs separate from durable operation IDs. Use `session.commentary.append` for verified results and `session.thinking.append` for quiet progress, with delegation correlation and bounded content. Images stay with Raya's vision backend. Do not infer append retry safety from an event ID. [Delegation contract](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client).
- **History and finalization:** adapt the existing bounded `loadVoiceContext()` into startup `session.input`. Replace item/response caption identity with timestamped independent fragments. Register finalization receivers before sending `session.close`, retain them through `session.closed` and its `usage.seconds`, or record a bounded ambiguous failure. Only then dispose transports. Do not enable provider recording merely to obtain fork/recovery. [Session management](https://developers.openai.com/api/docs/guides/live-conversations).
- **Code ownership:** introduce Kilo-owned `live-broker.ts`, context selection and delegation coordination beside existing speech adapters. Version backend protocol/store payloads and reuse parent FK deletion, UPDATE-only saves, immutable admission and cancellation fences. Add a Live projection/transport branch without weakening `voice-recovery.ts` ownership. Keep duration receipts separate from model/tool costs.
- **Outstanding design tests:** stop-speaking needs a deliberate output-muting/resumption policy because no authoritative utterance completion event is available. Confirm retry/ambiguity semantics from the reference. Exercise startup races, duplicate delegation, missing transcripts, stale work results, task switching, disconnect/final usage and zero history replay through real peers. Packaged microphone and acoustic acceptance are separate from protocol tests.

## Pinned Codex findings and implementation recipes

Source review pinned `openai/codex@9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a`. The following are source-backed adaptation candidates, not demonstrated vulnerabilities or completed implementations.

### Compaction checkpoint publication

Codex separates compaction metadata from replacement history, uses stable item identity and preserves authorization history independently of compacted model context. This review does not establish transactionally atomic publication in Codex. Sources: [compact.rs](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/compact.rs), [history.rs](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/context_manager/history.rs).

Raya's `packages/opencode/src/session/compaction.ts` persists summary, retained-tail boundary, replay/continuation messages and parts through separate calls. First reproduce a crash between those calls using actual database fixtures; existing media/chunk recovery must remain intact. Then add a Kilo-owned checkpoint coordinator referencing the source boundary, summary message, retained tail and reserved continuation identity. Publish completion only after referenced records exist. Recovery must keep the previous usable context for incomplete publication and must not create another continuation. Reuse existing SQL/event infrastructure and minimize shared hooks to publication and checkpoint selection.

Acceptance: inject failure after each publication step, restart against the same isolated database, compare selected context, require exactly one continuation and preserve queued user messages. Failed/cancelled summaries must never become committed checkpoints. Extend `packages/opencode/test/kilocode/session-compaction-safety.test.ts` and existing chunk/recovery fixtures. This remains pending; no schema or runtime change has been made for this candidate.

### Pending approval policy generation

Codex approval keys include execution context and a policy fingerprint; orchestration carries approval/cancellation context into attempts. Sources: [approvals.rs](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/tools/approvals.rs), [orchestrator.rs](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/tools/orchestrator.rs).

Raya's `packages/opencode/src/permission/index.ts` captures rulesets for pending requests; its reply path lacks an explicit policy-generation comparison. First reproduce whether a real governing policy update can leave a stale pending approval dispatchable. If confirmed, record policy generation/fingerprint with the request, revalidate current hard-deny constraints before releasing approval and before protected dispatch, and return a typed stale-policy reason. Preserve deliberate always-rules and existing session permissions. Add public SDK fields only if needed and regenerate them normally.

Acceptance: unchanged-policy approval succeeds; hard deny or permission revocation while waiting prevents dispatch; cancelled requests ignore late replies; no authority expands through policy churn. Exercise actual permission service and tool dispatch with a Kilo-owned regression. This is a race candidate needing reproduction, not a demonstrated exploit.

Existing Raya TaskWorker exact-message cancellation, owner fencing, deferred cleanup and native voice parent-linked SQL already address much of the lifecycle overlap; do not replace them with a duplicate worker framework. Review source copying against pinned [LICENSE](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/LICENSE) and [NOTICE](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/NOTICE). Preserve applicable Apache-2.0 attribution/modification notices and any relevant third-party notices; prefer independent implementations of patterns.

## Latest delivered state and next active work

Checkpoint `e74508a063d50d9f64e5b1d70e68357b58cafabf` is pushed to origin/main and installed as `eden.raya@7.4.23-snapshot+e74508a063.kamil-oseni.1789086796122`. Artifact: `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-e74508a063-kamil-oseni-1789086796122.vsix`. SHA-256 `D78CFCBBB30E8026A2CA95A699355F55B4AF5F22512DF0D60205182B41E8AEB2`; 516590133 bytes, 427 entries, CLI 228474880 bytes. Push checks passed 29 cross-package tasks plus JetBrains. SDK output did not drift. Production CLI smoke checks, extension checks, packaging/install and independent archive/installed-identity verification all passed. Handles 40716 and 9862 are terminal 0. No forced reload.

The recorder/support/telemetry batch above is delivered. Root is cleaning two return-style lint warnings in telemetry methods without changing transport behavior; this follow-up is not yet part of the installed checkpoint. Root owns this handoff/progress and forthcoming Live host integration.

**Confirmed next correctness fix:** an ignored actual-service harness reproduced the approval-policy race in both default Config.updateGlobal and dispose:false: fresh policy is deny, fresh asks reject, but approving the old pending request releases its protected continuation. Corrected reproduction: 2 expected failures, 8 assertions, exit 1, `.tmp/permission-policy-probe-assembled.log`. Initial harness failure was missing Config export and is not evidence. Worker repair_review now owns a narrow permission policy helper/index hook and real regression. Preserve legitimate always approval, including its own policy writes; final checks must cover all release paths and policy changes during reply publication. No generic worker-runtime replacement.

**Live next slice:** implement the actual host adapter/backend admission alongside the shared context coordinator and webview transport. Exact provider transcript fields are event_id, delta, integer start_ms/end_ms and optional client_event_id; preserve arrival order and opaque IDs, including zero-length timestamp intervals. Deduplicate identical event payloads, fail closed for conflicting identity, retain application-command provenance, and do not infer transcript completeness or playback. Worker history_recovery supplied the contract; agree file ownership before implementation. Source: [sideband reference](https://developers.openai.com/api/reference/resources/live/sideband-websocket). No Live adapter implementation is delivered yet.

For continuation, replace the prompt's old instruction to finish the telemetry fixture with: inspect the latest state, finish the active approval-policy fix and telemetry warning cleanup, then prioritize the production-integrated GPT-Live migration. Preserve the full 39-requirement scope and standing push/install authorization.

## Stopped-work runbook for the next agent

### 1. Establish the exact baseline before editing

The user requested this stop at approximately $30 credit balance. The next agent may continue under the standing implementation/push/install authorization in a separate run. The returning primary agent will review this work next week after quota reset. Do not interpret this handoff as permission to mark the 39-item goal complete.

1. Work only in `C:\Users\User\Desktop\raya`. Read root/touched-package AGENTS.md and the comprehensive audit. Inspect `git status --short`, `git diff --stat`, and the exact files below before changing anything. The clean delivered baseline was `e74508a063d50d9f64e5b1d70e68357b58cafabf`; the installed extension still corresponds to that checkpoint. Do not mistake the current working tree for the installed build.
2. Preserve all local edits. They include both useful implementation and known failing work. Do not reset/clean the tree or reinstall this WIP. Separate the approval fix from Live integration for review and checkpointing; shared backend files changed by the Live worker may be in CLI typecheck scope even when validating permission work.
3. Read the newest stop notes before the historical sections. All prior 39 requirement recipes remain applicable. Existing tests and earlier installed checkpoints prove only their documented slices, not the new Live path.
4. Verify tool/process state afresh; tool session IDs belong to the previous run and may not be resumable. No paid GPT-Live call, acoustic acceptance or microphone-device acceptance has been performed. Do not infer provider account access from documentation availability.

### 2. Current root-owned WIP and exact next steps

**Telemetry warning cleanup:** `src/services/telemetry/telemetry-proxy.ts` now makes instance capture/setEnabled async and awaits the already failure-contained transport, eliminating mixed return styles. Its 13 targeted boundary/utility tests pass (`.tmp/telemetry-return-style-tests.log`, terminal 0). This small follow-up is local, not in the installed checkpoint. Run scoped lint/typecheck once alongside the next package validation; preserve optional caller settlement.

**Live media transport:** `packages/kilo-vscode/webview-ui/src/context/live-voice.ts` now has a Chromium WebRTC fixture. Microphone capture stays disabled until host `started(requestID)` and local answer/peer/channel readiness share one `prepared` predicate. `mute(false)` cannot enable capture early. No client data-channel command writes. Remaining: 12-second cleanup timeout path, stop-speaking/resume UI, and packaged microphone acceptance.

Implement/verify this in order:

1. Build a real local Chromium WebRTC peer fixture patterned on `tests/fixtures/openai-voice.mjs` and its Bun wrapper `tests/unit/openai-voice.test.ts`. Use synthetic audio only for device-independent testing; retain real peer negotiation and data channels. Exercise the production LiveVoice class, not copied test logic. No Live fixture has been added yet.
2. Prove microphone tracks stay disabled before BOTH host `session.started` and local answer/peer/channel readiness. Audit `mute(false)`: its current condition checks started/answer but should also respect local connected readiness. Test host-start before SDP, after SDP, after disconnect and for an old request ID. Consider a single readiness predicate used by connected/mute rather than inconsistent checks.
3. Prove closure during microphone acquisition, SDP exchange and connection setup stops late tracks and never resurrects the call. Check failed getUserMedia, failed peer setup, timer expiry, channel close/error and output play rejection. `fail` currently delegates cleanup through sink.error to VoiceProvider; verify that contract is always honored and errors cannot repeat indefinitely before closure. Do not leave a bare transport owning resources after a caller failure.
4. Exercise `stop`/`finalized` ordering, repeated stop, wrong-request finalization, media cleanup exceptions and the timeout path. Local audio must silence immediately; host must retain sideband long enough to record session.closed duration. A timeout must leave host cleanup uncertain and block restart through existing recovery ownership. Confirm late host usage is still displayed for the stopped task, without leaking to another task.
5. Test malformed/oversized packets, duplicate/conflicting transcript IDs, interleaving input/output, truncated display and missing coverage. The UI currently renders only the latest 64 fragments even though the coordinator retains more; explicitly label that display truncation rather than implying it is full history. Never infer heard words, complete turns or authoritative user intent from displayed captions.
6. Test stop-speaking as local mute plus trusted steering. Explicit Resume voice audio is required. Caption arrival, provider command acknowledgement or delegated work completion must not unmute audio automatically. The current UI disables repeated stop while silenced. Check actual remote audio remains muted until Resume.

**Host service/message integration:** `speechOpenAIStart` with `engine: "live"` routes through the real `routeInputToolMessage` into SpeechService, and only LiveBroker runs when saved settings are `openai-live`. Untrusted request/session/event IDs, oversized SDP and unknown control actions are rejected at the host boundary. Posted errors never include the OpenAI key or backend password. `openaiStop` stops both brokers. CLI mirror still omits the OpenAI key. Native Live skips cascade MiniMax replies. Remaining: VoiceProvider/UI integration, provider-switch/disposal races with a live paid session, and HTTP contract tests.

- New engine value is `openai-live`; the default remains `openai-realtime` while validation is incomplete. Keep saved engine choices. Do not globally replace the Realtime model constant. The new `OPENAI_LIVE_MODEL` is used in settings.
- Existing speechOpenAIStart optionally carries `engine: "live"`; SpeechService routes it to LiveBroker only when saved settings select Live. Existing OpenAI ready/error/stopped messages are reused. New messages are speechLiveStarted, speechLiveUsage, speechLiveControl and speechLiveControlResult. Verify full routing through the real input-tools service and webview message union; untrusted message payloads need runtime validation as well as TypeScript.
- `liveStart` loads the same bounded saved context and captures server identity/directory/current-task checks. It passes `started()` and duration callbacks to the trusted broker. Verify no credential or broker context enters the webview.
- `openaiStop` invokes both brokers with the request ID and uses a reported error if either fails. Ensure each broker ignores mismatched IDs and never stops another active call. Verify lifecycle during provider switch, backend restart and host disposal.
- Image sharing selects the active broker. Live returns `staged`, now added to image state/message unions. UI explicitly says images go to Raya work/its vision model, not GPT-Live. Prove sharing alone cannot admit work; check exact staging identity, retained bounds, retries, task deletion and later selection by delegation.
- Review CLI speech mirror/fallback/config validation for the new engine; do not only inspect the settings dropdown. Ensure native Live does not accidentally trigger cascade voice or switch the main task agent.

**VoiceProvider/UI integration:** Chromium fixture `tests/fixtures/live-voice-ui.mjs` drives the production VoiceProvider and composer. Start posts `engine: "live"` without switching the Auto agent. Microphone controls wait for `speechLiveStarted`. Delayed older mute failures cannot overwrite a newer unmute. Stop speaking is local silence plus trusted steering; Resume is required; captions cannot unmute. Task switch clears captions and duration. Images state they go to Raya work/vision, not GPT-Live. Remaining: packaged microphone/acoustic acceptance and existing composer.browser.ts regression pass as a batch.

- A selected transport (Realtime or Live) is retained through recovery; cleanup must not choose a transport from newly changed settings. The call records engine and owner identity. Start/reset clears Live captions/duration/silence state. Ensure task switches also clear/hide duration and captions: current code needs an explicit review because older cleanup paths mainly clear Realtime transcript state.
- Live startup messages unlock the local transport; duration updates accept only matching call/recovery and parent task. Existing recovery requires both host acknowledgement and local cleanup. Test asynchronous ordering with actual provider messages and close events, not only a fake sink.
- Add correlated control state if necessary: current UI sends random event IDs and reports failures for the active request but does not retain a full outstanding-control map. A delayed failure for an older mute command must not overwrite the interpretation of a newer successful command. Local mute remains distinct from provider acknowledgement.
- VoiceTranscript renders independent speaker fragments and coverage warnings. NativeVoiceUsage separates reported duration from delegated token/tool costs. Verify no previous Realtime totals leak into a Live display, and duration does not leak when changing tasks or providers.
- PromptInput and recovery guards were broadened to both native engines to preserve the main task agent and normal Start/End behavior. Run existing composer/voice browser regressions to catch differences in task selection, disabled controls, retained drafts and recovery.
- Add a concise changeset for the completed Live feature when ready; none has been created for Live WIP yet. Do not publish it as complete before the acceptance matrix passes.

**Current root validation:** `bun run --cwd packages/kilo-vscode check-types:webview` passed, terminal 0, `.tmp/live-ui-wrap-types.log`. This is static webview checking only. Earlier combined package check `.tmp/live-ui-types-initial.log` failed on live-broker nullable/shadowed identifiers and interrupted the webview check; the worker is settling those errors separately. No Live browser/host/backend runtime test has passed yet. Formatting, lint/knip, source links, SDK regeneration and complete package tests remain required after source stabilizes.

### 3. Permission-policy patch — verified locally, not yet shipped

Worker-owned files are `packages/opencode/src/permission/index.ts`, `packages/opencode/src/kilocode/permission/policy.ts`, `packages/opencode/src/kilocode/permission/drain.ts`, `packages/opencode/test/kilocode/permission-policy.test.ts`, and `.changeset/raya-pending-permission-policy.md`.

The clean-baseline race was demonstrated through the actual Config and Permission services: while an old request waits under ask, Config.updateGlobal changes bash to deny; fresh requests reject, but replying once to the old request releases its protected continuation. Both default updateGlobal and dispose:false reproduce. Log `.tmp/permission-policy-probe-assembled.log`: two intended regression failures, eight assertions. The first ignored probe was a fixture assembly failure and is not evidence.

**2026-09-11 delivery:** committed `8b01e7231172ad8916065bcef2e7dc78cb5ec76a`, pushed to origin/main with normal hooks (29 cross-package typecheck tasks + JetBrains, exit 0). Live/telemetry WIP was stashed, `snapshot:install` exit 0, stash restored. Installed `eden.raya@7.4.23-snapshot+8b01e72311.kamil-oseni.1789091821099`. VSIX SHA-256 `446FC10C1FAA687194561707B5A49F55671FCD68B45ABCE07DD84121D85F9DE7`; 571767000 bytes, 442 entries, CLI 228484608 bytes. Archive has no live-broker, `.tmp`, or `.env` entries. Logs: `.tmp/permission-policy-isolated.log`, `.tmp/permission-always-rules.log`, `.tmp/permission-allow-everything.log`, `.tmp/permission-policy-types.log`, `.tmp/permission-policy-lint.log`, `.tmp/permission-policy-annotations.log`, `.tmp/permission-policy-facades.log`, `.tmp/permission-policy-snapshot-install.log`, `.tmp/permission-policy-snapshot-verification.log`, `.tmp/permission-policy-installed-extension.log`. No forced reload. PR-04 per-path grants and Live acceptance remain open.

### 4. Mandatory next-agent reporting and next-week review contract

**Update this handoff as you implement, not only when you stop.** The returning agent must be able to determine exactly what you changed, why it is correct, what remains uncertain and where to resume.

For each coherent feature or attempted fix, add a dated entry with:

- Requirement IDs and original acceptance criteria addressed; list which criteria remain open. Use explicit states: planned, implemented/unverified, verified locally, delivered, blocked/revisit. Do not upgrade a whole requirement because one narrow test passes.
- Exact changed files and main functions/contracts, rationale and any new schema/config/default. Include source citations and pinned Codex commit when adapting external patterns.
- Exact verification command, working directory, isolated-state setup, terminal exit code, assertions/test count and log/artifact location. Distinguish existing baseline failures from new failures. Record stopped or timed-out processes honestly. UI work needs actual rendered evidence and interaction results, not only types or screenshot existence.
- Failed approaches, the concrete failure and next diagnostic. After repeated failures move to independent work only with a reproducible revisit recipe; do not silently delete failing tests or weaken acceptance.
- Commit hash, branch, push state, installed version, artifact SHA-256 and verification evidence. A commit does not mean pushed; a packaged archive does not mean installed; installed does not prove activation after reload or user workflow success.
- Live handles at handoff, exact next edit/check and any decisions requiring user input. Record no live handles explicitly when settled. Keep all secrets and real user content out of handoff/log excerpts.

Update the 39-row progress ledger using bytes-preserving edits. Preserve its mixed encoding. Update the current-status paragraph at the top of this handoff and the continuation prompt whenever the next step changes; do not leave contradictory historical instructions as the apparent current plan.

**Returning primary agent review next week:** compare git history/diff against e74508a063 and subsequent delivered hashes; read each new entry; independently rerun the smallest high-risk regression for permission, lifecycle or accounting changes; inspect SDK generation and schema migrations; run the actual UI/browser acceptance for touched surfaces; verify installed artifact identity; sample the original audit criteria rather than relying on the new agent's summary. Check especially stale authority, duplicate work, task deletion, late completion, usage provenance and whether captions/audio claims exceed evidence. Continue from the first unverified or failed criterion, not from whichever feature has the most recent commit.

### 5. Delivery procedure after fixing the WIP

Do not push/reinstall the current failing tree. Finish one coherent slice and review its exact staged files. Run relevant package tests/types/lint and affected guards, regenerate SDK for the Live endpoint/schema additions, extract source links for new source URLs, and check Markdown tables. Use ordinary conventional commits and normal pushes; no hook bypass or force push. Reuse the snapshot helper only after inspecting its path validation and isolated build setup; verify actual artifact hashes and installed identity. Record each delivery immediately in this handoff/progress. If Live is not ready, isolate its unfinished changes before delivering the permission fix; do not accidentally package an unverified selectable engine.

### 6. Replacement continuation prompt

```text
Continue Raya in C:\Users\User\Desktop\raya. Read AGENTS.md and docs/Raya-Remaining-Implementation-Handoff.md, beginning with the current-status banners and the 2026-09-11 permission update; then read the comprehensive audit, progress ledger and voice architecture. The scope is all 39 requirements plus RDM-01-06. Last verified pushed/installed product checkpoint is 8b01e7231172ad8916065bcef2e7dc78cb5ec76a. Permission canonical comparison is delivered. Live host/CLI types pass and live-protocol unit tests pass; Live integration remains UNFINISHED. Preserve remaining Live WIP; do not ship it as verified.

Start LiveBroker HTTP/WebSocket loopback fixtures from the frozen host/backend order. GPT-Live 1 requires its own adapter and exact current official contract; no model-string substitution, history replay as new work, or generated-caption claims about heard audio. Keep parent ownership, existing permissions and durable receipts.

I authorize root plus two workers, normal periodic commits/pushes to origin/main and verified snapshot installation without asking again. Do not bypass hooks, force push or force reload VS Code. Batch broad checks at coherent checkpoints, but test actual high-risk boundaries before claiming they work. If repeated attempts fail, document the concrete cause and revisit steps before switching to independent work.

Finish existing Raya work and GPT-Live first. New Codex-derived features are explicitly deferred to a later phase; see Raya-Codex-Research-Deferred.md.

MANDATORY: update the handoff and progress ledger as you implement each coherent slice, with exact files, requirement IDs, tests/exit codes, failures, commits/push/install receipts and next steps. Preserve the progress file's mixed encoding using bytes-preserving edits. The original agent returns next week and needs to independently review your work. Follow the reporting/review contract in the handoff. Keep this prompt and top current-status section accurate. Do not mark the 39-item goal complete until every acceptance criterion is satisfied or explicitly resolved with the user.
```

### Working-tree inventory at stop

```text
 M docs/Raya-Implementation-Progress.md
 M docs/Raya-Remaining-Implementation-Handoff.md
 M packages/kilo-vscode/src/services/input-tools.ts
 M packages/kilo-vscode/src/services/telemetry/telemetry-proxy.ts
 M packages/kilo-vscode/src/shared/speech.ts
 M packages/kilo-vscode/src/speech/service.ts
 M packages/kilo-vscode/src/speech/settings.ts
 M packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceControls.tsx
 M packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceImage.tsx
 M packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceRecovery.tsx
 M packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceUsage.tsx
 M packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx
 M packages/kilo-vscode/webview-ui/src/components/chat/VoiceTranscript.tsx
 M packages/kilo-vscode/webview-ui/src/components/settings/SpeechTab.tsx
 M packages/kilo-vscode/webview-ui/src/context/voice-images.ts
 M packages/kilo-vscode/webview-ui/src/context/voice.tsx
 M packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts
 M packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts
 M packages/opencode/src/kilocode/permission/drain.ts
 M packages/opencode/src/kilocode/server/httpapi/groups/voice.ts
 M packages/opencode/src/kilocode/server/httpapi/handlers/voice.ts
 M packages/opencode/src/kilocode/voice/openai-protocol.ts
 M packages/opencode/src/kilocode/voice/openai-store.ts
 M packages/opencode/src/kilocode/voice/openai.ts
 M packages/opencode/src/permission/index.ts
?? .changeset/raya-pending-permission-policy.md
?? packages/kilo-vscode/src/shared/live-context.ts
?? packages/kilo-vscode/src/shared/live-usage.ts
?? packages/kilo-vscode/src/speech/live-broker.ts
?? packages/kilo-vscode/src/speech/live-commands.ts
?? packages/kilo-vscode/webview-ui/src/context/live-voice.ts
?? packages/opencode/src/kilocode/permission/policy.ts
?? packages/opencode/src/kilocode/voice/live-protocol.ts
?? packages/opencode/test/kilocode/permission-policy.test.ts
```

### 7. Frozen Live host/backend implementation ? exact contracts and unresolved risks

Both workers are now frozen and report **no live owned handles**. The Live worker fixed only obvious nullable guards and an identifier-shadowing error before stopping; it did not rerun host types. The independent root webview typecheck passed, but full host/CLI compilation of the final WIP is unknown. Do not claim the Live implementation compiles or works until freshly verified.

**Owned source inventory:** shared `live-context.ts`/`live-usage.ts`; host `speech/live-broker.ts`/`live-commands.ts`; backend `kilocode/voice/live-protocol.ts`; modified `openai-protocol.ts`, `openai-store.ts`, `openai.ts`, and voice HTTP group/handler. All paths are under packages/kilo-vscode/src or packages/opencode/src as shown in the working-tree inventory above. These changes have no Live tests, no Live changeset, no SDK regeneration and no delivered snapshot.

**LiveBroker API consumed by SpeechService:**

```ts
get active(): boolean
start(
  input: { requestID: string; sessionID: string; sdp: string },
  load: (signal: AbortSignal) => Promise<{
    key: string; voice: string; backend: string; authorization: string;
    directory: string; current: () => boolean; context: string;
    started: () => void; usage?: (state: LiveUsage) => void;
  }>,
  ready: (answer: { sdp: string; providerSessionID: string }) => void,
  failed: (message: string) => void,
): Promise<void>
stop(requestID?: string): Promise<string | undefined>
dispose(): Promise<string | undefined>
control(requestID: string, eventID: string, action: "mute" | "unmute" | "stop_speaking"):
  Promise<{ status: "accepted" | "unknown" | "failed"; error?: string }>
share(requestID: string, imageID: string, data: string):
  Promise<{ status: "staged" | "unknown" | "failed"; error?: string }>
type LiveUsage = { seconds?: number; final: boolean; recorded: boolean; incomplete: boolean }
```

`ready` delivers SDP after trusted attachment; `started` is a separate matching-provider event callback. Do not merge them into one wait. The broker reserves ownership before loading config and marks potentially admitted remote work uncertain before mutation. It stages images only in Raya storage, polls existing durable work receipts, and never cancels admitted task work merely because voice ends.

**Coordinator API and bounds:** `receive(unknown)` returns ignored/transcript/delegation/invalid/limit; `snapshot()` returns copied fragments plus incomplete/limited; `gap()` invalidates automatic context use; `select(delegationID)` returns a retained immutable selection or undefined. Fragment fields: id, speaker user/assistant, text, start/end timestamp, arrival sequence, optional client command ID. Bounds currently chosen by Raya: 16 KiB per delta, 256 KiB cumulative text, 4096 fragments, 4224 event identities, 128 delegation identities; no eviction that silently forgets duplicate identities. Normalized known-field fingerprints now avoid the original arbitrary-extra-field memory risk. Host unit tests cover duplicate ignore, conflicting identity invalidation, consumed-sequence refusal, client-command exclusion, gap blocking, and non-client target ignore.

Selection uses received fragments whose start is at/before the provider offset, keeps crossing fragments intact, selects at most 32 and 6000 serialized characters, and requires fresh nonempty user evidence without client-command correlation. Already consumed user sequences cannot alone trigger new work. All selection envelopes carry `incomplete: true` because there is no completeness watermark; internal `incomplete` instead means known corruption/gap and blocks selection. Rename or clarify these two meanings if necessary rather than accidentally rejecting all selections or presenting them as complete. Test offset overlap, late fragments, repeated text under different IDs, command echoes, conflicting identity, capacity exhaustion, repeated selection and corruption.

**Backend changes currently written:**

- Existing `POST /kilocode/voice/openai/session` accepts optional model `gpt-realtime-2.1 | gpt-live-1`; omission retains Realtime. Existing binding identity must not switch model. Provider session IDs are bounded opaque strings.
- New `POST /kilocode/voice/live/session/:id/calls` accepts `{generation, context:{version:1,delegation,offset,fragments,incomplete:true,omitted}, images?:string[]}`. Existing capability header, owner/generation/directory checks and parent scope remain required. A deterministic internal call ID is `liv_` plus the first 48 hex characters of SHA-256 of the provider delegation ID.
- The backend validates context size, fragment order/identity/timing and fresh user evidence; prompt text explicitly labels transcript uncertainty, application correlation and generated-but-unheard assistant context. It then uses the existing retained work runner and call status/cancel endpoints. Audit that normalizing to a prompt does not erase immutable original-context evidence or allow a different payload for an existing delegation ID.
- `liveCursor` prevents admission under a new delegation ID using only consumed user sequence. Its stored schema currently uses a generic number: tighten to finite safe nonnegative integer. Confirm it advances only with the same durable admission and cannot lose new user input after an ambiguous failure. Test restart and concurrent admissions against actual SQL state.
- New `POST /kilocode/voice/live/session/:id/duration` accepts `{generation,receipt:{id:providerFinalEventID,model:"gpt-live-1",seconds}}`. Final duration is immutable: identical retry succeeds, changed receipt fails. It can be saved after closing admission, without reopening work. Verify model/current-owner checks on closed bindings, FK parent deletion, UPDATE-only refusal after deletion and no resurrection of old records.
- The store adds optional duration/liveCursor fields. Preserve legacy JSON migration and old Realtime bindings; test old persisted records and existing retention/deletion suites. These endpoint/schema changes require the normal root SDK generator before delivery; do not hand-edit generated SDK.

**Host/backend review priorities, in exact order:**

1. Run extension host and CLI types to establish the final baseline after last guard fixes. Format/lint only touched files, respecting existing complexity caps through cohesive helpers. Do not increase ratchets to hide new complexity. Root webview type result alone does not validate host/backend.
2. Implement real HTTP/WebSocket loopback fixtures for broker startup/attachment. **Verified locally:** `allowed_client_events: []`, SDP before `session.started`, injectable host timeout closes an unstarted paid call, hangup+DELETE always run, mute waits for started, late started cannot revive a stopped call. **WebRTC/UI peer verified locally:** production LiveVoice, synthetic-audio Chromium peers, microphone held until host start and local readiness, host-start before/after SDP, stale request ID, stop during SDP/microphone, failed exchange release. Remaining: absent-UI service-layer timeout, 12-second media cleanup timeout, and packaged microphone acceptance.
3. Exercise start/stop/disconnect/session.closed races and await all cleanup promises. Confirm final usage can arrive before/after stop and that binding closure does not cancel task work. Lost creation or admission acknowledgement must retain uncertainty; add a query/idempotency recovery boundary rather than blind retries or releasing ownership.
4. Strengthen completed-work result validation to match existing Realtime broker identity/status checks before commentary. **Partial:** completed results now require text, assistant message identity and evidence; failed status is narrated as a status string. Remaining: stale results after task/owner change and permission waits; still slices successful text to 1000 characters.
5. Audit append limits: character counts do not prove the provider's token cap. Use a defensible bounded representation or refuse/split according to verified protocol semantics, with tests for long non-ASCII content. Never replay an uncertain append just to obtain an acknowledgement.
6. Test LiveCommands correlation against exact error shapes, late acknowledgement, duplicate command IDs, conflicting reuse and timeout. **Partial:** reuse, wrong-type ignore, provider error, close-unknown and send-failure are covered. Remaining: late acknowledgement after timeout, 256-command cap, and output silence as a local media fact.
7. Test image staging: immutable ID/hash, uncertain/failure retention, four-attempt bound, no native image upload, no work from staging alone, correct selected images attached to later work. **Verified locally:** same-ID retry, hash reuse, four-attempt cap, invalid bytes never POSTed, mismatched receipt retained as unknown. Remaining: vision permission/model checks.
8. Test delegation queue and steering while work is busy. Current queue waits behind polling; selection occurs when dequeued using the provider offset. Define whether newer user corrections revise queued work or require clarification, and fence stale results. Do not claim seamless concurrent steering from serialized happy-path execution.
9. Test conflicting duplicate session.closed events. **Partial:** a later different event ID marks host usage incomplete and does not POST a second duration. Remaining: same-event retry vs conflict, backend immutability under a changed receipt, and UI presentation of incomplete settlement.
10. Add actual backend runtime/DB/API tests for model mismatch, invalid/duplicate context, replay cursor, immutable receipts, deletion cascades, late writes and permission boundaries. **Partial:** service-layer SQL tests cover duration immutability after close, Realtime model mismatch, consumed-sequence refusal and liveCursor advance. HTTP tests cover Live call/duration auth, invalid context, consumed sequence, close-then-refuse, immutable duration, parent deletion 404, and a sibling binding remaining writable. Remaining: delegation queue/steering while busy, and packaged microphone acceptance.

**Validation receipts at freeze:** historical; superseded for broker fixtures by `.tmp/live-broker-tests.log`. WebRTC/UI/backend SQL tests still absent. Do not package Live. Permission remains the last installed product; see section 3.

**Next executable step:** SDK now exposes `voice.live.call` and `voice.live.duration`. Next: WebRTC/UI fixtures and host service/message routing. Do not change the default engine or package Live.

### Local backup and final stop receipt

All 34 currently changed/new files were backed up to `.tmp/raya-credit-stop-wip.zip` with a SHA-256 manifest and baseline commit. This is a local WIP backup, not a verified release and not pushed to origin. The current workspace remains the primary continuation source. The detailed stop document and latest unfinished source are local; the remote installed checkpoint remains e74508a063. Both workers and all root-owned check handles are stopped/terminal. The handoff covers all 39 unique requirement IDs and all local Markdown links resolve. No further implementation will run in this turn. Use the app goal Pause control to pause automatic goal execution; the agent tools cannot set a paused status.


### 2026-09-10: Research addendum and final priority

Read [Codex research: deferred implementation backlog](Raya-Codex-Research-Deferred.md) for the requested public-source comparison. It contains 18 bounded candidates and explains the distinction between public CLI/app-server code, documented desktop behavior and unverified private internals. **Continue the existing 39 requirements and GPT-Live voice first. Do not start these Codex-derived additions during that work.** Re-evaluate gaps after the existing work is complete; some may already be resolved. The research does not change the frozen WIP release status or authorize shipping its known failures.

The implementing agent must update this handoff and the progress log continuously: exact files/commits, behavior, test commands and exit codes, evidence paths, remaining limitations, delivery state and next executable step. The returning reviewer must be able to reproduce acceptance and distinguish implementation from actual verification. For any later Codex work, also maintain the per-item review template in the research document.


## Routines direction: agent DM inbox and company delegation

**Latest user requirement, 2026-09-10. Status: identity/persistence/API, report publication, conversation UI, follow-up dispatch and session-list exclusion are verified locally; worker-to-worker delegation is not implemented.** This is current Raya implementation scope under OVR-05, with PR-03/04, EN-02/03, UX and UI dependencies. It is not a deferred Codex enhancement. Finish it alongside the existing audit and GPT-Live work, before the deferred Codex backlog. Earlier routine acceptance criteria are incomplete without this experience. The 39 parent requirement IDs remain unchanged; the subcriteria below expand OVR-05.

### Product outcome and visual reference

Routines should feel like direct messages with persistent workers, not a list of scheduled jobs that sends the user into ordinary chat history. The user's reference image shows a dark two-pane messenger: searchable worker list on the left, avatar/name/last-message preview/time/unread indication, selected worker conversation on the right, incoming/outgoing bubbles and inline file cards. Use that interaction hierarchy with Raya's own typography, spacing, colors, components and accessibility conventions; do not copy Grok or iMessage branding or imply either is an integration dependency. The reference is attached to the conversation, not stored as a repository asset; this description preserves its implementation intent.

Example acceptance journey: the user assigns an accounting worker to review accounts every Friday. Its recurring reports arrive in that worker's routine conversation. The user asks why expenses increased, receives an answer grounded in the relevant report, asks for a breakdown, and finds the following Friday's report in the same conversation. They never need to hunt through regular chats. A Chief of Staff can request input from that accounting worker and other authorized workers, receive their replies, and deliver a consolidated update with links to the underlying reports.

The long-term product intent is to delegate operating work to agents that can help run companies and collaborate with other routine agents. For this increment, deliver the working chain of assignment, scheduled execution, report, follow-up and inter-agent delegation. Do not treat a visual mockup or an autonomous-company marketing label as fulfillment. Scheduling a read-only accounting review does not implicitly authorize payments or other unrelated actions.

### RDM-01: Dedicated inbox and conversation UI

- Make the routines surface an inbox of persistent worker/routine conversations. Show name, role, latest message, time, unread count and concise state: scheduled, running, waiting on another worker, needs input, paused or failed. Keep operational state separate from unread state.
- The conversation header identifies the worker and its company/workspace, with next scheduled run and accessible schedule/access/pause controls. Put deeper configuration and run history in a details pane rather than replacing the conversation with a settings form.
- Render user messages, worker replies, scheduled reports, requests for a decision, delegation updates and artifacts in one ordered timeline. Distinguish report occurrences with date/run labels. Collapse noisy tool activity behind inspectable run details. Clearly attribute messages from other workers; they must not impersonate the user or the conversation owner.
- Provide a persistent composer, explicit sending/queued/failed states, retry without duplicate admission, attachments using existing supported controls, and draft preservation per conversation. A follow-up must work inside routines; a link to a normal chat is insufficient.
- Search/filter workers and conversations, preserve selection and scroll position, support unread/needs-attention filters, and avoid stealing focus when a report arrives. Narrow views switch between list and conversation with a clear back action. Keyboard navigation, visible focus, screen-reader labels, contrast and reduced motion are acceptance requirements.

### RDM-02: Durable worker, conversation and execution identities

1. Inspect existing routine/task, company, session and occurrence schemas before choosing names or adding tables. Define the stable worker identity separately from a schedule, a conversation, and a run. One worker may eventually own multiple assignments: do not make its identity a display name or the ID of its latest execution. For migration, an existing routine may map to one stable worker/conversation without requiring an organization designer first.
2. Persist conversation membership/scope and explicit links to routine, run/occurrence, execution session, message/artifact and delegation identities. A scheduled occurrence creates execution work and publishes into the persistent conversation; it must not replace the conversation every Friday. Do not reuse an unbounded transcript as the entire model context: retrieve relevant reports/messages and disclose unavailable evidence.
3. Reuse existing session/runtime and durable occurrence ownership. Create the minimum metadata/read model needed for the routines inbox, not a second competing chat engine. Locate authoritative ownership before adding any webview cache.
4. Add durable ordered message delivery and idempotent publication keyed to the actual source event/run. Reconnect, restart, duplicate completion and replay must not publish duplicate reports. Report content and attachments need durable provenance, and late results must remain attached to their original run.
5. Persist read position and drafts in an appropriately scoped store; unread reconciliation must not depend only on whether the current webview happened to receive an event. Aggregate list summaries and paginate conversations instead of loading every run/transcript for every row.
6. Mark routine-owned execution sessions explicitly. Exclude them from the default regular-chat list while keeping them inspectable through run details or an explicit routine-session filter. Never delete history just to hide it. Ordinary user chats remain ordinary chats; do not classify by title or guess at legacy ownership.

### RDM-03: Reports and interactive follow-up

1. Publish scheduled and manually requested results into the same worker conversation, with occurrence date, outcome, concise findings, evidence/artifacts and next decision. Show failed/partial/blocked runs honestly. Keep an incomplete run from appearing as a successful report.
2. Route user messages to the selected worker and company/workspace with the relevant conversation and report context. Resolve phrases such as 'that Friday report' through explicit reply/report references where possible; ask for clarification if ambiguous rather than selecting another company's data.
3. Define admission while that worker is already busy: show whether the message is queued for a safe boundary or answered separately. Preserve authoritative request identity, drafts on rejection and exactly one accepted action after retry. Reuse existing queue semantics; do not implement an undisclosed abort/replay.
4. Distinguish a question about a report, a request to run now, and a proposed change to the recurring instructions/schedule. A one-off chat message must not silently rewrite future assignments. Show a concrete persistent change before applying it using existing mutation/conflict handling.
5. Make notification clicks open the exact conversation/report. Provide a conversation-level unread model and retain run-level technical details for inspection. Preserve existing output review, conflict comparison and access review within this flow.

### RDM-04: Worker-to-worker delegation and company coordination

1. Add an explicit authorized delegation request containing sender/recipient worker IDs, company/workspace scope, parent run, correlation ID, objective, permitted context/artifact references, deadline/cancellation behavior, budget and expected result. Reuse existing task/delegation transport and ownership where possible.
2. Deliver work to the recipient through a durable, bounded queue. A worker may receive both its scheduled work and another worker's request; serialize or arbitrate using authoritative ownership. Never create a duplicate worker merely because it is busy. A delegated request is distinct from changing the recipient's recurring job.
3. Record accepted/running/needs-input/completed/failed/cancelled states and a durable response linked to the exact request. Return the answer to the requesting worker and show an understandable delegation card in the relevant conversations. Retrying transport must not repeat the actual accounting review or external action.
4. Apply the intersection of requesting authority, recipient capabilities, company/workspace boundary and current policy. Passing a task must not bypass read-only restrictions or grant broader access. Pass only necessary context; ordinary worker messages and retrieved reports cannot grant permissions. Route requests for additional authority to the user with attributable scope.
5. Prevent self-delegation loops and cycles through lineage, bounded depth/fan-out, deadlines and deduplication. Define cancellation propagation and what happens when a recipient is paused, archived, unavailable or awaiting approval. Preserve a completed child result even if the parent stops, without restarting the parent automatically.
6. Attribute costs and outcomes to child requests and the parent/company without double counting. A coordinating worker's final report links to contributing workers/results and distinguishes confirmed findings from pending input. Do not fabricate a consensus or a worker reply that has not arrived.
7. Provide an inspectable delegation chain and user controls to stop outstanding work. A minimal Chief of Staff -> Accounting -> response -> consolidated report flow is required runtime acceptance; a full org-chart editor and arbitrary business autonomy are not prerequisites for this first working flow.

### RDM-05: Migration and implementation order

1. Read package AGENTS.md, then trace [RoutinesView](../packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx), [host routines bridge](../packages/kilo-vscode/src/kilo-provider/routines.ts), [task schemas](../packages/opencode/src/kilocode/task/index.ts), [runner](../packages/opencode/src/kilocode/task/runner.ts), scheduler/owner/queue/recovery, and existing session-list/delegation/company paths. Record existing contracts and the precise missing pieces in this handoff.
2. Implement additive durable identity/linkage and migration first. Preserve schedules, timezone, occurrence history, permissions, outputs and archived state. Backfill only from authoritative links; leave ambiguous legacy sessions recoverable. Test migration repeatability before altering list filters.
3. Extend backend query/command/event contracts for inbox summaries, paginated messages, send/read state and correlated report publication. Regenerate the SDK after server changes. Add actual persistence/API tests before composing the new UI.
4. Build the inbox and conversation on existing Raya components; integrate reports and follow-up end to end, then settings/run details and notification deep links. Use the current output/access editors rather than duplicating their mutation logic.
5. Add cross-worker requests/responses on existing task foundations after single-worker delivery is reliable. Verify authority, lifecycle and cost attribution at the runtime boundary, then expose delegation cards and inspection.
6. Run the smallest affected package type/lint/tests and required repository guards, then real UI acceptance. Record changed files, exact commands/exits and evidence paths continuously in BOTH this handoff and the progress log. Mark implemented, runtime-verified, visually accepted, committed, pushed and installed separately. Preserve the existing frozen WIP safeguards and GPT-Live priority; this document-only change does not certify that WIP.

### RDM-06: Required acceptance and returning-reviewer checklist

- Friday accounting scenario: create assignment with explicit timezone; trigger a controlled due occurrence through the real scheduler/runtime; receive one durable report; ask a contextual follow-up in routines; inspect its evidence; receive another occurrence in the same conversation. Do not wait a real week or fake a success event as the sole test.
- Separation: multiple workers and ordinary chats coexist; default regular history contains no newly classified routine execution sessions. Routine history and old execution details remain recoverable. Inbox selection and unread state survive reload.
- Concurrency/recovery: message while busy, duplicate send/completion, reconnect, backend replacement, crash between result persistence and publication, stale responses after navigation, and cancellation each preserve identity and produce no duplicate execution/report.
- Delegation: coordinating worker obtains a real subordinate result and reports it with provenance. Test busy recipient, denial, read-only restrictions, cross-company access, cycle/fan-out bounds, timeout, duplicate replies and parent cancellation. Inspect real runtime records, not only mocked UI cards.
- Lifecycle: schedule edits, pause/archive/delete during execution and recipient unavailability have defined UI and durable outcomes. Historical reports remain accurately attributed after worker rename or reassignment.
- UI: use the reference's messenger hierarchy in Raya's own design; verify light/dark themes, narrow/wide layout, long report/file cards, empty/loading/stale/error states, keyboard and screen-reader navigation. New reports do not pull the reader away from an older report or overwrite a draft.
- Performance: record workload size, request count and rendering behavior for a large inbox/history; retain bounded refresh/pagination. Set and document an explicit test budget before claiming responsiveness, rather than claiming improvement from component structure alone.
- Reviewer: inspect schema/migration and authoritative event flow first, then reproduce single-worker and delegation journeys. Reject 'done' if the UI only deep-links to regular chat, reports still mix into ordinary history, follow-ups lose run context, or delegation bypasses the recipient's policy. Record remaining limitations and the next executable step before handoff.

## 2026-09-11: Permission canonical comparison (PR-04)

**States:** implemented, verified locally, committed, pushed and installed as `8b01e72311`. Live remains implemented/unverified and unshipped.

Requirement: a pending approval must not release after an unrelated restrictive policy change, while an explicit saved allow for `echo*` must still release once. Publication-time deny, allowEverything, and saved-rule escapes remain blocked.

Changed files: `packages/opencode/src/kilocode/permission/policy.ts` (`tuple`/`compatible`/`capture`), `packages/opencode/src/permission/index.ts` (narrow policy snapshot hooks), `packages/opencode/src/kilocode/permission/drain.ts` (current-policy drain gate), `packages/opencode/test/kilocode/permission-policy.test.ts`, `.changeset/raya-pending-permission-policy.md`.

Rationale: Config merge promotes scalar `bash: "ask"` to `{ "*": "ask" }` when saving `{ "echo *": "allow" }`. `fromConfig` builds those rules with different property insertion order, so `JSON.stringify` of Rule objects was not an equality test. Comparison now uses ordered canonical tuples. Expected differences are only rules accepted through `saveAlwaysRules`, not every new allow.

Verification (cwd `packages/opencode` unless noted; normal bunfig preload):

| Command | Result | Log |
|---|---|---|
| `bun test ./test/kilocode/permission-policy.test.ts --timeout 30000` | 12 pass, 0 fail, 37 assertions, exit 0 | `.tmp/permission-policy-isolated.log` |
| `bun test ./test/kilocode/permission/next.always-rules.test.ts --timeout 30000` | 22 pass, 0 fail, 35 assertions, exit 0 | `.tmp/permission-always-rules.log` |
| `bun test ./test/kilocode/server/permission-allow-everything.test.ts --timeout 30000` | 3 pass, 0 fail, 15 assertions, exit 0 | `.tmp/permission-allow-everything.log` |
| `bun run typecheck` | exit 0 | `.tmp/permission-policy-types.log` |
| root `bun run lint` on the four permission files | 15 warnings, 0 errors, exit 0 | `.tmp/permission-policy-lint.log` |
| `bun run script/check-opencode-annotations.ts --worktree` | exit 0 | `.tmp/permission-policy-annotations.log` |
| `bun run script/check-opencode-promise-facades.ts` | exit 0 | `.tmp/permission-policy-facades.log` |

Failed approach: the previous comparator stringified raw Rule objects, so legitimate saved-allow failed while deny races passed. Tightening expected-differences to saved rules only keeps unrelated concurrent allows from being ignored.

Remaining limitations: no public HTTP/SDK change; Windows OS confinement and per-path grants remain open under PR-04. Live/telemetry files are restored in the working tree and were not packaged. No live handles. VS Code was not force-reloaded.

Delivery: commit `8b01e7231172ad8916065bcef2e7dc78cb5ec76a` on `origin/main`. Installed `eden.raya@7.4.23-snapshot+8b01e72311.kamil-oseni.1789091821099`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-8b01e72311-kamil-oseni-1789091821099.vsix`; SHA-256 `446FC10C1FAA687194561707B5A49F55671FCD68B45ABCE07DD84121D85F9DE7`; 571767000 bytes, 442 entries, CLI 228484608 bytes. Push hooks: 29 typecheck tasks exit 0, JetBrains typecheck exit 0. `snapshot:install` exit 0.

## 2026-09-11: Live type baseline and context validation

**States:** Live host/CLI types verified locally; live-protocol `valid`/`prompt` verified locally; remaining Live broker/UI/HTTP work implemented/unverified and unshipped. Product checkpoint remains `8b01e72311`.

After restoring stashed Live WIP, `bun run check-types` in `packages/kilo-vscode` exited 0 (`.tmp/live-host-types.log`) and `bun run typecheck` in `packages/opencode` exited 0 (`.tmp/live-cli-types.log`). Added `packages/opencode/src/kilocode/voice/live-protocol.ts` tests in `packages/opencode/test/kilocode/live-protocol.test.ts`: 3 pass, 12 assertions, exit 0 (`.tmp/live-protocol-tests.log`); scoped oxlint 0 warnings/0 errors (`.tmp/live-protocol-lint.log`). Coverage is context admission only: fresh user evidence, duplicate/time/offset rejection, and prompt uncertainty labels. No LiveBroker, WebRTC, duration receipt or SDK regeneration.

## 2026-09-11: LiveBroker loopback fixtures

**States:** LiveBroker HTTP/WebSocket fixtures verified locally, committed as `43e7bc7116`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Trusted-host `LiveBroker` now uses a real loopback provider/backend peer. Creation forbids browser mutation events (`allowed_client_events: []`), delivers SDP before `session.started`, and closes an unstarted paid call through an injectable host timeout plus `session.close`/hangup/DELETE. Mute/share wait for started. `session.closed` duration is posted once without reopening work; a later conflicting closed event marks usage incomplete without a second duration POST. Staging an image does not dispatch work; later client delegation narrates only a completed result that includes text, assistant message identity and evidence. Failed work is spoken as a status, not as success. LiveCommands correlate mute/commentary acknowledgement, reject identity reuse, keep unknown close outcomes and do not retry a failed send.

Changed files: `packages/kilo-vscode/src/speech/live-broker.ts`, `packages/kilo-vscode/src/speech/live-commands.ts`, `packages/kilo-vscode/src/shared/live-context.ts`, `packages/kilo-vscode/src/shared/live-usage.ts`, `packages/kilo-vscode/src/shared/speech.ts` (`OPENAI_LIVE_MODEL`, optional `openai-live` engine value; default remains `openai-realtime`), `packages/kilo-vscode/tests/unit/live-broker.test.ts`, `packages/kilo-vscode/tests/unit/live-commands.test.ts`.

Commands (`packages/kilo-vscode` unless noted): `bun test tests/unit/live-broker.test.ts tests/unit/live-commands.test.ts --timeout 30000` -> 9 pass / 0 fail / 198 assertions / exit 0 (`.tmp/live-broker-tests.log`). `bun run check-types` -> exit 0 (`.tmp/live-host-types.log`). Root oxlint on the six Live files: 24 warnings / 0 errors / exit 0 (`.tmp/live-broker-lint.log`).

Remaining: HTTP/SDK regeneration, WebRTC/UI fixtures, service/message routing, image four-attempt and hash-reuse cases, append token bounds, busy-queue steering, and RDM-01-06. Do not snapshot:install.

## 2026-09-11: Live duration and delegation store tests

**States:** Live SQL duration/delegation contracts verified locally, committed as `c3c7f6ae93`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Live bindings can retain a final `gpt-live-1` duration after close without reopening work. Identical retries succeed; a changed receipt or a Realtime binding is refused. Client delegation admits one immutable call ID per provider delegation, labels prompt text as imperfect transcript evidence, refuses a later delegation that only repeats consumed user sequence, and advances `liveCursor` only with new user evidence. Closing admission keeps duration writable and refuses new work. `liveCursor` is now a finite safe nonnegative integer in the retained payload schema.

Changed files: `packages/opencode/src/kilocode/voice/openai.ts`, `packages/opencode/src/kilocode/voice/openai-store.ts`, `packages/opencode/src/kilocode/voice/openai-protocol.ts`, `packages/opencode/src/kilocode/server/httpapi/groups/voice.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/voice.ts`, `packages/opencode/test/kilocode/voice-live.test.ts`.

Commands (`packages/opencode`): `bun test ./test/kilocode/voice-live.test.ts --timeout 30000` -> 4 pass / 0 fail / 27 assertions / exit 0 (`.tmp/voice-live-store-tests.log`). `bun test ./test/kilocode/voice-openai.test.ts --timeout 30000` -> 17 pass / 0 fail / 131 assertions / exit 0 (`.tmp/voice-openai-regression.log`). `bun run typecheck` -> exit 0 (`.tmp/voice-live-store-types.log`). Root oxlint on the six files: 0 errors (`.tmp/voice-live-store-lint.log`).

Remaining: parent-deletion/late-write duration cases, HTTP/SDK regeneration, WebRTC/UI fixtures, and RDM-01-06. Do not snapshot:install.

Next executable step: remaining Live host image four-attempt/hash-reuse cases and SDK regeneration. Do not change the default engine or package Live.

## 2026-09-11: Live image bounds and context selection

**States:** host image identity/four-attempt/unknown-receipt and LiveContext selection verified locally, committed as `a36f735be5`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Same image ID with the same bytes is idempotent; a different payload reusing that ID is refused. Four staging attempts are retained; a fifth is refused. Invalid image URLs never POST. A mismatched storage receipt is retained as unknown and does not emit thinking or dispatch work. LiveContext selects fresh user evidence once, ignores client-correlated fragments, blocks selection after a gap, and treats conflicting delegation offsets as invalid.

Changed files: `packages/kilo-vscode/tests/unit/live-broker.test.ts`, `packages/kilo-vscode/tests/unit/live-context.test.ts`.

Commands (`packages/kilo-vscode`): `bun test tests/unit/live-broker.test.ts tests/unit/live-context.test.ts tests/unit/live-commands.test.ts --timeout 30000` -> 14 pass / 0 fail / 309 assertions / exit 0 (`.tmp/live-image-context-tests.log`). `bun run check-types` -> exit 0 (`.tmp/live-image-host-types.log`). Root oxlint: 23 warnings / 0 errors / exit 0 (`.tmp/live-image-context-lint.log`).

Remaining: SDK regeneration, WebRTC/UI fixtures, service/message routing, and RDM-01-06. Do not snapshot:install.

Next executable step: regenerate the SDK for Live duration/delegation HTTP endpoints. Do not change the default engine or package Live.

## 2026-09-11: Live SDK regeneration

**States:** generated SDK includes Live call/duration, committed as `cf4812731c`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

`packages/sdk/js` now generates `KilocodeVoiceLiveCall` and `KilocodeVoiceLiveDuration` plus `client.voice.live.call` / `duration` against `/kilocode/voice/live/session/{id}/calls` and `/duration`. OpenAI start bindings include optional model `gpt-live-1`. Generated OpenAPI number unions still mention NaN/Infinity; the backend continues to reject non-finite seconds.

Changed files: `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`.

Commands: `bun ./script/build.ts` in `packages/sdk/js` exit 0 (`.tmp/live-sdk-generate.log`). `bun run typecheck` in `packages/sdk/js` exit 0 (`.tmp/live-sdk-types.log`).

Remaining: host speech service/message routing, HTTP contract tests, and RDM-01-06. Do not snapshot:install.

Next executable step: host speech service routing through `input-tools` and the webview message unions. Do not change the default engine or package Live.

## 2026-09-11: Live WebRTC peer and microphone readiness

**States:** Live WebRTC fixture committed as `aedb662960`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Production `LiveVoice` now shares one readiness predicate for listening and mute. A Chromium fixture with synthetic audio proved capture stays disabled until both host `started(requestID)` and local answer/peer/channel readiness; host start before SDP, after SDP, after disconnect and for a stale request ID cannot enable the microphone early. Duplicate start, stop during SDP and microphone acquisition, failed exchange cleanup, wrong-request finalization, display-only captions and a single oversized/unreadable failure are covered. Oversized payloads are injected on the local data-channel handler because SCTP cannot carry 524KiB. The 12-second cleanup timeout path was not waited.

Changed files: `packages/kilo-vscode/webview-ui/src/context/live-voice.ts`, `packages/kilo-vscode/tests/fixtures/live-voice.mjs`, `packages/kilo-vscode/tests/unit/live-voice.test.ts`.

Commands (packages/kilo-vscode): `bun test tests/unit/live-voice.test.ts --timeout 50000` -> 1 pass / 0 fail / 2 expect / exit 0 (`.tmp/live-webrtc-tests.log`). `bun run check-types` -> exit 0 (`.tmp/live-webrtc-types.log`). `bun run check-types:webview` -> exit 0 (`.tmp/live-webrtc-webview-types.log`). Root oxlint: 2 warnings / 0 errors / exit 0 (`.tmp/live-webrtc-lint.log`).

Remaining: VoiceProvider/UI integration, HTTP contract tests, and RDM-01-06. Do not snapshot:install.

Next executable step: VoiceProvider/UI integration for Live captions, duration, controls and recovery. Do not change the default engine or package Live.

## 2026-09-11: Live host speech routing

**States:** host speech routing committed as `c2be6ece9f`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

`routeInputToolMessage` now validates Live start/control/image/stop payloads and forwards `engine: "live"` to SpeechService. LiveBroker is used only when saved settings are `openai-live`. Unknown control actions post `speechLiveControlResult` failed. Configuration errors from Live start are returned to the webview without keys or backend passwords. CLI mirror still omits the OpenAI key. Native Live does not speak cascade replies.

Changed files: `packages/kilo-vscode/src/services/input-tools.ts`, `packages/kilo-vscode/src/speech/service.ts`, `packages/kilo-vscode/src/speech/settings.ts`, `packages/kilo-vscode/src/speech/live-broker.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`, `packages/kilo-vscode/tests/unit/live-speech-routing.test.ts`.

Commands (packages/kilo-vscode): `bun test tests/unit/live-speech-routing.test.ts tests/unit/live-broker.test.ts --timeout 30000` -> 12 pass / 0 fail / 283 expect / exit 0 (`.tmp/live-speech-routing-tests.log`). `bun run check-types` -> exit 0 (`.tmp/live-routing-types.log`). `bun run check-types:webview` -> exit 0 (`.tmp/live-routing-webview-types.log`). Root oxlint: 11 warnings / 0 errors / exit 0 (`.tmp/live-routing-lint.log`).

Remaining: HTTP contract tests and RDM-01-06. Do not snapshot:install.

Next executable step: HTTP contract tests for Live duration/delegation, then RDM-01-06. Do not change the default engine or package Live.

## 2026-09-11: Live VoiceProvider UI

**States:** VoiceProvider UI committed as `7f70d78c96`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Production VoiceProvider keeps the Auto agent, waits for host `speechLiveStarted`, correlates Live control acknowledgements, requires Resume after stop-speaking, labels 64-fragment caption truncation, and clears captions/duration on task switch. Duration updates require matching call/recovery and parent task. Images state they go to Raya work, not GPT-Live.

Changed files: `packages/kilo-vscode/webview-ui/src/context/voice.tsx`, `packages/kilo-vscode/webview-ui/src/context/voice-images.ts`, `packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceControls.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceImage.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceRecovery.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/NativeVoiceUsage.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/VoiceTranscript.tsx`, `packages/kilo-vscode/webview-ui/src/components/settings/SpeechTab.tsx`, `packages/kilo-vscode/tests/fixtures/composer-entry.jsx`, `packages/kilo-vscode/tests/fixtures/live-voice-ui.mjs`, `packages/kilo-vscode/tests/unit/live-voice-ui.test.ts`.

Commands (packages/kilo-vscode): `bun test tests/unit/live-voice-ui.test.ts --timeout 130000` -> 1 pass / 0 fail / 2 expect / exit 0 (`.tmp/live-voice-ui-tests.log`). `bun run check-types:webview` -> exit 0 (`.tmp/live-ui-webview-types.log`). Root oxlint: 9 warnings / 0 errors / exit 0 (`.tmp/live-ui-lint.log`).

Remaining: packaged microphone acceptance and RDM-01-06. Do not snapshot:install.

Next executable step: RDM-01-06 agent DM inbox and tracked worker-to-worker delegation. Do not change the default engine or package Live.

## 2026-09-11: Live HTTP contracts

**States:** Live HTTP contracts committed as `f293a93bf2`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Shipped HTTP routes require server auth and the voice capability for Live call and duration. Invalid or assistant-only context is 400. The first delegation is admitted once; an identical retry returns the same call; a consumed user sequence is 409. Closing admission refuses new work and still accepts an immutable duration receipt. Deleting the parent session makes later duration and call writes 404 and does not resurrect the row; a sibling Live binding can still record duration.

Changed files: `packages/opencode/test/kilocode/server/httpapi-voice-live.test.ts`.

Commands (packages/opencode): `bun test ./test/kilocode/server/httpapi-voice-live.test.ts --timeout 60000` -> 1 pass / 0 fail / 43 expect / exit 0 (`.tmp/live-http-tests.log`). Root oxlint: 0 warnings / 0 errors / exit 0 (`.tmp/live-http-lint.log`).

Remaining: packaged microphone acceptance and RDM-01-06. Do not snapshot:install.

Next executable step: RDM-01-06 agent DM inbox and tracked worker-to-worker delegation. Do not change the default engine or package Live.

## 2026-09-11: Routine inbox persistence

**States:** Routine inbox persistence committed as `270517a5a8`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Existing roster `agent.id` is the worker identity. Each roster worker gets one durable conversation (`rcv_` plus a hash of the agent id). Messages are idempotent on `(agent_id, source)`: identical retries return the same row, a changed body is 409. Unread counts exclude user follow-ups. Read position only advances. Drafts are stored on the conversation and are not messages. Deleting a conversation cascades its messages and rejects late inserts. HTTP list/page/send/read/draft require a current roster worker. SDK `kilocode.routine.inbox*` methods were regenerated. This does not yet publish run reports, dispatch follow-ups, or render the messenger UI.

Changed files: `packages/core/src/kilocode/routine.sql.ts`, `packages/core/src/database/migration/20260911033250_kilocode-routine-inbox.ts`, `packages/core/src/database/migration.gen.ts`, `packages/core/src/database/schema.gen.ts`, `packages/core/schema.json`, `packages/opencode/src/kilocode/task/inbox.ts`, `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/opencode/test/kilocode/task/inbox.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-inbox.test.ts`, `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, `packages/sdk/openapi.json`, `.changeset/raya-routine-inbox.md`.

Commands (packages/opencode): `bun test ./test/kilocode/task/inbox.test.ts ./test/kilocode/server/httpapi-routine-inbox.test.ts --timeout 60000` -> 3 pass / 0 fail / 48 expect / exit 0 (`.tmp/routine-inbox-tests.log`). Root oxlint: 0 warnings / 0 errors / exit 0. Root `bun ./script/generate.ts` -> exit 0.

Remaining: occurrence report publication, follow-up dispatch, inbox UI, and RDM-04 delegation. Do not snapshot:install.

Next executable step: publish scheduled occurrence results into the same worker conversation. Do not change the default engine or package Live.

## 2026-09-11: Routine inbox report publication

**States:** Routine inbox report publication committed as `9532fff643`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

`settle` and `park` now publish into the same worker conversation. Running goals do not publish. Complete runs post `report:<run.id>` with honest findings; an empty summary is labelled as missing findings, not invented success. Waiting-on-you posts `need:<run.id>` as a decision, not a completed report. A later completion of that run posts a second message. Timer occurrence ids with brackets are hashed into a valid source and omitted from `occurrenceID`. Identical retries keep the first receipt; a missing database skips publication without failing settlement.

Changed files: `packages/opencode/src/kilocode/task/inbox.ts`, `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/test/kilocode/task/inbox.test.ts`, `packages/opencode/test/kilocode/task/inbox-report.test.ts`, `.changeset/raya-routine-inbox-reports.md`.

Commands (packages/opencode): `bun test ./test/kilocode/task/inbox.test.ts ./test/kilocode/task/inbox-report.test.ts ./test/kilocode/task.test.ts --timeout 60000` -> 65 pass / 0 fail / 611 expect / exit 0 (`.tmp/routine-inbox-report-tests.log`). `bun run typecheck` -> exit 0 (`.tmp/routine-inbox-report-types.log`).

Remaining: inbox UI, follow-up dispatch, and RDM-04 delegation. Do not snapshot:install.

Next executable step: RDM conversation UI on the routines surface. Do not change the default engine or package Live.

## 2026-09-11: Routine inbox conversation UI

**States:** Routine inbox conversation UI committed as `efb574bebd`; Live remains unshipped. Product checkpoint remains `8b01e72311`.

The routines surface is a two-pane messenger: searchable worker list with unread and operational state, selected conversation on the right. Reports, decisions and user follow-ups render in one timeline. Sending persists an idempotent follow-up and retries the same source; it does not start a run. Drafts are saved per conversation. A later report does not steal composer focus or overwrite the draft. Existing roster actions (pause, schedule, access, output, run review) remain on the list.

Changed files: `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/src/kilo-provider/routine-refresh.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/webview-ui/src/styles/routines.css`, `packages/kilo-vscode/tests/unit/routines-inbox.test.ts`, `packages/kilo-vscode/tests/unit/routines-inbox-view.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-inbox-view.mjs`, `packages/kilo-vscode/tests/unit/routine-refresh.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-edit-view.mjs`, `.changeset/raya-routine-inbox-ui.md`.

Commands (packages/kilo-vscode): `bun test tests/unit/routines-inbox.test.ts tests/unit/routines-inbox-view.test.ts tests/unit/routine-refresh.test.ts tests/unit/routine-refresh-view.test.ts tests/unit/routines-edit-view.test.ts tests/unit/routines-access.test.ts --timeout 120000` -> 11 pass / 0 fail / 181 expect / exit 0 (`.tmp/routine-inbox-ui-tests.log`). `bun run check-types` -> exit 0. `bun run check-types:webview` -> exit 0.

Remaining: follow-up dispatch, RDM-02.6 execution-session exclusion, and RDM-04 delegation. Do not snapshot:install.

Next executable step: route a saved follow-up to the selected worker without rewriting the assignment. Do not change the default engine or package Live.

## 2026-09-11: Routine follow-up dispatch

**States:** Follow-up dispatch verified locally; Live remains unshipped. Product checkpoint remains `8b01e72311`.

A saved inbox follow-up now dispatches to the selected worker. A new message starts one manual run whose goal is answering the question with standing assignment and recent reports as context. The roster objective and schedule stay unchanged, including for a paused worker. Identical retries reuse the same source and do not start a second worker. Waiting-on-you resumes the same session. Busy workers are steered at the next safe boundary rather than aborted. Composer copy no longer claims that send does not start a run.

Changed files: `packages/opencode/src/kilocode/task/inbox.ts`, `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts`, `packages/opencode/test/kilocode/task/inbox.test.ts`, `packages/opencode/test/kilocode/task/inbox-followup.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-inbox.test.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/tests/fixtures/routine-inbox-view.mjs`, `packages/sdk/openapi.json`, `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `.changeset/raya-routine-followup.md`.

Commands (cwd `packages/opencode` unless noted): `bun test ./test/kilocode/task/inbox-followup.test.ts ./test/kilocode/task/inbox.test.ts ./test/kilocode/task/inbox-report.test.ts --timeout 30000` -> 6 pass / 0 fail / 69 expect / exit 0 (`.tmp/routine-followup-unit.log`). `bun test ./test/kilocode/server/httpapi-routine-inbox.test.ts --timeout 60000` -> 1 pass / 0 fail / 34 expect / exit 0 (`.tmp/routine-followup-http.log`). Combined re-run of follow-up, inbox and HTTP tests -> 6 pass / 0 fail / 90 expect / exit 0 (`.tmp/routine-followup-tests.log`). `bun test ./test/kilocode/task.test.ts --timeout 60000` -> 61 pass / 0 fail / 565 expect / exit 0. `bun run typecheck` -> exit 0 (`.tmp/routine-followup-types.log`). From `packages/kilo-vscode`: `bun test tests/unit/routines-inbox.test.ts tests/unit/routines-inbox-view.test.ts --timeout 120000` -> 2 pass / 0 fail / 7 expect / exit 0 (`.tmp/routine-followup-ui.log`); `bun run check-types` and `bun run check-types:webview` -> exit 0. Root `bun run script/check-opencode-annotations.ts --worktree` -> exit 0. Root `bun ./script/generate.ts` -> exit 0.

Remaining: RDM-04 worker-to-worker delegation. Busy-queue visibility in the composer is still inferred from operational state after refresh, not a dedicated queued badge. Do not snapshot:install.

Next executable step: add authorized worker-to-worker delegation with tracked responses. Do not change the default engine or package Live.

## 2026-09-11: Routine execution sessions excluded from default chat lists

**States:** RDM-02.6 session-list exclusion verified locally; Live remains unshipped. Product checkpoint remains `8b01e72311`.

Default `/session` and experimental session lists omit sessions marked with `rayaRoutine` metadata. Ordinary chats stay listed even if their title looks like a worker name. Routine execution sessions remain readable by id for run details, and `kind=routine` or `kind=all` lists them explicitly. History is not deleted.

Changed files: `packages/opencode/src/kilocode/session/index.ts`, `packages/opencode/src/session/session.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts`, `packages/opencode/test/kilocode/session-list.test.ts`, `packages/opencode/test/kilocode/server/httpapi-session-list.test.ts`, `packages/sdk/openapi.json`, `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, `.changeset/raya-routine-session-list.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/session-list.test.ts ./test/kilocode/server/httpapi-session-list.test.ts ./test/server/session-list.test.ts --timeout 60000` -> 15 pass / 0 fail / 47 expect / exit 0 (`.tmp/routine-session-list-tests.log`). `bun test ./test/server/experimental-session-list.test.ts --timeout 60000` -> 4 pass / 0 fail / 22 expect / exit 0. `bun run typecheck` -> exit 0 (`.tmp/routine-session-list-types.log`). Root `bun run script/check-opencode-annotations.ts --worktree` -> exit 0. Root `bun ./script/generate.ts` -> exit 0.

Remaining: RDM-04 worker-to-worker delegation.

Next executable step: add authorized worker-to-worker delegation with tracked responses. Do not change the default engine.

## 2026-09-11: Snapshot install `683a82b837`

**States:** committed, pushed and installed as `683a82b837`. Live remains not the default engine.

Installed `eden.raya@7.4.23-snapshot+683a82b837.kamil-oseni.1789151453866`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-683a82b837-kamil-oseni-1789151453866.vsix`; SHA-256 `1F56B9C6D9E3FFBCC655AE41A39043CD69A60BC34EFEF36233C9DFC2ECB372BA`; 516848111 bytes, 430 entries, CLI 228634112 bytes. Production lint required splitting Live and routines handlers under the complexity cap (`35aa42ef81`, `683a82b837`). Telemetry transport settlement is `a0024a4f77`. Default engine is still `openai-realtime`.

## 2026-09-11: Worker-to-worker delegation store and Chief-to-Accounting flow

**States:** RDM-04 request/response runtime verified locally; Live remains not the default engine. Product checkpoint remains `683a82b837`.

A roster worker can ask another roster worker for a tracked result. The request is durable and idempotent on source. Self-delegation, workspace-crossing, cycles, depth above 3 and more than 4 outstanding children are refused. A paused recipient fails without being enabled. A busy recipient stays queued; the next idle take starts one overlay run without rewriting either standing assignment. Read-only senders force the child session to brief access. Completing the child writes a reply card that does not invent success. `POST /kilocode/agent/:agentID/delegate` and `GET .../delegate/:id` are the inspectable HTTP surface.

Changed files: `packages/core/src/kilocode/routine.sql.ts`, `packages/core/src/database/migration/20260911183445_kilocode-routine-delegation.ts`, `packages/core/src/database/schema.gen.ts`, `packages/core/src/database/migration.gen.ts`, `packages/core/schema.json`, `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/opencode/test/kilocode/task/delegation.test.ts`, `packages/opencode/test/kilocode/task/delegation-runner.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-delegate.test.ts`, `packages/sdk/openapi.json`, `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, `.changeset/raya-routine-delegation.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/delegation.test.ts ./test/kilocode/task/delegation-runner.test.ts ./test/kilocode/server/httpapi-routine-delegate.test.ts ./test/kilocode/task/inbox-followup.test.ts --timeout 60000` -> 7 pass / 0 fail / 74 expect / exit 0. `bun run typecheck` -> exit 0. Root `bun run script/check-opencode-annotations.ts --worktree` -> exit 0. Root `bun ./script/generate.ts` -> exit 0.

Remaining: UI to start/inspect a delegation from routines, explicit cancel/stop controls, and cost-attribution review. Do not snapshot:install until the UI increment is included.

Next executable step: expose delegation cards and a Chief-to-Accounting action on the routines surface. Do not change the default engine.

## 2026-09-11: Routines UI for worker-to-worker delegation

**States:** RDM-04 start/inspect UI verified locally, committed as `ad316af1d1`, and installed in the snapshot below. Live remains not the default engine.

A worker conversation can ask another roster worker. The host calls `POST /kilocode/agent/:agentID/delegate` with a stable source, then refreshes inbox summaries. Retry reuses the same source. The sender conversation shows "Asked another worker"; the recipient conversation shows "Asked you". Copy states that neither assignment is rewritten.

Changed files: `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/webview-ui/src/styles/routines.css`, `packages/kilo-vscode/tests/unit/routines-inbox.test.ts`, `packages/kilo-vscode/tests/unit/routines-delegate-view.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-delegate-view.mjs`, `.changeset/raya-routine-delegate-ui.md`.

Commands (cwd `packages/kilo-vscode`): `bun test ./tests/unit/routines-inbox.test.ts ./tests/unit/routines-delegate-view.test.ts ./tests/unit/routines-inbox-view.test.ts --timeout 90000` -> 4 pass / 0 fail / 13 expect / exit 0 (`.tmp/routine-delegate-ui-tests.log`). `bun run typecheck` -> exit 0 (`.tmp/routine-delegate-ui-types.log`). eslint on changed files -> exit 0 (`.tmp/routine-delegate-ui-lint.log`).

Remaining after this checkpoint: explicit cancel/stop controls, cost-attribution review, busy-recipient/denial/timeout UI cases, inspectable chain in UI, and RDM-06 Friday accounting E2E. Do not change the default engine.

Next executable step: add user controls to stop outstanding delegated work, then cost attribution and the Friday accounting E2E.

## 2026-09-11: Snapshot install `ad316af1d1`

**States:** committed, pushed and installed as `ad316af1d1`. Live remains not the default engine.

Installed `eden.raya@7.4.23-snapshot+ad316af1d1.kamil-oseni.1789153704041`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-ad316af1d1-kamil-oseni-1789153704041.vsix`; SHA-256 `2F91ACCC1FE22E8B8E7AAC4421B78331AA6BB2379A2791A856E4A165349C38CC`; 519920967 bytes, 432 entries, CLI 228761600 bytes. Includes RDM-04 runtime `35eb802178` and routines start/inspect UI. Default engine is still `openai-realtime`. First CLI compile hit EPERM moving `kilo.exe`; the snapshot retried via the active bun runtime and completed.

Remaining: explicit cancel/stop, cost-attribution review, and RDM-06 Friday accounting E2E. Do not change the default engine.

Next executable step: add user controls to stop outstanding delegated work.

## 2026-09-11: Stop outstanding delegated work

**States:** RDM-04 cancel/stop verified locally, committed as `153189583a`, and installed in the snapshot below. Live remains not the default engine.

Stopping an outstanding request marks it cancelled, cancels live descendants, and keeps completed child results. Queued work never starts. Running child sessions are halted through the existing session cancel path. Retry is idempotent. Neither standing assignment is rewritten. `POST /kilocode/agent/:agentID/delegate/:id/cancel` is the inspectable HTTP surface. The worker conversation shows **Stop this request** on outstanding ask/sent cards until a reply card arrives.

Changed files: `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/opencode/test/kilocode/task/delegation.test.ts`, `packages/opencode/test/kilocode/task/delegation-runner.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-delegate.test.ts`, `packages/sdk/openapi.json`, `packages/sdk/js/src/v2/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts`, `packages/kilo-vscode/tests/unit/routines-inbox.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-delegate-view.mjs`, `.changeset/raya-routine-delegate-cancel.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/delegation.test.ts ./test/kilocode/task/delegation-runner.test.ts ./test/kilocode/server/httpapi-routine-delegate.test.ts --timeout 60000` -> 7 pass / 0 fail / 73 expect / exit 0 (`.tmp/routine-delegate-cancel-runtime.log`). `bun run typecheck` -> exit 0. Root `bun ./script/generate.ts` -> exit 0. Cwd `packages/kilo-vscode`: `bun test ./tests/unit/routines-inbox.test.ts ./tests/unit/routines-delegate-view.test.ts ./tests/unit/routines-inbox-view.test.ts --timeout 90000` -> 5 pass / 0 fail / 17 expect / exit 0 (`.tmp/routine-delegate-cancel-ui-tests.log`). `bun run typecheck` -> exit 0. eslint on changed files -> exit 0.

Remaining: cost-attribution review and RDM-06 Friday accounting E2E. Do not change the default engine.

Next executable step: attribute delegated costs to the child request and parent/company without double counting, then run the Friday accounting E2E.

## 2026-09-11: Snapshot install `153189583a`

**States:** committed, pushed and installed as `153189583a`. Live remains not the default engine.

Installed `eden.raya@7.4.23-snapshot+153189583a.kamil-oseni.1789155622428`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-153189583a-kamil-oseni-1789155622428.vsix`; SHA-256 `19D83A8D47588B87723577CE1BA318B7E035D30A091A78D3686A84BC2BCC0A81`; 519935769 bytes, 432 entries, CLI 228771840 bytes. Includes stop/cancel for outstanding worker-to-worker requests. Default engine is still `openai-realtime`.

Remaining: commit, push, and snapshot:install this cost attribution, then RDM-06 Friday accounting E2E. Do not change the default engine.

Next executable step: commit, push, and snapshot:install delegated cost attribution, then run the Friday accounting E2E.

## 2026-09-11: Delegated cost attribution (RDM-04.6)

**States:** RDM-04.6 verified locally, committed as `e22ecc09cd`, and installed in the snapshot below. Live remains not the default engine.

Child request cost is stored as a real amount on the delegation record. The requesting worker's standing-job total stays the cost of that worker's own session. A coordinating report lists contributing requests and distinguishes completed replies from pending input. Missing cost is stated as not recorded; no amount is invented. A conversation ask during outstanding work may attach the parent run; idle conversation asks stay on the child request only.

Changed files: `packages/core/src/kilocode/routine.sql.ts`, `packages/core/src/database/migration/20260911194749_kilocode-routine-delegation-cost.ts`, `packages/core/src/database/migration.gen.ts`, `packages/core/src/database/schema.gen.ts`, `packages/core/schema.json`, `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/opencode/test/kilocode/task/delegation.test.ts`, `packages/opencode/test/kilocode/task/delegation-runner.test.ts`, `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`, `packages/kilo-vscode/tests/unit/routines-inbox.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-delegate-view.mjs`, `.changeset/raya-routine-delegate-cost.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/delegation.test.ts ./test/kilocode/task/delegation-runner.test.ts ./test/kilocode/server/httpapi-routine-delegate.test.ts --timeout 60000` -> 9 pass / 0 fail / 97 expect / exit 0 (`.tmp/routine-delegate-cost-runtime.log`). `bun run typecheck` -> exit 0. Cwd `packages/kilo-vscode`: `bun test ./tests/unit/routines-inbox.test.ts ./tests/unit/routines-delegate-view.test.ts ./tests/unit/routines-inbox-view.test.ts --timeout 90000` -> 6 pass / 0 fail / 19 expect / exit 0 (`.tmp/routine-delegate-cost-ui-tests.log`). `bun run typecheck` -> exit 0. eslint on changed files -> exit 0. Cwd `packages/core`: `bun run typecheck` -> exit 0. Root `bun run script/check-opencode-annotations.ts --worktree` -> exit 0.

Remaining: RDM-06 Friday accounting E2E, then leftover busy-recipient/denial/timeout/inspectable-chain UI and lifecycle cases. Do not change the default engine.

Next executable step: run the Friday accounting E2E.

## 2026-09-11: Snapshot install `e22ecc09cd`

**States:** committed, pushed and installed as `e22ecc09cd`. Live remains not the default engine.

Installed `eden.raya@7.4.23-snapshot+e22ecc09cd.kamil-oseni.1789157400180`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-e22ecc09cd-kamil-oseni-1789157400180.vsix`; SHA-256 `3796EE106468055EA522DE0B0903BAB91575FAFB4C107B387AB04BF27FD974A2`; 517016892 bytes, 431 entries, CLI 228785664 bytes. Includes delegated cost attribution without double counting. Default engine is still `openai-realtime`.

Remaining: commit, push, and snapshot:install this Friday accounting E2E, then leftover busy-recipient/denial/timeout/inspectable-chain UI and lifecycle cases. Do not change the default engine.

Next executable step: commit, push, and snapshot:install the Friday accounting E2E.

## 2026-09-11: Friday accounting E2E (RDM-06)

**States:** RDM-06 Friday scenario verified locally, committed as `c67a5b309b`, and installed in the snapshot below. Live remains not the default engine. This does not close the rest of RDM-06.

An accountant assignment with an explicit `America/New_York` Friday 6pm calendar is started by the real scheduler tick within the 60-second catch-up window. A due tick before the occurrence creates no run. The first occurrence publishes one durable inbox report with inspectable criterion evidence. A contextual follow-up uses that report, does not rewrite the assignment, and does not invent figures. After the follow-up settles, the next Friday occurrence publishes into the same conversation. The conversation surface keeps both occurrence reports and the follow-up visible.

Changed files: `packages/opencode/test/kilocode/task/friday-accounting.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-inbox-view.mjs`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/friday-accounting.test.ts ./test/kilocode/task/inbox-followup.test.ts ./test/kilocode/task/inbox-report.test.ts --timeout 60000` -> 4 pass / 0 fail / 72 expect / exit 0 (`.tmp/routine-friday-accounting-runtime.log`). `bun run typecheck` -> exit 0. Cwd `packages/kilo-vscode`: `bun test ./tests/unit/routines-inbox-view.test.ts --timeout 90000` -> 1 pass / 0 fail / 1 expect / exit 0 (`.tmp/routine-friday-accounting-ui-tests.log`).

Remaining: leftover busy-recipient, denial, timeout, inspectable chain in UI, and lifecycle rename/archive cases. Do not change the default engine.

Next executable step: leftover RDM-06 UI/lifecycle cases.

## 2026-09-11: Snapshot install `c67a5b309b`

**States:** committed, pushed and installed as `c67a5b309b`. Live remains not the default engine.

Installed `eden.raya@7.4.23-snapshot+c67a5b309b.kamil-oseni.1789158414726`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-c67a5b309b-kamil-oseni-1789158414726.vsix`; SHA-256 `19AF3814395CBE216F9B4EB9C79AC88F85AF2E92E0AC9B2D19ADC4835F48A599`; 519952279 bytes, 432 entries, CLI 228785664 bytes. Includes the Friday accounting E2E proving scheduled reports and follow-ups stay in one conversation. Default engine is still `openai-realtime`.

Remaining: leftover busy-recipient, denial, timeout, inspectable chain in UI, and lifecycle rename/archive cases. Do not change the default engine.

Next executable step: leftover RDM-06 UI/lifecycle cases.

## 2026-09-11: GPT-Live 1 default engine

**States:** GPT-Live 1 default verified locally, committed as `d4e5384528`, and installed in the snapshot below. This does not close Live microphone/acoustic acceptance, busy-queue steering, append token bounds, or provider-switch disposal.

New setups use `openai-live` and `POST /v1/live/sessions` with `gpt-live-1`. Absent or invalid engine values adopt Live. Saved `openai-realtime`, `qwen-realtime` and `cascade-v1` values stay. Speech settings show `gpt-live-1`. LiveCommands ignore a late acknowledgement after timeout and refuse a 257th command. LiveVoice releases local media after an injectable linger when the host never sends `finalized`.

Changed files: `packages/kilo-vscode/src/shared/speech.ts`, `packages/kilo-vscode/src/speech/live-commands.ts`, `packages/kilo-vscode/webview-ui/src/context/live-voice.ts`, `packages/kilo-vscode/webview-ui/src/components/settings/SpeechTab.tsx`, `docs/Raya-OpenAI-Voice-Default.md`, `.changeset/raya-gpt-live-default.md`, plus matching unit/fixture/browser tests.

Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/live-commands.test.ts tests/unit/voice-config-swap.test.ts tests/unit/live-speech-routing.test.ts tests/unit/speech-default-settings.test.ts tests/unit/openai-provider.test.ts --timeout 60000` -> 12 pass / 0 fail / 102 expect / exit 0. `bun test tests/unit/live-voice.test.ts --timeout 90000` -> 1 pass / 0 fail / 2 expect / exit 0. `bun test tests/unit/live-voice-ui.test.ts tests/unit/live-broker.test.ts tests/unit/live-commands.test.ts --timeout 90000` -> 13 pass / 0 fail. `bun run check-types` and `bun run check-types:webview` -> exit 0. eslint on touched files -> exit 0.

Remaining: packaged microphone/acoustic acceptance, busy-queue steering, append token bounds, provider-switch/disposal, and leftover RDM-06 UI/lifecycle cases.

Next executable step: leftover Live acceptance cases, then leftover RDM-06 UI/lifecycle cases.

## 2026-09-11: Snapshot install `d4e5384528`

**States:** committed, pushed and installed as `d4e5384528`. New voice setups default to GPT-Live 1.

Installed `eden.raya@7.4.23-snapshot+d4e5384528.kamil-oseni.1789159781902`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-d4e5384528-kamil-oseni-1789159781902.vsix`; SHA-256 `4D18A6523DDA25F823028EAC8844FE4AB845FF4B7C0340B268092F6725AFD30F`; 517019282 bytes, 431 entries, CLI 228785664 bytes. Includes GPT-Live 1 as the default voice engine over the Live API. Realtime remains an explicit compatibility path.

Remaining: packaged microphone/acoustic acceptance, busy-queue steering, append token bounds, provider-switch/disposal, and leftover RDM-06 UI/lifecycle cases.

Next executable step: leftover Live acceptance cases, then leftover RDM-06 UI/lifecycle cases.

## 2026-09-11: Live append bounds and busy-queue steering

**States:** verified locally, committed as `5d7b978226`, and installed in the snapshot below. This closes the Live append token-bound and busy-queue steering leftovers. It does not close packaged microphone/acoustic acceptance or provider-switch/disposal.

GPT-Live commentary, thinking and instruction appends now split on Unicode scalars at the documented 500-token bound (each scalar treated as at most one token). A fifth chunk is refused; overflow points the user to the task conversation instead of inventing the rest. Completed work is no longer sliced to 1000 characters. While backend work is busy, a later delegation is acknowledged with `session.thinking.append` and is not dispatched as a second call. If the user speaks after that queued request's offset, dequeue asks for clarification instead of repeating or replacing finished work.

Changed files: `packages/kilo-vscode/src/speech/live-append.ts`, `packages/kilo-vscode/src/speech/live-broker.ts`, `packages/kilo-vscode/src/shared/live-context.ts`, `packages/kilo-vscode/tests/unit/live-append.test.ts`, `packages/kilo-vscode/tests/unit/live-broker.test.ts`, `packages/kilo-vscode/tests/unit/live-context.test.ts`, `.changeset/raya-live-append-queue.md`.

Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/live-append.test.ts tests/unit/live-context.test.ts tests/unit/live-broker.test.ts tests/unit/live-commands.test.ts --timeout 60000` -> 18 pass / 0 fail / 376 expect / exit 0 (`packages/kilo-vscode/.tmp/live-append-busy-queue.log`). `bun run check-types` -> exit 0. eslint on touched files -> exit 0.

Remaining: packaged microphone/acoustic acceptance, provider-switch/disposal, and leftover RDM-06 UI/lifecycle cases.

Next executable step: leftover Live microphone/provider-switch cases or leftover RDM-06 UI/lifecycle.

## 2026-09-11: Snapshot install `5d7b978226`

**States:** committed, pushed and installed as `5d7b978226`. Live appends honor the 500-token bound; busy later delegations wait without a second call.

Installed `eden.raya@7.4.23-snapshot+5d7b978226.kamil-oseni.1789160589728`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-5d7b978226-kamil-oseni-1789160589728.vsix`; SHA-256 `837F2BF46EA53D3A1874A87ECFA72C3B41549416EDD66575C2B61EC290226E64`; 517020721 bytes, 431 entries. CLI binary already present (`bin\kilo.exe`, 218MB reported). Includes GPT-Live 1 as the default voice engine, 500-scalar append splitting, and busy-queue clarification. Realtime remains an explicit compatibility path.

Remaining: packaged microphone/acoustic acceptance, provider-switch/disposal, and leftover RDM-06 UI/lifecycle cases.

Next executable step: leftover Live microphone/provider-switch cases or leftover RDM-06 UI/lifecycle.

## 2026-09-11: Routine delegation queued, started, and paused denial

**States:** verified locally, committed as `506f944e64`, and installed in the snapshot below. This closes busy-recipient queued-versus-started cards and paused-worker denial in the conversation. It does not close timeout, inspectable chain in UI, or lifecycle rename/archive.

A queued ask publishes that the request has not started. Starting the child run adds a separate "Work started" card so the conversation can distinguish waiting from started work. A paused recipient stores a failed record, publishes a denial reply, and the ask form keeps the draft instead of treating the record as success.

Changed files: `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/test/kilocode/task/delegation.test.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/tests/fixtures/routine-delegate-view.mjs`, `.changeset/raya-routine-delegate-status.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/delegation.test.ts ./test/kilocode/task/delegation-runner.test.ts ./test/kilocode/server/httpapi-routine-delegate.test.ts --timeout 60000` -> 9 pass / 0 fail / 102 expect / exit 0. `bun run typecheck` -> exit 0. Commands (cwd `packages/kilo-vscode`): `bun test ./tests/unit/routines-inbox.test.ts ./tests/unit/routines-delegate-view.test.ts --timeout 90000` -> 5 pass / 0 fail / 18 expect / exit 0. `bun run typecheck` -> exit 0. eslint on `Inbox.tsx` -> exit 0.

Remaining: timeout, inspectable chain in UI, lifecycle rename/archive, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 timeout/inspectable-chain/lifecycle, or leftover Live microphone/provider-switch.

## 2026-09-11: Snapshot install `506f944e64`

**States:** committed, pushed and installed as `506f944e64`. Asks to another worker show queued versus started; a paused worker keeps the draft with a denial.

Installed `eden.raya@7.4.23-snapshot+506f944e64.kamil-oseni.1789161518503`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-506f944e64-kamil-oseni-1789161518503.vsix`; SHA-256 `EC441FB364A5AFA0ECB556C04BCE5F7242DD38610BC4F76CEAF2DF3DC48A2609`; 519959343 bytes, 432 entries. CLI binary rebuilt. Includes GPT-Live 1 as the default voice engine, 500-scalar append splitting, busy-queue clarification, and queued/started/paused delegation cards. Realtime remains an explicit compatibility path.

Remaining: timeout, inspectable chain in UI, lifecycle rename/archive, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 timeout/inspectable-chain/lifecycle, or leftover Live microphone/provider-switch.

## 2026-09-11: Delegation timeout expiry

**States:** verified locally, committed as `34beb5b5b7`, and installed in the snapshot below. This closes overdue live-request expiry. It does not close inspectable chain in UI or lifecycle rename/archive.

A live request with a deadline is not taken after that time. The scheduler tick fails it, publishes a timeout reply in the conversation, and does not start a child run. A start that is already past its deadline is refused the same way.

Changed files: `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/test/kilocode/task/delegation.test.ts`, `packages/opencode/test/kilocode/task/delegation-runner.test.ts`, `.changeset/raya-routine-delegate-timeout.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/delegation.test.ts ./test/kilocode/task/delegation-runner.test.ts --timeout 60000` -> 10 pass / 0 fail / 100 expect / exit 0. `bun run typecheck` -> exit 0.

Remaining: inspectable chain in UI, lifecycle rename/archive, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 inspectable chain/lifecycle, or leftover Live microphone/provider-switch.

## 2026-09-11: Snapshot install `34beb5b5b7`

**States:** committed, pushed and installed as `34beb5b5b7`. Overdue delegated requests expire with a timeout reply.

Installed `eden.raya@7.4.23-snapshot+34beb5b5b7.kamil-oseni.1789162560915`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-34beb5b5b7-kamil-oseni-1789162560915.vsix`; SHA-256 `0040A484C362603E8763F3FCB01DA636945AAE0F44E2376C941E8E6744A544CC`; 519964463 bytes, 432 entries. CLI binary rebuilt.

Remaining: inspectable chain in UI, lifecycle rename/archive, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 inspectable chain/lifecycle, or leftover Live microphone/provider-switch.

## 2026-09-11: Inspectable delegation chain

**States:** verified locally, committed as `8619b866fb`, and installed in the snapshot below. This closes inspectable parent and follow-on requests in the conversation. It does not close lifecycle rename/archive.

A stored request can be inspected as a chain of real records: parents first, then this request, then follow-on requests. The HTTP GET returns those stored rows. The conversation shows that lineage in place without leaving the thread or rewriting a draft.

Changed files: `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/opencode/test/kilocode/task/delegation.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-delegate.test.ts`, `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/tests/unit/routines-inbox.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-delegate-view.mjs`, `.changeset/raya-routine-delegate-chain.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/delegation.test.ts ./test/kilocode/server/httpapi-routine-delegate.test.ts --timeout 60000` -> 8 pass / 0 fail / 89 expect / exit 0. `bun run typecheck` -> exit 0. Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/routines-inbox.test.ts tests/unit/routines-delegate-view.test.ts --timeout 90000` -> 6 pass / 0 fail / 21 expect / exit 0. `bun run check-types` -> exit 0. eslint on `Inbox.tsx` and `routines.ts` -> exit 0.

Remaining: lifecycle rename/archive, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 lifecycle rename/archive, or leftover Live microphone/provider-switch.

## 2026-09-11: Snapshot install `8619b866fb`

**States:** committed, pushed and installed as `8619b866fb`. The conversation can inspect stored parent and follow-on worker requests.

Installed `eden.raya@7.4.23-snapshot+8619b866fb.kamil-oseni.1789164260348`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-8619b866fb-kamil-oseni-1789164260348.vsix`; SHA-256 `A0D707D4033214EAFD59C6DA99645920C6FDD7CAC0D77C0E4CD1F4D3E2878AE6`; 519975699 bytes, 432 entries. CLI binary rebuilt.

Remaining: lifecycle rename/archive, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 lifecycle rename/archive, or leftover Live microphone/provider-switch.

## 2026-09-11: Lifecycle rename and archive attribution

**States:** verified locally, committed as `75471436ab`, and installed in the snapshot below. This keeps historical reports on the same worker after rename and still readable after removal. It does not close schedule-edit-during-execution UI, leftover recipient-unavailability copy, themes, performance, or reviewer journey.

Renaming a worker updates the live conversation list name. Messages stay keyed by stable `agentID`, so the original report body remains. Removal is refused while delegated work is live. After a successful removal, GET conversation still returns the retained messages; send and delegate stay 404. The archive view loads that conversation in place and does not rewrite a draft. A paused worker with an active execution still shows as running. Stopping a live HTTP-started child run can still leave that run pending, so delete after cancel may fail with unfinished runs until the session settles.

Changed files: `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/src/kilocode/task/index.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/opencode/test/kilocode/task/inbox.test.ts`, `packages/opencode/test/kilocode/task.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-inbox.test.ts`, `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Archive.tsx`, `packages/kilo-vscode/tests/unit/routines-archive.test.ts`, `packages/kilo-vscode/tests/fixtures/routine-edit-view.mjs`, `.changeset/raya-routine-lifecycle-archive.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/inbox.test.ts ./test/kilocode/task.test.ts ./test/kilocode/server/httpapi-routine-inbox.test.ts --timeout 90000` -> first run 66 pass / 1 fail (live-delete-after-cancel poll); HTTP rerun 2 pass / 0 fail / 46 expect / exit 0 after isolating idle archive from live child runs. `bun run typecheck` -> exit 0. Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/routines-archive.test.ts tests/unit/routines-edit-view.test.ts --timeout 90000` -> 2 pass / 0 fail / 11 expect / exit 0; host retest after extract 1 pass / 0 fail / 10 expect / exit 0. `bun run check-types` -> exit 0. eslint on `routines.ts` and `Archive.tsx` -> exit 0 after extracting `retained`. Root `bun run script/check-opencode-promise-facades.ts` and `bun run script/check-opencode-annotations.ts --worktree` -> exit 0. oxlint on six opencode files: 21 existing warnings / 0 errors.

Remaining: leftover RDM-06 schedule-edit-during-execution UI, leftover recipient-unavailability copy beyond pause/archive, themes/a11y/performance/reviewer, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 lifecycle UI, or leftover Live microphone/provider-switch.

## 2026-09-11: Snapshot install `75471436ab`

**States:** committed, pushed and installed as `75471436ab`. Historical routine reports stay attributed after rename and remain readable in the archive.

Installed `eden.raya@7.4.23-snapshot+75471436ab.kamil-oseni.1789166470101`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-75471436ab-kamil-oseni-1789166470101.vsix`; SHA-256 `8A8D8D483536CC7F1B10FE84FEB0BEFAFF95882C0DD9E696E8166BD95F2C0A75`; 519982782 bytes, 432 entries. CLI binary rebuilt.

Remaining: leftover RDM-06 schedule-edit-during-execution UI, leftover recipient-unavailability copy beyond pause/archive, themes/a11y/performance/reviewer, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 lifecycle UI, or leftover Live microphone/provider-switch.

## 2026-09-11: Stop settles child runs

**States:** verified locally, committed as `54093915e1`, and installed in the snapshot below. Stopping a delegated request now marks its child run as error immediately, so the worker can be removed without waiting for the session to settle. Schedule-edit-during-execution UI, leftover recipient-unavailability copy, themes, performance, and reviewer journey remain open.

Changed files: `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/test/kilocode/task/delegation-runner.test.ts`, `.changeset/raya-routine-stop-settle.md`.

Commands (cwd `packages/opencode`): `bun test ./test/kilocode/task/delegation-runner.test.ts --timeout 60000` -> 4 pass / 0 fail / 41 expect / exit 0. `bun run typecheck` -> exit 0. oxlint on the two files: 12 existing warnings / 0 errors.

Remaining: leftover RDM-06 schedule-edit-during-execution UI, leftover recipient-unavailability copy beyond pause/archive, themes/a11y/performance/reviewer, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 lifecycle UI, or leftover Live microphone/provider-switch.

## 2026-09-11: Snapshot install `54093915e1`

**States:** committed, pushed and installed as `54093915e1`. Stopping a delegated request settles the child run so the worker can be removed.

Installed `eden.raya@7.4.23-snapshot+54093915e1.kamil-oseni.1789167625919`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-54093915e1-kamil-oseni-1789167625919.vsix`; SHA-256 `AA1D5411460C78D3B2528113D307AF2DF6F790572442F13C54BF640B1C74E021`; 519984830 bytes, 432 entries. CLI binary rebuilt.

Remaining: leftover RDM-06 schedule-edit-during-execution UI, leftover recipient-unavailability copy beyond pause/archive, themes/a11y/performance/reviewer, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 lifecycle UI, or leftover Live microphone/provider-switch.

## 2026-09-11: Schedule edit during a live run

**States:** verified locally, committed as `bf4218eece`, and installed in the snapshot below. Editing a schedule while a run is active tells the user the current work continues and the new schedule applies after it settles. A paused worker with a live run stays paused after save. Asking a paused worker is refused in the roster before send; that worker's own conversation still accepts follow-ups while scheduled starts stay off.

Changed files: `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/tests/fixtures/routine-edit-view.mjs`, `packages/kilo-vscode/tests/fixtures/routine-delegate-view.mjs`, `.changeset/raya-routine-lifecycle-copy.md`.

Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/routines-edit-view.test.ts tests/unit/routines-delegate-view.test.ts --timeout 90000` -> 2 pass / 0 fail / 2 expect / exit 0. `bun run check-types` -> exit 0. eslint on `RoutinesView.tsx` and `Inbox.tsx` -> exit 0. `bun run check-kilocode-change` -> no forbidden markers / exit 0.

Remaining: leftover RDM-06 themes/a11y/performance/reviewer, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 themes/a11y/performance/reviewer, or leftover Live microphone/provider-switch.

## 2026-09-11: Snapshot install `bf4218eece`

**States:** committed, pushed and installed as `bf4218eece`. Existing routine runs continue when the schedule is edited. Paused workers cannot start a new request until they are enabled.

Installed `eden.raya@7.4.23-snapshot+bf4218eece.kamil-oseni.1789170209577`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-bf4218eece-kamil-oseni-1789170209577.vsix`; SHA-256 `1785EBA5165DD6B4F20A0AF4D05F5E8BF1B18AD15E6D775B2A7F9A97F2A8309F`; 517052448 bytes, 431 entries. CLI binary already present; not rebuilt.

Remaining: leftover RDM-06 themes/a11y/performance/reviewer, packaged microphone/acoustic acceptance, and provider-switch/disposal.

Next executable step: leftover RDM-06 themes/a11y/performance/reviewer, or leftover Live microphone/provider-switch.

## 2026-09-11: Voice engine switch and disposal

**States:** verified locally, committed as `fd1882194a`, and installed in the snapshot below. Changing the saved voice engine waits until an active Live, OpenAI, or Qwen call is released. A mismatched stop does not end another engine's call. Host disposal closes brokers in order and refuses later starts.

Changed files: `packages/kilo-vscode/src/speech/service.ts`, `packages/kilo-vscode/tests/unit/speech-engine-switch.test.ts`, `.changeset/raya-voice-engine-switch.md`.

Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/speech-engine-switch.test.ts tests/unit/live-speech-routing.test.ts --timeout 30000` -> 5 pass / 0 fail / 30 expect / exit 0. `bun run check-types` -> exit 0. eslint on `service.ts` and the switch test -> exit 0. `bun run check-kilocode-change` -> no forbidden markers / exit 0.

Remaining: leftover RDM-06 themes/a11y/performance/reviewer and packaged microphone/acoustic acceptance.

Next executable step: leftover RDM-06 themes/a11y/performance/reviewer, or leftover Live microphone acceptance.

## 2026-09-11: Snapshot install `fd1882194a`

**States:** committed, pushed and installed as `fd1882194a`. Changing the saved voice engine waits until an active call is released. Host disposal refuses later starts.

Installed `eden.raya@7.4.23-snapshot+fd1882194a.kamil-oseni.1789170968855`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-fd1882194a-kamil-oseni-1789170968855.vsix`; SHA-256 `81816917C91BC7B16CEC97A52B89D3A7CAFFFBF1F760137D292A02E10D7399F9`; 517053245 bytes, 431 entries. CLI binary already present; not rebuilt.

Remaining: leftover RDM-06 themes/a11y/performance/reviewer and packaged microphone/acoustic acceptance.

Next executable step: leftover RDM-06 themes/a11y/performance/reviewer, or leftover Live microphone acceptance.

## 2026-09-11: Routine conversation return and report arrival

**States:** verified locally, committed as `9f6864dba8`, and installed in the snapshot below. Back and Escape leave a worker conversation and restore focus to that worker. The open thread is a labeled region. A report for another worker does not change the open conversation, overwrite a follow-up draft, or page that other inbox. A later report in the open conversation does not jump scroll when the reader is not at the bottom. Leaving with an unsent draft stores it.

Changed files: `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/tests/fixtures/routine-inbox-view.mjs`, `packages/kilo-vscode/tests/unit/routines-inbox-view.test.ts`, `.changeset/raya-routine-inbox-return.md`.

Commands (cwd `packages/kilo-vscode` unless noted): `bun test tests/unit/routines-inbox-view.test.ts tests/unit/routines-delegate-view.test.ts tests/unit/routines-edit-view.test.ts --timeout 90000` -> 3 pass / 0 fail / 3 expect / exit 0 (`.tmp/routine-inbox-return-tests.log`). `bun run check-types` -> exit 0. `bun run check-types:webview` -> exit 0 (`.tmp/routine-inbox-return-types.log`). Root oxlint on the two view files: 19 warnings / 0 errors / exit 0. eslint on `RoutinesView.tsx` and `Inbox.tsx` -> exit 0 (`.tmp/routine-inbox-return-lint.log`). `bun run check-kilocode-change` -> no forbidden markers / exit 0 (`.tmp/routine-inbox-return-markers.log`).

Remaining: leftover RDM-06 light/dark and narrow/wide Chromium, inbox performance budget, returning-reviewer journey, and packaged microphone/acoustic acceptance. Happy-dom fixtures stub CSS, so layout/theme is not claimed from that fixture.

Next executable step: leftover RDM-06 Chromium themes/narrow layout, inbox performance budget, or leftover Live microphone acceptance.

## 2026-09-11: Snapshot install `9f6864dba8`

**States:** committed, pushed and installed as `9f6864dba8`. Back and Escape restore the same worker. Other-worker reports do not steal the open conversation.

Installed `eden.raya@7.4.23-snapshot+9f6864dba8.kamil-oseni.1789172347425`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-9f6864dba8-kamil-oseni-1789172347425.vsix`; SHA-256 `DBAECF0B3706C8B32A4FABA80EF3FA5F13A33F5EEA12A0EA2E657B39CAE319E3`; 517060407 bytes, 431 entries. CLI binary already present; not rebuilt.

Remaining: leftover RDM-06 light/dark and narrow/wide Chromium, inbox performance budget, returning-reviewer journey, and packaged microphone/acoustic acceptance.

Next executable step: leftover RDM-06 Chromium themes/narrow layout, inbox performance budget, or leftover Live microphone acceptance.

## 2026-09-11: Diagnostic/support/telemetry batch re-verified and reinstalled

**States:** already committed as `e74508a063` and `a0024a4f77`; re-verified locally; current HEAD `a7e1f4f1b3` reinstalled so the batch is in the running snapshot. Working tree had no remaining source for these files. A forced CLI rebuild hit EPERM on a locked `kilo.exe`; the packaged CLI was restored from the `9f6864dba8` VSIX (228803072 bytes) and matched the current source hash.

Commands: `packages/http-recorder` `bun test ./test/record-replay.test.ts --timeout 30000` → 37 pass / 0 fail / 185 expect / exit 0. Root `bun test --config .tmp/bunfig-script.toml ./script/kilocode/raya-support.test.ts --timeout 30000` → 7 pass / 0 fail / 26 expect / exit 0. `bun run script/check-workflows.ts` → exit 0. `packages/kilo-vscode` `bun test tests/unit/telemetry-proxy-boundary.test.ts tests/unit/telemetry-proxy-utils.test.ts --timeout 30000` → 13 pass / 0 fail / 25 expect / exit 0.

Installed `eden.raya@7.4.23-snapshot+a7e1f4f1b3.kamil-oseni.1789174025050`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-a7e1f4f1b3-kamil-oseni-1789174025050.vsix`; SHA-256 `205E847A841D45224824169C9F6910FB12C4496B9F348E9F79402F9CD2D99205`; 517060407 bytes, 431 entries. CLI binary already present; not rebuilt.

Remaining: leftover RDM-06 light/dark and narrow/wide Chromium, inbox performance budget, returning-reviewer journey, and packaged microphone/acoustic acceptance. Receiving-side telemetry consent ordering remains open.

Next executable step: leftover RDM-06 Chromium themes/narrow layout, inbox performance budget, or leftover Live microphone acceptance.

## 2026-09-11: Browser profile identity and routines Chromium layout

**States:** verified locally and committed as `c03bf67a95`. Pushed with this docs record as `8e2dc53700` and installed in the snapshot below. Browser tool calls no longer throw `Browser profile storage identity changed` when `fs.realpath()` and `path.resolve()` differ only by drive-letter or user-name case. A junction or directory symlink that redirects the profile root still throws. The routines worker name is a real clickable column. Conversation messages are a labeled, keyboard-reachable log. Production `RoutinesView` is exercised in the preview harness.

Changed files: `packages/kilo-vscode/src/services/browser-automation/browser-held.ts`, `browser-profile.ts`, `browser-session.ts`, `browser-auth.ts`, `browser-upload.ts`, `browser-transfer.ts`, `packages/kilo-vscode/tests/unit/browser-held.test.ts`, `packages/kilo-vscode/webview-ui/src/styles/routines.css`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/webview-ui/preview/routines.tsx`, `preview/index.tsx`, `preview/mock-vscode.ts`, `preview/preview.css`, `packages/kilo-vscode/tests/routines-preview.browser.ts`, `packages/kilo-vscode/tests/fixtures/routine-inbox-view.mjs`, `.changeset/raya-browser-profile-identity.md`, `.changeset/raya-routine-inbox-height.md`.

Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/browser-held.test.ts tests/unit/browser-auth.test.ts tests/unit/browser-upload.test.ts tests/unit/browser-transfer.test.ts --timeout 60000` → 8 pass / 2 skip / 0 fail / 34 expect / exit 0. `bun test tests/unit/routines-inbox-view.test.ts tests/unit/routines-delegate-view.test.ts tests/unit/routines-edit-view.test.ts --timeout 90000` → 3 pass / 0 fail / 3 expect / exit 0. Isolated inbox rerun after log labelling → 1 pass / exit 0. `bun run check-types` → exit 0. `bun run check-types:webview` → exit 0. `bunx playwright test --config playwright.preview.config.ts` → 12 pass / 0 fail / exit 0. `bun run check-kilocode-change` → no forbidden markers / exit 0.

Remaining: inbox performance budget, returning-reviewer journey, empty/loading/stale/error and 200% zoom, packaged microphone/acoustic acceptance, and receiving-side telemetry consent ordering. Do not force-rebuild `kilo.exe` while the running extension holds it. Codex-deferred research stays untracked.

Next executable step: leftover RDM-06 performance/reviewer or leftover Live microphone acceptance.

## 2026-09-11: Snapshot install `8e2dc53700`

**States:** committed, pushed and installed as `8e2dc53700`. Windows recased profile paths no longer fail browser tools. Routines light/dark at 320px and 900px are in this snapshot.

Installed `eden.raya@7.4.23-snapshot+8e2dc53700.kamil-oseni.1789176460487`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-8e2dc53700-kamil-oseni-1789176460487.vsix`; SHA-256 `340ED6E3C8D271B70D680DEFDF3C7F8138EBD979B20AE6171B310885DCADC92B`; 517061377 bytes, 431 entries. CLI binary already present; not rebuilt.

Remaining: leftover RDM-06 inbox performance budget, returning-reviewer journey, empty/loading/stale/error and 200% zoom, and packaged microphone/acoustic acceptance.

Next executable step: leftover RDM-06 performance/reviewer or leftover Live microphone acceptance.

## 2026-09-11: Inbox page budget and empty-state Chromium coverage

**States:** verified locally and committed as `96715a85f8`. Not yet pushed or installed. Each conversation page returns at most 50 persisted messages. Limits below 1 or above 50 are refused. Production `RoutinesView` empty, error, stale, and loading copy is exercised in Chromium, and the worker name stays clickable at 200% zoom.

Changed files: `packages/opencode/test/kilocode/task/inbox.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-inbox.test.ts`, `docs/Raya-Routine-Inbox-Workload.md`, `packages/kilo-vscode/webview-ui/preview/mock-vscode.ts`, `packages/kilo-vscode/tests/routines-preview.browser.ts`.

Commands: `packages/opencode` `bun test ./test/kilocode/task/inbox.test.ts ./test/kilocode/server/httpapi-routine-inbox.test.ts --timeout 60000` → 7 pass / 0 fail / 98 expect / exit 0. `packages/kilo-vscode` `bun run check-types:webview` → exit 0. `bunx playwright test --config playwright.preview.config.ts` → 17 pass / 0 fail / exit 0. Root `bun run script/check-md-table-padding.ts` → 471 files, no padded tables / exit 0. `packages/kilo-vscode` `bun run check-kilocode-change` → no forbidden markers / exit 0.

The page cap was already in `packages/opencode/src/kilocode/task/inbox.ts` and the HTTP schema. This slice records that budget and proves it. Empty/loading/stale/error copy was already in `RoutinesView`; Chromium now reaches those scenes through `?scene=`. Horizontal overflow is still checked at 100% zoom, not at 200%.

Remaining: returning-reviewer journey (schema/event flow, then single-worker and delegation journeys), packaged microphone/acoustic acceptance, and receiving-side telemetry consent ordering. Do not force-rebuild `kilo.exe` while the running extension holds it. Codex-deferred research stays untracked.

Next executable step: leftover RDM-06 returning-reviewer journey, or leftover Live microphone acceptance.

## 2026-09-11: Snapshot install `d08dc0197d`

**States:** committed, pushed and installed as `d08dc0197d`. Conversation pages stay at 50 messages. Chromium empty, error, stale, loading, and 200% zoom coverage is in this snapshot.

Installed `eden.raya@7.4.23-snapshot+d08dc0197d.kamil-oseni.1789177768668`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-d08dc0197d-kamil-oseni-1789177768668.vsix`; SHA-256 `5F4C937EBE76549E20D3DE6F68D8703E942AD2F604C427DC4573934B5BCA6623`; 520000749 bytes, 432 entries. Packaging copied a rebuilt CLI into `bin/kilo.exe`; VS Code was not force-reloaded.

Remaining: leftover RDM-06 returning-reviewer journey and packaged microphone/acoustic acceptance.

Next executable step: leftover RDM-06 returning-reviewer journey, or leftover Live microphone acceptance.

## 2026-09-11: Returning-reviewer schema and journeys

**States:** verified locally and committed as `750d616f03`. Not yet pushed or installed. A returning reviewer can inspect the migrated routine tables and kilocode-routine migrations first, then reproduce a Friday assignment through the real scheduler, a follow-up that keeps the report source in run context, default chat-list exclusion of runner-created execution sessions, and a brief coordinating worker whose delegated session cannot edit.

Changed files: `packages/opencode/test/kilocode/task/returning-reviewer.test.ts`.

Commands: `packages/opencode` `bun test ./test/kilocode/task/returning-reviewer.test.ts --timeout 60000` → 1 pass / 0 fail / 34 expect / exit 0.

The conversation identity stays `rcv_*` and is not the execution session. Follow-up does not rewrite the standing Friday schedule. A paused recipient is not started. This does not add a packaged UI walkthrough or a live microphone check.

Remaining: packaged microphone/acoustic acceptance, and receiving-side telemetry consent ordering. Do not force-rebuild `kilo.exe` while the running extension holds it. Codex-deferred research stays untracked.

Next executable step: leftover Live microphone acceptance.

## 2026-09-11: Snapshot install `7a748083dd`

**States:** committed, pushed and installed as `7a748083dd`. Returning-reviewer schema inspection, Friday assignment, follow-up report context, history exclusion, and brief-to-full delegation policy are in this snapshot.

Installed `eden.raya@7.4.23-snapshot+7a748083dd.kamil-oseni.1789179011559`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-7a748083dd-kamil-oseni-1789179011559.vsix`; SHA-256 `5BD7CBCB1EE401E147C7E530F5DA9CBDC638F21FD4236AD639DA8E7BFE9D095A`; 520000749 bytes, 432 entries. Packaging copied a rebuilt CLI into `bin/kilo.exe`; VS Code was not force-reloaded.

Remaining: packaged microphone/acoustic acceptance, and receiving-side telemetry consent ordering.

Next executable step: leftover Live microphone acceptance.

## 2026-09-11: Packaged Live host-microphone fallback

**States:** verified locally and committed as `1a37c6ea81`. Not yet pushed or installed. When the webview `getUserMedia` path is denied, LiveVoice acquires a host PCM MediaStream. Packaged HTML allows `media-src blob: mediastream:` and declares `microphone=(self)`. This does not unlock VS Code's iframe `allow` attribute; the extension-host ffmpeg/pw-record path is the packaged capture route. Chromium proves acoustic constraint requests, denied-mic fallback, and a 24 kHz s16le pump. Host ffmpeg arguments emit 24 kHz mono PCM to `pipe:1`.

Changed files: `packages/kilo-vscode/webview-ui/src/context/live-voice.ts`, `packages/kilo-vscode/webview-ui/src/context/voice.tsx`, `packages/kilo-vscode/webview-ui/src/types/messages/extension-messages.ts`, `packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`, `packages/kilo-vscode/src/speech-to-text/capture.ts`, `packages/kilo-vscode/src/speech/service.ts`, `packages/kilo-vscode/src/services/input-tools.ts`, `packages/kilo-vscode/src/utils.ts`, `packages/kilo-vscode/src/webview-html-utils.ts`, `packages/kilo-vscode/tests/fixtures/live-voice.mjs`, `packages/kilo-vscode/tests/unit/live-voice.test.ts`, `packages/kilo-vscode/tests/unit/live-speech-routing.test.ts`, `packages/kilo-vscode/tests/unit/speech-to-text-capture.test.ts`, `packages/kilo-vscode/tests/unit/webview-html.test.ts`, `.changeset/raya-live-host-microphone.md`.

Commands (packages/kilo-vscode): `bun test tests/unit/webview-html.test.ts tests/unit/speech-to-text-capture.test.ts tests/unit/live-speech-routing.test.ts --timeout 30000` → 31 pass / 0 fail / 80 expect / exit 0. `bun test tests/unit/live-voice.test.ts --timeout 50000` → 1 pass / 0 fail / 2 expect / exit 0. `bun test tests/unit/live-voice-ui.test.ts --timeout 90000` → 1 pass / 0 fail / 2 expect / exit 0. `bun run check-types` → exit 0. `bun run check-types:webview` → exit 0. `bun run check-kilocode-change` → exit 0.

This is not a paid GPT-Live call and not real-device acoustic quality. Browser AEC is requested on the webview path; host PCM does not claim echo cancellation. VS Code stable webviews still omit iframe microphone permission. Unexpected ffmpeg death after start is not yet posted as `speechLiveMicError`. Receiving-side telemetry consent ordering remains open. Codex-deferred research stays untracked.

Remaining: paid GPT-Live/device acoustic acceptance, VS Code iframe microphone consent, provider-switch/disposal, and receiving-side telemetry consent ordering.

Next executable step: leftover receiving-side telemetry consent ordering, or a real-account GPT-Live call on a device.

## 2026-09-11: Snapshot install `78d94211b4`

**States:** committed, pushed and installed as `78d94211b4`. Packaged Live host-microphone fallback is in this snapshot. The first snapshot attempt at `93f00fb141` failed packaged lint because `openaiMessage` exceeded complexity 20; that is fixed in this install.

Installed `eden.raya@7.4.23-snapshot+78d94211b4.kamil-oseni.1789180690558`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-78d94211b4-kamil-oseni-1789180690558.vsix`; SHA-256 `B4AFE3358BA0723F9267580494066C950CAEA9859FFE6FB280B30EA0694D416B`; 517069119 bytes, 431 files. CLI binary already present; not rebuilt. VS Code was not force-reloaded.

Remaining: paid GPT-Live/device acoustic acceptance, VS Code iframe microphone consent, provider-switch/disposal, and receiving-side telemetry consent ordering.

Next executable step: leftover receiving-side telemetry consent ordering, or a real-account GPT-Live call on a device.

## 2026-09-11: Receiving-side telemetry consent generation

**States:** verified locally and committed as `fd1017b373`. Not yet pushed or installed. The CLI admits `setEnabled` only when the generation is newer than the last applied consent. A stale enable after a later opt-out is refused. Captures stamped with an older generation are dropped. The extension stamps a monotonic generation on both routes and still sends a later opt-out while an earlier enable is in flight. Unversioned enable remains valid only before any versioned consent change, so existing HTTP exercise `{ enabled: true }` still works on a fresh process.

Changed files: `packages/kilo-telemetry/src/telemetry.ts`, `packages/kilo-telemetry/src/__tests__/telemetry.test.ts`, `packages/opencode/src/kilocode/server/httpapi/groups/telemetry.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/telemetry.ts`, `packages/kilo-vscode/src/services/telemetry/telemetry-proxy.ts`, `packages/kilo-vscode/tests/unit/telemetry-proxy-boundary.test.ts`, `.changeset/raya-telemetry-consent-generation.md`.

Commands: `packages/kilo-telemetry` `bun test src/__tests__/telemetry.test.ts --timeout 30000` → 20 pass / 0 fail / 50 expect / exit 0. `packages/kilo-vscode` `bun test tests/unit/telemetry-proxy-boundary.test.ts tests/unit/telemetry-proxy-utils.test.ts --timeout 30000` → 14 pass / 0 fail / 26 expect / exit 0. `bun run check-types` → exit 0. `packages/kilo-telemetry` `bun run typecheck` → exit 0. `packages/opencode` `bun run typecheck` → exit 0. `bun test ./test/kilocode/server/httpapi-public.test.ts --timeout 30000` → 13 pass / 0 fail / 133 expect / exit 0. `packages/kilo-vscode` `bun run check-kilocode-change` → exit 0.

Aborting a client request still cannot undo a PostHog mutation that already happened. This closes CLI admission ordering. SDK types were not regenerated; generation is an optional JSON field and the extension uses raw fetch. Remaining: paid GPT-Live/device acoustic acceptance, VS Code iframe microphone consent, and provider-switch/disposal. Codex-deferred research stays untracked.

Next executable step: leftover provider-switch/disposal, or a real-account GPT-Live call on a device.

## 2026-09-11: Snapshot install `dd7966a567`

**States:** committed, pushed and installed as `dd7966a567`. Receiving-side telemetry consent generation is in this snapshot. Snapshot packaging regenerated the JS SDK because the optional `generation` field changed OpenAPI input. The first Kilo Console vite pass failed with `EPERM` on `packages/kilo-console/dist/assets`; the CLI build then reused the existing console dist and copied a rebuilt `kilo.exe`.

Installed `eden.raya@7.4.23-snapshot+dd7966a567.kamil-oseni.1789181590925`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-dd7966a567-kamil-oseni-1789181590925.vsix`; SHA-256 `9EFC43299DF9D4371AF01A6DA0F3874A7497BAC4861EE2DB1FBC1D366D30F776`; 520013600 bytes, 432 files. Packaging copied a rebuilt CLI into `bin/kilo.exe`. VS Code was not force-reloaded.

Remaining: paid GPT-Live/device acoustic acceptance, VS Code iframe microphone consent, and provider-switch/disposal.

Next executable step: leftover provider-switch/disposal, or a real-account GPT-Live call on a device.

## 2026-09-11: Live engine-switch and backend-drop cleanup

**States:** verified locally and committed as `25d89292fa`. Not yet pushed or installed. An engine change takes the SpeechService lock before saving the new engine, so a Live start or host-microphone request cannot sneak in while the previous call is still owned. Release cancels in-flight host PCM capture. Backend disconnect drops the call without closing SpeechService, so a later start is still admitted. VoiceProvider ends the UI call on `connectionState` other than connected, keeps Start voice disabled until cleanup is confirmed, and does not auto-start a replacement engine.

Changed files: `packages/kilo-vscode/src/speech/service.ts`, `packages/kilo-vscode/src/speech/live-broker.ts`, `packages/kilo-vscode/src/speech-to-text/capture.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/webview-ui/src/context/voice.tsx`, `packages/kilo-vscode/tests/unit/speech-engine-switch.test.ts`, `packages/kilo-vscode/tests/fixtures/live-voice-ui.mjs`, `packages/kilo-vscode/tests/unit/live-voice-ui.test.ts`, `.changeset/raya-voice-switch-drop.md`.

Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/speech-engine-switch.test.ts tests/unit/live-speech-routing.test.ts --timeout 30000` → 8 pass / 0 fail / 47 expect / exit 0. `bun test tests/unit/speech-to-text-capture.test.ts --timeout 30000` → 11 pass / 0 fail / 27 expect / exit 0. `bun test tests/unit/openai-provider.test.ts --timeout 30000` → 1 pass / 0 fail / 1 expect / exit 0. `bun test tests/unit/live-voice-ui.test.ts --timeout 130000` → 1 pass / 0 fail / 2 expect / exit 0. `bun run check-types` → exit 0. `bun run check-types:webview` → exit 0. `bun run check-kilocode-change` → no forbidden markers / exit 0. eslint on the touched voice/host files → exit 0.

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Unexpected ffmpeg death after a successful host-mic start is still not posted as `speechLiveMicError`. Codex-deferred research stays untracked.

Remaining: paid GPT-Live/device acoustic acceptance and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 UI/lifecycle, or a real-account GPT-Live call on a device.

## 2026-09-11: Snapshot install `16d2b358ee`

**States:** committed, pushed and installed as `16d2b358ee`. Voice engine-switch and backend-drop cleanup is in this snapshot. Snapshot packaging regenerated the JS SDK, rebuilt `kilo.exe`, and copied it into `bin/kilo.exe`.

Installed `eden.raya@7.4.23-snapshot+16d2b358ee.kamil-oseni.1789183666191`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-16d2b358ee-kamil-oseni-1789183666191.vsix`; SHA-256 `10D4B599F1185B5957969F581FC1E700B7CEE2EC546482FA6C382F27AA76E09F`; 520019445 bytes, 432 files. VS Code was not force-reloaded.

Remaining: paid GPT-Live/device acoustic acceptance and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 UI/lifecycle, or a real-account GPT-Live call on a device.

## 2026-09-11: Live host-microphone unexpected death

**States:** verified locally and committed as `5758eef154`. Not yet pushed or installed. After host PCM capture is ready, an unexpected process exit posts `speechLiveMicError` instead of leaving the call listening to a dead pipe. An intentional stop and a failed start do not use that unexpected-death path. Ready is not posted if death already arrived.

Changed files: `packages/kilo-vscode/src/speech-to-text/capture.ts`, `packages/kilo-vscode/src/speech/service.ts`, `packages/kilo-vscode/tests/unit/speech-to-text-capture.test.ts`, `.changeset/raya-live-mic-death.md`.

Commands (cwd `packages/kilo-vscode`): `bun test tests/unit/speech-to-text-capture.test.ts tests/unit/speech-engine-switch.test.ts tests/unit/live-speech-routing.test.ts --timeout 30000` → 22 pass / 0 fail / 75 expect / exit 0. `bun test tests/unit/speech-to-text-capture.test.ts --timeout 30000` → 14 pass / 0 fail / 28 expect / exit 0. `bun run check-types` → exit 0. `bun run check-types:webview` → exit 0. `bun run check-kilocode-change` → no forbidden markers / exit 0.

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Codex-deferred research stays untracked.

Remaining: paid GPT-Live/device acoustic acceptance and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 UI/lifecycle, or a real-account GPT-Live call on a device.

## 2026-09-11: Snapshot install `76ac4375b2`

**States:** committed, pushed and installed as `76ac4375b2`. Unexpected Live host-microphone death posts `speechLiveMicError`. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+76ac4375b2.kamil-oseni.1789184595609`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-76ac4375b2-kamil-oseni-1789184595609.vsix`; SHA-256 `ADB09A1ECC19FED8989066B469020B0C7060F9D827D3F8FA8861928FA5089EA7`; 517076828 bytes, 431 files. VS Code was not force-reloaded.

Remaining: paid GPT-Live/device acoustic acceptance and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 UI/lifecycle, or a real-account GPT-Live call on a device.

## 2026-09-11: Routine report file cards and keyboard inbox

**States:** verified locally and committed as `3c62cb12df`. Not yet pushed or installed. Path-like run evidence is stored on the inbox message and rendered as openable file cards. Opening a worker conversation focuses the thread so Escape returns to that worker. Keyboard focus uses a visible outline. Settlement after a completed run with no inbox row publishes one report, including file cards, without duplicating on retry.

Changed files: `packages/opencode/src/kilocode/task/inbox.ts`, `packages/core/src/kilocode/routine.sql.ts`, `packages/core/src/database/schema.gen.ts`, `packages/core/src/database/migration.gen.ts`, `packages/core/src/database/migration/20260911234600_kilocode-routine-inbox-files.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/webview-ui/src/components/routines/Archive.tsx`, `packages/kilo-vscode/webview-ui/src/styles/routines.css`, `packages/kilo-vscode/webview-ui/preview/mock-vscode.ts`, `packages/kilo-vscode/tests/fixtures/routine-inbox-view.mjs`, `packages/kilo-vscode/tests/routines-preview.browser.ts`, `packages/opencode/test/kilocode/task/inbox.test.ts`, `packages/opencode/test/kilocode/task/inbox-report.test.ts`, `.changeset/raya-routine-inbox-files.md`.

Commands:

| Command | Result |
|---|---|
| `packages/opencode` `bun test ./test/kilocode/task/inbox.test.ts ./test/kilocode/task/inbox-report.test.ts --timeout 60000` | 6 pass / 0 fail / 71 expect / exit 0 |
| `packages/opencode` `bun test ./test/kilocode/server/httpapi-routine-inbox.test.ts --timeout 60000` | 3 pass / 0 fail / 50 expect / exit 0 |
| `packages/opencode` `bun run typecheck` | exit 0 |
| `packages/core` `bun test ./test/database-migration.test.ts ./test/kilocode/migration-backup.test.ts --timeout 60000` | 21 pass / 0 fail / 85 expect / exit 0 |
| `packages/kilo-vscode` `bun test tests/unit/routines-inbox-view.test.ts --timeout 90000` | 1 pass / 0 fail / 1 expect / exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bunx playwright test --config playwright.preview.config.ts` | 18 pass / 0 fail / exit 0 |
| root `bun run script/check-opencode-annotations.ts --worktree` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. File cards open a workspace path; they are not uploaded blobs. Evidence lines that contain spaces stay in the report body and are not turned into cards. Codex-deferred research stays untracked.

Remaining: leftover RDM-06 duplicate replies, parent cancellation, cross-company UI, recipient unavailability beyond pause, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 lifecycle, or a real-account GPT-Live call on a device.

## 2026-09-11: Snapshot install `e3f9039043`

**States:** committed, pushed and installed as `e3f9039043`. Routine report file cards and keyboard inbox navigation are in this snapshot. Snapshot packaging regenerated the JS SDK (inbox `files` field) and rebuilt `kilo.exe`.

Installed `eden.raya@7.4.23-snapshot+e3f9039043.kamil-oseni.1789186373987`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-e3f9039043-kamil-oseni-1789186373987.vsix`; SHA-256 `56C61C63A4412A4D0469D6ABD7C37679B2ECDBA932CFB56DC5755394B4277CFE`; 520033674 bytes, 432 files. VS Code was not force-reloaded.

Remaining: leftover RDM-06 duplicate replies, parent cancellation, cross-company UI, recipient unavailability beyond pause, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 lifecycle, or a real-account GPT-Live call on a device.

## 2026-09-12: Archived and other-folder delegation denials

**States:** verified locally and committed as `1ddcd26e7e`, documented as `ad066b704d`, and installed in the snapshot below. Asking an archived worker or a worker in another folder persists a failed request with a conversation card and does not start work. The Ask buttons disable those workers and keep the draft. A second identical completed reply does not add another inbox card. Stopping a parent leaves a completed child result and session intact.

Changed files: `packages/opencode/src/kilocode/task/delegation.ts`, `packages/opencode/src/kilocode/task/runner.ts`, `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`, `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/Inbox.tsx`, `packages/kilo-vscode/tests/fixtures/routine-delegate-view.mjs`, `packages/kilo-vscode/tests/unit/routines-inbox.test.ts`, `packages/opencode/test/kilocode/task/delegation.test.ts`, `packages/opencode/test/kilocode/task/delegation-runner.test.ts`, `packages/opencode/test/kilocode/server/httpapi-routine-delegate.test.ts`, `.changeset/raya-routine-delegate-lifecycle.md`.

Commands:

| Command | Result |
|---|---|
| `packages/opencode` `bun test ./test/kilocode/task/delegation.test.ts ./test/kilocode/task/delegation-runner.test.ts ./test/kilocode/server/httpapi-routine-delegate.test.ts --timeout 60000` | 15 pass / 0 fail / 163 expect / exit 0 |
| `packages/kilo-vscode` `bun test tests/unit/routines-inbox.test.ts tests/unit/routines-delegate-view.test.ts --timeout 90000` | 7 pass / 0 fail / 22 expect / exit 0 |
| `packages/opencode` `bun run typecheck` | exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| root `bun run script/check-opencode-annotations.ts --worktree` | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Workers without a folder still match a sender that has one. A never-created recipient ID stays 404. Codex-deferred research stays untracked.

Remaining: leftover RDM-06 worker rename/reassignment attribution, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 rename/reassignment attribution, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `ad066b704d`

**States:** committed, pushed and installed as `ad066b704d`. Archived and other-folder denials, one reply card after duplicate completion, and completed-child preservation on parent stop are in this snapshot. Snapshot packaging regenerated the JS SDK and rebuilt `kilo.exe`.

Installed `eden.raya@7.4.23-snapshot+ad066b704d.kamil-oseni.1789188556585`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-ad066b704d-kamil-oseni-1789188556585.vsix`; SHA-256 `E3F99A17A4BE644DF24B207DDBB1E0DBF7F470BD2FB8BF0F739E7F3C34B8623C`; 520039289 bytes, 432 files. VS Code was not force-reloaded.

Remaining: leftover RDM-06 worker rename/reassignment attribution, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover RDM-06 rename/reassignment attribution, or a real-account GPT-Live call on a device.

## 2026-09-12: Worker rename and standing-job reassignment

**States:** verified locally and committed as `a3ca6bc1d6`, with the complexity split in `18edac8c72`. Not yet pushed or installed. Edit schedule now shows Name and Standing job. Saving those fields updates the same worker and does not start a new one. Historical reports stay on that `agentID`. A schedule change still requires preview confirmation. Assignment save is split out of the form so lint complexity stays at or below 20.

Changed files: `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/tests/fixtures/routine-edit-view.mjs`, `packages/opencode/test/kilocode/task.test.ts`, `.changeset/raya-routine-reassignment.md`.

Commands:

| Command | Result |
|---|---|
| `packages/opencode` `bun test ./test/kilocode/task.test.ts --timeout 90000` | 62 pass / 0 fail / 584 expect / exit 0 |
| `packages/kilo-vscode` `bun test tests/unit/routines-edit-view.test.ts --timeout 90000` | 1 pass / 0 fail / 1 expect / exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache webview-ui/src/components/routines/RoutinesView.tsx` | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Role, access, folder, and output stay create-only; changing those still requires a new worker. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `f81902f403`

**States:** committed, pushed and installed as `f81902f403`. Worker rename and standing-job reassignment are in this snapshot. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+f81902f403.kamil-oseni.1789190327003`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-f81902f403-kamil-oseni-1789190327003.vsix`; SHA-256 `8C7AC21887744F5F061FF24EB9D7E28B459C9E0D3C8955C628AC2D8072D30DA2`; 517098005 bytes, 431 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Production composer, history, and review in the visual harness

**States:** verified locally and committed as `b9bef42d2f`, documented as `95a05764c9`, and installed in the snapshot below. The 5199 visual harness now mounts production `PromptInput`, `HistoryView`, `SessionReviewCluster`, and `EditReviewChrome` instead of illustrative replicas. Those fixtures are labeled `production-view`. Slash, topnav, transcript, and conversation stay labeled illustrative. The preview server compiles before listen, caches Babel transforms, and stubs `?worker&url` imports so Playwright does not wait on esbuild 503s. History's header wraps at 320px. The hidden composer file input now has an attach label.

Changed files: `packages/kilo-vscode/webview-ui/src/components/chat/SessionReviewCluster.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/EditReviewChrome.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/ChatView.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/VscodeToolOverrides.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx`, `packages/kilo-vscode/webview-ui/src/styles/history.css`, `packages/kilo-vscode/webview-ui/preview/surfaces.tsx`, `packages/kilo-vscode/webview-ui/preview/index.tsx`, `packages/kilo-vscode/webview-ui/preview/serve.cjs`, `packages/kilo-vscode/webview-ui/preview/mock-vscode.ts`, `packages/kilo-vscode/webview-ui/preview/preview.css`, `packages/kilo-vscode/tests/surfaces-preview.browser.ts`, `packages/kilo-vscode/playwright.preview.config.ts`, `.changeset/raya-preview-production-surfaces.md`.

Commands:

| Command | Result |
|---|---|
| `packages/kilo-vscode` `bunx playwright test --config playwright.preview.config.ts` | 27 pass / 0 fail / exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched chat/preview TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Composer on 5201 remains the deeper interaction fixture. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `95a05764c9`

**States:** committed, pushed and installed as `95a05764c9`. Production composer, history, and review fixtures are in this snapshot. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+95a05764c9.kamil-oseni.1789193061196`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-95a05764c9-kamil-oseni-1789193061196.vsix`; SHA-256 `3F26924F2CDA28DD3015B311CA6198F8753E5CDB7ED8926CD9AAC756176C9F4D`; 517100084 bytes, 431 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Production slash, topnav, transcript, and conversation in the visual harness

**States:** verified locally and committed as `890a06791d`, documented as `8c04e1526e`, and installed in the snapshot below. The 5199 harness now mounts production `VscodeUserMessage`, `TaskHeader`, and `TranscriptRowView` for slash, topnav, transcript, and conversation. All named fixtures are labeled `production-view`. The task header wraps at 320px.

Changed files: `packages/kilo-vscode/webview-ui/preview/chrome.tsx`, `packages/kilo-vscode/webview-ui/preview/index.tsx`, `packages/kilo-vscode/webview-ui/preview/surfaces.tsx`, `packages/kilo-vscode/webview-ui/preview/preview.css`, `packages/kilo-vscode/webview-ui/src/styles/task-header.css`, `packages/kilo-vscode/tests/surfaces-preview.browser.ts`, `.changeset/raya-preview-chrome-surfaces.md`.

Commands:

| Command | Result |
|---|---|
| `packages/kilo-vscode` `bunx playwright test --config playwright.preview.config.ts` | 32 pass / 0 fail / exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched preview TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Combined result/editor views and live packaged visual acceptance remain open. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `8c04e1526e`

**States:** committed, pushed and installed as `8c04e1526e`. Production slash, topnav, transcript, and conversation fixtures are in this snapshot. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+8c04e1526e.kamil-oseni.1789194184945`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-8c04e1526e-kamil-oseni-1789194184945.vsix`; SHA-256 `22B95CA4EAF760A1764DEB0C412AC3CB36DFDAFD5EAC3311B5F4DE144AE19B72`; 517101368 bytes, 431 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Production goal result package and criteria editor in the visual harness

**States:** verified locally and committed as `65dbc2e9a9`, documented as `b52758bee3`, and installed in the snapshot below. The 5199 harness now mounts production `GoalBannerView` for a completed result package (outcome, command-bound checks, cited results, optional unverified caveats, recorded human review) and for the criteria editor. The banner header and audit rows wrap at 320px.

Changed files: `packages/kilo-vscode/webview-ui/preview/index.tsx`, `packages/kilo-vscode/webview-ui/preview/preview.css`, `packages/kilo-vscode/webview-ui/src/styles/banners.css`, `packages/kilo-vscode/tests/surfaces-preview.browser.ts`, `.changeset/raya-preview-goal-result.md`.

Commands:

| Command | Result |
|---|---|
| `packages/kilo-vscode` `bunx playwright test --config playwright.preview.config.ts` | 37 pass / 0 fail / exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched preview TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Cited sources are summaries only in the harness; opening exact tool results still needs a session. Live packaged visual acceptance remains open. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `b52758bee3`

**States:** committed, pushed and installed as `b52758bee3`. Production goal result and criteria-editor fixtures are in this snapshot. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+b52758bee3.kamil-oseni.1789195725262`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-b52758bee3-kamil-oseni-1789195725262.vsix`; SHA-256 `999843A6BA51DCCB395C4350C1B4DFC4DFF9A54DD66F07517E1A660FCAB31292`; 517102464 bytes, 431 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Role and write-folder reassignment on the same worker

**States:** verified locally and committed as `9dad281a88`. Edit schedule now shows Role and Write folder. Save assignment updates those fields on the same `agentID`. Accountant and inbox role changes still require the matching records consent. Access and output stay on their dedicated review editors. Earlier reports stay in the same conversation.

Changed files: `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/kilo-vscode/tests/fixtures/routine-edit-view.mjs`, `packages/kilo-vscode/tests/unit/routines-update.test.ts`, `packages/opencode/test/kilocode/task.test.ts`, `.changeset/raya-routine-role-folder.md`.

Commands:

| Command | Result |
|---|---|
| `packages/opencode` `bun test ./test/kilocode/task.test.ts --timeout 90000` | 62 pass / 0 fail / 589 expect / exit 0 |
| `packages/kilo-vscode` `bun test tests/unit/routines-edit-view.test.ts tests/unit/routines-update.test.ts --timeout 90000` | 2 pass / 0 fail / 4 expect / exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched routine TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Tool access, agent mode, plan file, and output requirements still use their existing create or dedicated-review paths. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `4cabf8d725`

**States:** committed, pushed and installed as `4cabf8d725`. Role and write-folder reassignment on the same worker is in this snapshot. CLI binary was rebuilt because CLI source had changed.

Installed `eden.raya@7.4.23-snapshot+4cabf8d725.kamil-oseni.1789196858491`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-4cabf8d725-kamil-oseni-1789196858491.vsix`; SHA-256 `16BF39B73CA25B854DCB51C37FE8FD922983AA34A951C199FED6D33E57AB5296`; 520060065 bytes, 432 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Agent and plan-file reassignment on the same worker

**States:** verified locally and committed as `726a93c54c`. Edit schedule now shows Agent and Plan file. Save assignment updates those fields on the same `agentID`. Choosing the default chat mode or an empty plan file clears the saved values. Tool access stays on the dedicated access review. Earlier reports stay in the same conversation.

Changed files: `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/src/kilo-provider/routines.ts`, `packages/opencode/src/kilocode/task/index.ts`, `packages/kilo-vscode/tests/fixtures/routine-edit-view.mjs`, `packages/kilo-vscode/tests/unit/routines-update.test.ts`, `packages/opencode/test/kilocode/task.test.ts`, `.changeset/raya-routine-mode-plan.md`.

Commands:

| Command | Result |
|---|---|
| `packages/opencode` `bun test ./test/kilocode/task.test.ts --timeout 90000` | 62 pass / 0 fail / 595 expect / exit 0 |
| `packages/kilo-vscode` `bun test tests/unit/routines-edit-view.test.ts tests/unit/routines-update.test.ts --timeout 90000` | 4 pass / 0 fail / 8 expect / exit 0 |
| `packages/opencode` `bun run typecheck` | exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched routine TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Tool access and output requirements still use their dedicated review editors. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `af936192ff`

**States:** committed, pushed and installed as `af936192ff`. Agent and plan-file reassignment on the same worker is in this snapshot. CLI binary was rebuilt because CLI source had changed.

Installed `eden.raya@7.4.23-snapshot+af936192ff.kamil-oseni.1789198044029`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-af936192ff-kamil-oseni-1789198044029.vsix`; SHA-256 `512F1A1FBE4393FF5A51E1DA11944157695850DFDE6C966A090BE14F7B7B5A71`; 520062140 bytes, 432 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Write-folder file-tool confinement

**States:** verified locally and committed as `8b020e9a59`. A full-access routine with a write folder now denies parent-folder `edit`/`write`/`apply_patch` patterns. Reads and `external_directory` remain allowed. Brief access is unchanged. Access review names the writable location. Shell, plugins, and service grants are not confined.

Changed files: `packages/opencode/src/kilocode/task/index.ts`, `packages/opencode/test/kilocode/task.test.ts`, `packages/kilo-vscode/webview-ui/src/components/routines/AccessReview.tsx`, `packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx`, `packages/kilo-vscode/tests/fixtures/routine-edit-view.mjs`, `docs/Raya-Routine-Capabilities.md`, `.changeset/raya-routine-write-folder.md`.

Commands:

| Command | Result |
|---|---|
| `packages/opencode` `bun test ./test/kilocode/task.test.ts --timeout 90000` | 62 pass / 0 fail / 602 expect / exit 0 |
| `packages/kilo-vscode` `bun test tests/unit/routines-edit-view.test.ts tests/unit/routines-access.test.ts --timeout 90000` | 2 pass / 0 fail / 10 expect / exit 0 |
| `packages/opencode` `bun run typecheck` | exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched routine TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Per-service grants, trusted-plugin confinement, and Windows OS confinement remain open under PR-04. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: Snapshot install `b54b24cf5c`

**States:** committed, pushed and installed as `b54b24cf5c`. Write-folder file-tool confinement is in this snapshot. CLI binary was rebuilt because CLI source had changed.

Installed `eden.raya@7.4.23-snapshot+b54b24cf5c.kamil-oseni.1789199445687`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-b54b24cf5c-kamil-oseni-1789199445687.vsix`; SHA-256 `8DA2FA36B2C812033D912AB89AAAD41127344CAC814D48933B9E0F4AB2750D5A`; 520064054 bytes, 432 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: grok Historical Undo hydration after the file leaves the diff

**States:** verified locally and committed as `87a7680782`. Successful Undo now stores submitted file fingerprints in workspace state. After the file leaves the live diff, a later review refresh includes those hashes so a fresh webview keeps the transcript card dismissed. If the same path returns in the live diff, the stored dismissal is dropped and that file reopens. Session deletion prunes the stored dismissals with the retry journal.

Changed files: `packages/kilo-vscode/src/edit-review/undone.ts`, `packages/kilo-vscode/src/edit-review/undone.test.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/webview-ui/src/components/chat/edit-review.ts`, `packages/kilo-vscode/tests/unit/edit-review-state.test.ts`, `packages/kilo-vscode/tests/unit/review-acknowledgement.test.ts`, `docs/Raya-Review-Contract.md`, `.changeset/raya-review-undo-hydration.md`.

Commands:

| Command | Result |
|---|---|
| `packages/kilo-vscode` `bun test tests/unit/edit-review-state.test.ts src/edit-review/undone.test.ts tests/unit/review-acknowledgement.test.ts --timeout 30000` | 22 pass / 0 fail / 84 expect / exit 0 |
| `packages/kilo-vscode` `bun test src/edit-review/InEditorReview.test.ts --timeout 30000` | 14 pass / 0 fail / 64 expect / exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Renamed/deleted-file live interaction remains open under EN-05. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: grok Snapshot install `728fc46c90`

**States:** committed, pushed and installed as `728fc46c90`. Historical Undo hydration is in this snapshot. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+728fc46c90.kamil-oseni.1789223800363`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-728fc46c90-kamil-oseni-1789223800363.vsix`; SHA-256 `894C1D0EA86D0CC7F116D533A52DE0DA795D0B24C1E89C7A4E7DFD8C115EEA88`; 517123831 bytes, 431 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: grok Deleted and renamed files stay reviewable in chat

**States:** committed, pushed and installed as `712a1aa657`. Product commit is `3df03553e3`. Chat Keep/Undo now wraps `apply_patch` and `multiedit` as well as `edit` and `write`. Deleted and renamed files keep their own review chrome when no editor tab is open. In-editor summaries name Deleted file and Renamed file. The visual harness shows both labels.

Changed files: `packages/kilo-vscode/webview-ui/src/components/chat/review-files.ts`, `packages/kilo-vscode/webview-ui/src/components/chat/VscodeToolOverrides.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/EditReviewChrome.tsx`, `packages/kilo-vscode/src/edit-review/InEditorReview.ts`, `packages/kilo-vscode/src/edit-review/InEditorReview.test.ts`, `packages/kilo-vscode/tests/unit/review-files.test.ts`, `packages/kilo-vscode/webview-ui/preview/surfaces.tsx`, `packages/kilo-vscode/tests/surfaces-preview.browser.ts`, `packages/kilo-vscode/webview-ui/src/styles/eden.css`, `packages/kilo-vscode/webview-ui/src/styles/session-actions.css`, `docs/Raya-Review-Contract.md`, `.changeset/raya-review-delete-rename.md`.

Commands:

| Command | Result |
|---|---|
| `packages/kilo-vscode` `bun test tests/unit/review-files.test.ts tests/unit/edit-review-state.test.ts src/edit-review/InEditorReview.test.ts --timeout 30000` | 23 pass / 0 fail / 94 expect / exit 0 |
| `packages/kilo-vscode` `bunx playwright test --config playwright.preview.config.ts tests/surfaces-preview.browser.ts` | 18 pass; 1 cold-start axe timeout on light composer at 320px; isolated retry 1 pass / exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Packaged in-editor interaction with a live renamed or deleted buffer remains open. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: grok Snapshot install `712a1aa657`

**States:** committed, pushed and installed as `712a1aa657`. Deleted and renamed review chrome is in this snapshot. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+712a1aa657.kamil-oseni.1789225171178`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-712a1aa657-kamil-oseni-1789225171178.vsix`; SHA-256 `2FB451014DCA1F185E05FD79E5ADEDE82BFEFE925E7E1ACABE67A82D457FA260`; 517130684 bytes, 431 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: grok Virtual editor buffers for deleted review files

**States:** committed, pushed and installed as `3bac23d766`. Product commit is `8119256e53`. Opening a reviewed path that is gone on disk loads a `raya-review` buffer with the deleted text and the same Keep/Undo CodeLens. Chat path rows for deleted and renamed files open that buffer. The visual harness exposes those open controls.

Changed files: `packages/kilo-vscode/src/edit-review/ghost.ts`, `packages/kilo-vscode/src/edit-review/ghost.test.ts`, `packages/kilo-vscode/src/edit-review/InEditorReview.ts`, `packages/kilo-vscode/src/edit-review/InEditorReview.test.ts`, `packages/kilo-vscode/src/kilo-provider/editor-actions.ts`, `packages/kilo-vscode/src/KiloProvider.ts`, `packages/kilo-vscode/tests/setup/vscode-mock.ts`, `packages/kilo-vscode/tests/unit/editor-actions.test.ts`, `packages/kilo-vscode/tests/surfaces-preview.browser.ts`, `packages/kilo-vscode/webview-ui/preview/surfaces.tsx`, `packages/kilo-vscode/webview-ui/src/components/chat/VscodeToolOverrides.tsx`, `packages/kilo-vscode/webview-ui/src/styles/session-actions.css`, `docs/Raya-Review-Contract.md`, `.changeset/raya-review-ghost-buffer.md`.

Commands:

| Command | Result |
|---|---|
| `packages/kilo-vscode` `bun test src/edit-review/ghost.test.ts src/edit-review/InEditorReview.test.ts tests/unit/edit-review-state.test.ts tests/unit/review-files.test.ts tests/unit/editor-actions.test.ts --timeout 30000` | 28 pass / 0 fail / 111 expect / exit 0 |
| `packages/kilo-vscode` `bunx playwright test --config playwright.preview.config.ts tests/surfaces-preview.browser.ts` | 19 pass / 0 fail / exit 0 |
| `packages/kilo-vscode` `bun run check-types` | exit 0 |
| `packages/kilo-vscode` `bun run check-types:webview` | exit 0 |
| `packages/kilo-vscode` `bun run check-kilocode-change` | no forbidden markers / exit 0 |
| `packages/kilo-vscode` `bunx eslint --no-cache` on touched TypeScript | exit 0 |

This is not a paid GPT-Live call and does not unlock VS Code iframe microphone consent. Packaged live VS Code interaction with a real deleted buffer remains open. Codex-deferred research stays untracked.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.

## 2026-09-12: grok Snapshot install `3bac23d766`

**States:** committed, pushed and installed as `3bac23d766`. Deleted-file virtual review buffers are in this snapshot. CLI binary was already present and was not rebuilt.

Installed `eden.raya@7.4.23-snapshot+3bac23d766.kamil-oseni.1789226754719`. VSIX `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-3bac23d766-kamil-oseni-1789226754719.vsix`; SHA-256 `E2CBB6F524CF9D8306C61F2E8C2C2D4B8B0B419B8D0948AB9877D048819E8A53`; 517134830 bytes, 431 files. VS Code was not force-reloaded.

Remaining: leftover implementable 39-requirement work, paid GPT-Live/device acoustic acceptance, and VS Code iframe microphone consent.

Next executable step: leftover implementable 39-requirement work, or a real-account GPT-Live call on a device.



