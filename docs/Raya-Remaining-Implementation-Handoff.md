# Raya remaining implementation and agent handoff

Updated 2026-09-10. This is a continuation guide, not a completion certificate.

## Scope and reading order

Implement all **39 requirements**: PR-01–06, EN-01–15, UX-01–05, UI-01–03, and OVR-01–10. Read [the comprehensive audit](Raya-Comprehensive-Audit.md), especially sections 6, 11 and 12, for the full specification. Read [implementation progress](Raya-Implementation-Progress.md) for chronological evidence, and [voice architecture mapping](Raya-Voice-Architecture-Implementation.md) plus [voice architecture](Raya-Voice-Architecture.md) for the intended experience. The user's latest direction selects GPT-Live 1 instead of rebuilding provider-owned voice machinery.

Status excerpts below are historical records, not a fresh certification of every feature. Git, current code and actual terminal results are authoritative. Older failures in the progress log may have been superseded; use the latest matching checkpoint. Do not call a requirement complete because a narrower test passes.

## Checkpoint and standing authorization

- Workspace: `C:\Users\User\Desktop\raya`; PowerShell; branch `main`; origin `https://github.com/Kamil-Oseni/kilocode.git`.
- Last verified pushed product checkpoint: `932b20497e4c88b9965861ef713265bbe028256d`, native voice task retention.
- Installed: `eden.raya@7.4.23-snapshot+932b20497e.kamil-oseni.1789017037691`.
- VSIX: `C:\Users\User\AppData\Local\Temp\raya-vscode-snapshots\raya-vscode-snapshot-932b20497e-kamil-oseni-1789017037691.vsix`; SHA-256 `74E6A11F16F7388C286590F83F0D350C262051DBE996652C8FAE8D2F8A8CF66F`.
- The user authorizes two parallel workers plus root, batched checks, periodic normal commits/pushes to `origin/main`, and `snapshot:install` outside the sandbox. Do not ask again. No force push, hook bypass or forced VS Code reload.
- At approximately $10 remaining, as reported by the user, stop opening broad work, settle current processes, update this handoff and give the continuation prompt below. Do not invent a credit balance.

## Immediate uncommitted work

### Recorder binary secret refusal — EN-13

Files: `packages/http-recorder/src/redaction.ts`, `packages/http-recorder/test/record-replay.test.ts`, `docs/Raya-Diagnostic-Data-Boundaries.md`, `.changeset/raya-recorder-binary-secrets.md`.

Implemented strict canonical base64 inspection for declared HTTP response bodies and binary WebSocket frames, with an aggregate 8 MiB decoded budget per inspected interaction. Known-token/environment-secret detection checks decoded UTF-8 without rewriting safe replay bytes. Actual filesystem-writer and loopback capture cases cover refusal and byte preservation. Arbitrary private prose, compressed/encrypted content and undeclared encodings remain outside this detector.

Agent-recorded final checks: 37 tests/185 assertions, native exit 0 (`.tmp/recorder-binary-tests-final.log`); package types exit 0 (`.tmp/recorder-binary-types-final.log`); scoped lint no errors/two existing warnings (`.tmp/recorder-binary-lint-final.log`). Review and include the four files; no commit/install yet.

### Support/release contract — PR-06

Files: `docs/Raya-Support-Contract.json`, `docs/Raya-Supported-Clients.md`, `script/kilocode/raya-support.ts`, `script/kilocode/raya-support.test.ts`, `.github/workflows/raya-release.yml`, `.github/workflows/check-opencode-annotations.yml`, `.changeset/raya-support-contract.md`.

Implemented a shared identity/editor-range/target/runner/asset contract, generated matrix block, drift guard and source-pinned release-note preamble. Configured macOS/Linux targets are not installation evidence. Review exact source checkout, workflow permissions, notes generation and guard integration before commit. Do not publish a release to test the notes.

Agent-recorded checks: 7 tests/26 assertions; strict scoped tsgo, workflow allowlist, annotations and Markdown passed; real notes output is `.tmp/raya-support-release-notes.md`. Final `.tmp/raya-support-lint.log` reports zero warnings/errors, and the worker recovered terminal exit 0 for handle 85331. Independent review found no blocking integration defects.

### Telemetry connection lifecycle — EN-13; verification unfinished

Files: `packages/kilo-vscode/src/services/telemetry/telemetry-proxy.ts`, `packages/kilo-vscode/src/extension.ts`, `packages/kilo-vscode/tests/unit/telemetry-proxy-boundary.test.ts`, `.changeset/raya-telemetry-connection-lifecycle.md`.

Implemented endpoint/password invalidation on disconnect/shutdown, cancellation of obsolete requests, scope and consent rechecks after property enrichment/JSON serialization, redirect refusal, 10-second deadlines and generic failure logs. Capture admission caps pending requests at 32; consent requests are not covered by that cap. Receiving-side consent ordering is NOT fixed: an old enable request can still apply after a later opt-out. Aborting the client request cannot prove a server mutation was undone.

**Resolved fixture failure (historical):** run 77926 printed the first passing boundary test and then spun at high CPU. Root explicitly interrupted that owned process; terminal exit 1. `.tmp/telemetry-lifecycle-tests.log` is not a passing suite. There is no live 77926 handle. Suspected Windows Bun fixture interaction: aborting a response and stopping the in-process server before client settlement. Do not weaken production cancellation or repeatedly restart the same fixture.

Implementation/checks 1?4 below are now complete: 13 tests/25 assertions pass, extension types/lint/knip/marker checks pass, diagnostic documentation updated. Continue with checkpoint delivery in step 5.

1. Return the existing send Promise from instance/static capture and setEnabled, while ordinary callers may continue ignoring it. Await transport settlement before fixture teardown.
2. Retain a real pending-request abort regression. If Bun's in-process server still spins, use a native Node HTTP child peer; do not replace the production request path with a fake.
3. Test provider and `toJSON` reentrancy, opt-out before dispatch, disconnected/replaced endpoints, redirects, non-2xx replies, secret-free logs and shutdown. Preserve explicit test deadlines and always close the known process handle.
4. Run extension types, lint and knip; update diagnostic documentation. Keep backend consent ordering as a separately documented next implementation.
5. Review all current diffs and exact staged paths, commit/push with normal hooks, then build/install a verified snapshot. Only checkpoint 932b204 is currently verified installed.

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

**Recorded status:** In progress. Existing editable criteria, retained evidence and human review are now presented as separate guarantees. Optional exact-command bindings require the saved command, explicit normalized directory and successful eligible evidence. Backend contract tests and package types pass; combined result/editor views and broader semantic acceptance remain open.

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

**Recorded status:** In progress. Content and persisted patch-generation fingerprints, stale-command rejection, acceptance hydration, and deletion/rename anchors verified in targeted tests. Historical Undo hydration and renamed/deleted-file live interaction remain open.

**Implementation and verification:**

1. Finish historical Undo hydration and renamed/deleted-file interactions from persisted content/patch fingerprints.
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

**Recorded status:** In progress. Workspace-owned profiles, explicit capture/restore/delete, seven-day expiry, persisted authentication provenance and reset/recovery controls implemented. Native Chromium checks cover storage replacement, restart, expiry, active capture deletion and competing owners; final host/package validation and broader acceptance remain open.

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

**Recorded status:** In progress. Preview labels distinguish production from illustrative fixtures. Current/legacy memory frames now use real component/decoder/styles; eight Chromium theme/width checks and screenshot inspection pass. Composer/history/review migration remains open.

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

**Recorded status:** In progress. Browser skills, stable tab/frame targeting, dialogs, durable downloads and authorized uploads are installed and checkpoint-tested. Upload checks cover staged-byte ownership, destination targeting, lost acknowledgements and restart; file selection does not establish server acceptance. Full model-driven workflow evaluation remains open.

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

**Recorded status:** In progress. Tab/frame identity, manual control, dialogs, durable downloads and authorized uploads are installed and checkpoint-tested. Real Chromium upload coverage includes 40 MiB files, delayed submission, server rejection, frames and multiple/empty files. Selection remains distinct from submission acceptance; full runtime/product workflow acceptance remains open.

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
5. **Broader source inspection, still pending.** Pin and inspect actual Codex core execution, app-server protocol generation, sandbox/approval boundaries, tool dispatch, compaction/resume, rollout persistence, skills discovery and eval/test infrastructure. For each candidate record exact source commit/path, Raya counterpart, measured gap, proposed change, license obligations and an acceptance test. Do not infer private Codex desktop or hosted architecture from public CLI sources. Prioritize durable lifecycle and permission correctness over importing a second agent framework.

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

First inspect current git/process state against the handoff. Finish the pending telemetry transport fixture and recorder/support-contract batch, then deliver a verified checkpoint. Prioritize the requested GPT-Live 1 migration using current official OpenAI docs and the actual client-delegation contract; it is not a Realtime model-name replacement. Keep Raya task ownership, permissions, durable receipts and execution authority. Do not replay historical text as new work or claim generated captions prove heard audio.

Continue the source-backed Codex architecture adaptation review recorded in the handoff. Pin source commits and map candidate patterns to existing Raya code before porting; preserve licensing and avoid importing a competing runtime. Keep the 39-requirement ledger honest. When I warn that credits are near $10, promptly update the full remaining-work handoff, settle the current work and provide an updated continuation prompt.
```

## Latest continuation update

Telemetry transport settlement is now returned to callers. The loopback fixtures await settlement before shutting down their peers; all 13 boundary/utility tests pass with 25 assertions and terminal exit 0 (`.tmp/telemetry-lifecycle-tests-final.log`). The earlier native teardown spin is resolved by this fixture lifecycle change. Extension host/webview typecheck and lint both passed with terminal exit 0; independent recorder/support integration review found no blocking defects. Support worker recovered its prior lint terminal exit 0. No new commit, push or installation yet. Receiving-side consent ordering remains open.

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
