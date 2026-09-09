# Raya comprehensive product, engineering, UX, and UI audit

**Review date:** 7 September 2026

**Baseline:** `f2765700ec8fbb48e6307060a6b4683e56aaa184`

**Status:** Review and improvement proposal. No product changes implemented.

**Audience:** Company stakeholders, designers, and engineers. Raya is treated as an internal tool for people with mixed technical abilities.

**Expansion:** The ten requested overhaul areas are specified individually in section 11, with an integrated implementation sequence in section 12. These additions expand the earlier corrective roadmap into a full product overhaul. They remain proposals for review and a later implementation session. OpenAI API recommendations were checked against official documentation on the review date; recheck model access and contracts at implementation time.

## Contents

1. [Executive assessment](#1-executive-assessment)
2. [What has actually been built](#2-what-has-actually-been-built)
3. [Product and workflow findings](#3-product-and-workflow-findings)
4. [Engineering findings](#4-engineering-findings)
5. [UX and UI findings](#5-ux-and-ui-findings)
6. [Feature improvement specifications](#6-feature-improvement-specifications)
7. [Prioritized delivery plan](#7-prioritized-delivery-plan)
8. [Repository coverage](#8-repository-coverage)
9. [Validation and limitations](#9-validation-and-limitations)
10. [Decisions and review worksheet](#10-decisions-and-review-worksheet)
11. [Ten requested overhauls](#11-ten-requested-overhauls)
12. [Integrated overhaul delivery and handoff](#12-integrated-overhaul-delivery-and-handoff)

## 1. Executive assessment

Raya has a substantial foundation. This is an operating coding-agent platform with orchestration, persisted sessions, provider integrations, multiple clients, browser automation, code review, and emerging general-work capabilities. It is considerably more than a chat interface. The biggest opportunity is to make those capabilities form a dependable, understandable work experience.

The strongest work is in the underlying runtime and accumulated infrastructure: typed contracts, an increasingly explicit package architecture, session coordination, provider-specific handling, worktree support, permission controls, component libraries, and extensive tests. Raya-specific goals also have real completion-evidence checks. Browser smoke checks and canvas render acknowledgements show useful attention to verifying outcomes rather than merely reporting that a command was dispatched.

The weakest seams are where a small interface promises more than its underlying state model guarantees. Examples include natural-language routine schedules being interpreted incorrectly, per-region review controls acting on an entire file, failed review operations still dismissing their controls, and a canvas update replacing persisted source before successful compilation. These undermine trust more directly than adding another model, panel, or agent would improve it.

For company adoption, the product needs three things above all:

- **Predictable actions:** users understand the scope, authority, cost, and consequence of starting or accepting work.
- **Recoverable work:** failures, interruptions, restarts, and rejected changes leave an understandable state and a clear next action.
- **A coherent experience:** the primary path expresses the user's task; model names, routing scores, tool counters, and configuration appear when useful.

The expanded direction is a comprehensive overhaul of the user experience and the named execution systems, not merely cosmetic changes or fixes to isolated defects. That does not require rewriting every inherited package. Preserve proven runtime foundations and upstream-compatible boundaries while replacing inadequate workflows, contracts and presentation. Inherited packages remain Raya's responsibility because they execute its work and determine its reliability.

### What to preserve

- Core session coordination explicitly manages concurrent work and interruption. Build routine scheduling on similarly strong ownership semantics.
- Usage aggregation reads `step-finish` records rather than blindly summing propagated parent totals. Preserve that accounting basis while fixing missing-price semantics.
- Goal completion requires evidence references to completed tools and checks successful command/browser outcomes. Strengthen the evidence model without removing the gate.
- The real History interface has tab roles, selected state, panel associations, and keyboard navigation. Its simpler preview fixture should catch up to it.
- Memory includes redaction, bounded context, and project-root handling; indexing has progress, cancellation, and worktree concerns. These deserve clearer presentation, not replacement with a new parallel system.
- The sandbox reports unsupported platforms and fails when confinement is requested but unavailable. Do not describe it as silently providing Windows isolation.
- The JetBrains downloader already demonstrates stronger artifact handling, including digest verification and staging. Reuse its design lessons in Raya distribution.

### Priority and evidence conventions

| Label | Meaning |
|---|---|
| P0 | Release or rollout gate when the stated exposure condition applies. |
| P1 | Correct before expanding unattended use or broad company adoption. |
| P2 | High-value quality improvement after immediate correctness work. |
| P3 | Structural or optimization work to sequence using measured need. |
| Reproduced | Observed through a focused invocation, test, or rendered interface. |
| Source-confirmed | Direct behavior or omission visible in the reviewed implementation; not necessarily exercised end to end. |
| Risk | Credible failure scenario from source; incidence or complete exploit/failure path not established. |
| Design judgment | Proposed improvement requiring usability or product validation. |

Confidence applies to the stated observation, not to its frequency in production. Effort estimates later in this document are relative, not delivery commitments. Source references use repository-relative links; line locators refer to this baseline.

## 2. What has actually been built

| Surface | Implemented foundation | Assessment |
|---|---|---|
| VS Code chat | Streaming conversation, attachments, provider/model controls, tool feedback, permissions, context and voice entry points | Broad implementation; needs a simpler primary workflow and integrated failure testing. |
| Goals and plans | Durable goal state, work plan, continuation, progress, completion evidence, steering and interruption | Real functionality. Progress meaning and authority need clearer contracts. |
| Routing and subagents | Chief routing, specialist selection, task delegation and orchestration | Treat score quality and delegation benefit as measurable, not self-evident. |
| Agent Manager | Multiple sessions, worktree isolation, terminal integration | Substantial inherited feature inside the extension; not a separate backend per worktree. |
| Routines | Stored definitions, schedules/events, execution sessions, run history, blocked handling and outcomes | Implemented, but scheduling and lifecycle semantics need hardening before unattended dependence. |
| Review and checkpoints | Diff display, Keep/Undo, in-editor annotations, persisted acceptance boundaries and checkpoint commands | Valuable foundation with action-scope and acknowledgement defects. |
| History | Local/cloud/worktree sources, search/list interactions, import | Already more complete than the preview fixture suggests; clarify scope and recovery semantics. |
| Memory and indexing | Project memory, auto-consolidation settings, inspect action, retrieval/index lifecycle and worktree handling | Engineering depth exists; users need provenance and understandable status. |
| Canvas | React source/data artifacts, compilation, panel rendering, refresh, error reporting, design picking and capture | More than a roadmap placeholder; durability and failed-update recovery are unfinished. |
| Browser | Persistent browser context, screenshot/interaction bridge, manual control, smoke checks and captured authentication | Real automation; persistent identity and boundary failures require explicit operational treatment. |
| Usage | Time-range and model aggregation, session/token/cost data | Useful, but unknown prices currently collapse to zero in the reviewed query. |
| Voice/media | Composer controls, reconstruction support, separate Go media service and room/engine adapters | Implemented across several components; end-to-end reliability was not established here. |
| CLI/TUI | Agent runtime entry points, terminal interaction and many mature coding workflows | Major product surface; retain keyboard efficiency while aligning lifecycle semantics. |
| Console/web UI | Separate console and shared web components | Real code and passing focused tests; not visually or operationally certified in this audit. |
| JetBrains | Large plugin with split frontend/backend architecture, RPC, sessions and downloader | Substantial inherited product. Raya-specific distribution/parity needs an explicit decision. |
| Zed integration | Extension manifest/integration scaffold | Do not imply the same Raya feature support as VS Code. |
| Mobile companion | Design/plan document | Planned; not counted as a delivered application. |

The older product documentation understates the extracted runtime packages. The present system spans `opencode`, `core`, `llm`, `server`, `protocol`, `schema`, several client/SDK surfaces, and UI packages. Both generations matter during this transition.

## 3. Product and workflow findings

### PR-01 — Establish an outcome-led default experience

**P2 · Design judgment · Confidence: medium · Users:** Everyone, especially colleagues who do not think in models, agents, and tools.

**Evidence:** [PromptInput](../packages/kilo-vscode/webview-ui/src/components/chat/PromptInput.tsx) combines model selection, attachment, auto-approval, sandbox, speech and voice controls; the preview composer foregrounds Agent/model/Thinking controls. [ProvidersTab](../packages/kilo-vscode/webview-ui/src/components/settings/ProvidersTab.tsx) and related connection dialogs expose provider-specific setup.

**Shortcoming:** Configuration concepts occupy the same decision space as expressing the task. The source supports many capabilities, but that breadth alone does not establish a clear first-success path for an operations, finance, or design colleague.

**Improve:** Make the primary path: describe the outcome, attach relevant material, understand what access is needed, start, review the result. Provide a company-recommended configuration with a visible explanation and an advanced override. Preserve expert controls, but place infrequent choices in a secondary area. Show the active configuration compactly after selection.

**Better earlier decision:** Design the first successful task before extending the composer toolbar. Treat each added control as a cost to the primary workflow.

**Implementation considerations:** Use existing provider/configuration services; do not create a second configuration store. A company default must not silently grant broad permissions or conceal cost-bearing providers.

**Acceptance:** In moderated tasks, a nontechnical colleague can connect or use the recommended setup, submit a task with context, and locate its result without understanding a routing score. Measure time to first success, setup abandonment, and requests for help.

### PR-02 — Make completion an inspectable agreement

**P2 · Source-confirmed foundation; design judgment on presentation · Confidence: high/medium · Users:** Anyone delegating multistep work.

**Evidence:** [Goal implementation](../packages/opencode/src/kilocode/goal/index.ts) stores goal/evidence state and validates completion references. Existing goal-state tests were included in the passing portion of the focused backend run.

**Shortcoming:** A valid reference to a successful tool run proves that the run occurred, not that it adequately covers the business outcome. Requirements and evidence selection are partly agent-authored. A completion label can be interpreted more strongly than its technical guarantee.

**Improve:** Present completion as a small result package: requested outcome, deliverables, checks performed, unresolved caveats, and review action. Distinguish tool success, automated verification, and user acceptance. Let users amend acceptance criteria before or during work without losing prior evidence.

**Better earlier decision:** Specify what “done” means at the product contract level, then implement the status enum and tool gate to support that meaning.

**Implementation considerations:** Retain current evidence validation. Add typed evidence provenance and invalidate relevant checks when their artifact changes. Avoid making every conversational answer require a heavyweight checklist.

**Acceptance:** A successful but irrelevant command cannot alone make a configured required check appear satisfied. Opening a completed task reveals the actual artifacts and verification, including explicit unverified aspects.

### PR-03 — Make routine scheduling explicit before activation

**P1 · Reproduced · Confidence: high · Users:** Anyone scheduling recurring work.

**Evidence:** [routines.ts:17](../packages/kilo-vscode/src/kilo-provider/routines.ts), `english()`. Actual invocations returned:

| Input | Parsed result | Consequence |
|---|---|---|
| `every Monday at 9am` | `0 9 * * 1-5` | Runs every weekday, not just Monday. |
| `every Friday at 3pm` | `0 15 * * 1-5` | Runs every weekday, not just Friday. |
| `every 2 hours` | `0 2 * * *` | Runs daily at 02:00. |
| `tomorrow morning` | Manual schedule | Requested scheduling silently disappears. |

**Shortcoming:** The parser accepts everyday schedule phrases while producing materially different execution schedules without an explicit ambiguity error.

**Improve:** Use a structured schedule editor as the canonical representation. Natural-language input can populate it, but display the interpreted recurrence, timezone, and next three occurrences before enabling. Unsupported phrases should produce a correction prompt, not a plausible but different schedule.

**Better earlier decision:** Define a bounded grammar with rejection behavior instead of treating the first number and weekday substring as sufficient intent.

**Implementation considerations:** Keep parsing independent from execution. Preserve the original phrase for diagnosis. Validate cron and timezone at the API boundary as well as in the UI.

**Acceptance:** Monday and Friday remain distinct; interval recurrence is either represented accurately or rejected; ambiguous input never activates silently. Test daylight-saving transitions and examples supplied by actual company users.

### PR-04 — Define a routine's authority in capabilities, not its persona

**P1 · Source-confirmed policy shape; risk in complete enforcement · Confidence: high/medium · Users:** Routine creators and people whose data routines access.

**Evidence:** [task/index.ts:139](../packages/opencode/src/kilocode/task/index.ts) contains `rules()`, role-based brief mode, capability consent sets, and a default full-access configuration. Brief mode denies several named writing tools; an explicit tool list starts with deny-all. [Sandbox backend](../packages/kilo-sandbox/src/backend.ts) does not support Windows confinement.

**Shortcoming:** “Briefer,” “Accountant,” and “Inbox” express purpose; they are not a complete security model. Denying selected writing tools does not by itself demonstrate read-only behavior across delegation, plugins, MCP tools and browser actions. An objective saying to write only in one directory is not filesystem enforcement.

**Improve:** Show an access summary at creation and before escalation: readable locations, writable locations, external services, allowed actions, approval requirements and execution isolation. Derive it from actual capabilities. Give scheduled work a narrow, understandable default profile.

**Better earlier decision:** Separate persona, task instructions, and enforceable authority in the data model.

**Implementation considerations:** Trace permission inheritance through delegated tasks and extension-host bridges before promising a read-only profile. Explicitly represent unsupported isolation. Preserve fail-closed behavior when confinement is requested.

**Acceptance:** A routine configured for read-only work cannot mutate through an alternate tool category. Permission changes are visible and recorded. Tests cover direct tools, delegated tasks, plugin tools, and browser actions where supported.

### PR-05 — Make spending understandable and bounded where needed

**P1 for accounting semantics; P2 for policy UX · Source-confirmed/design judgment · Confidence: high/medium · Users:** Task owners and company administrators.

**Evidence:** [project-usage.ts:92](../packages/opencode/src/kilocode/session/project-usage.ts) coalesces missing cost to zero. Existing cost-alert behavior is a useful warning mechanism, but a warning is a different guarantee from an enforced budget. Goal/routine definitions reviewed do not establish a complete cross-provider run budget.

**Expanded source finding:** [session.ts:417](../packages/opencode/src/session/session.ts), `getUsage()`, already prefers provider-reported cost and otherwise calculates token-based cost from model rates, including cache buckets, reasoning and context tiers. The improvement is to preserve and extend this existing calculation, its coverage and provenance across all paths. Do not replace it with “unavailable” whenever the provider omits a monetary total. See OVR-04 for the complete accounting specification.

**Shortcoming:** Zero can mean either free or unavailable. Users cannot reliably infer total financial exposure from that number. Long-running delegation also needs a clear policy for what happens when an agreed limit is approached.

**Improve:** Prefer valid provider-reported cost; otherwise calculate an estimate from normalized usage and the applicable provider/model rate card. Distinguish those estimates from genuinely unpriceable usage and show coverage. Define per-run spending or work limits for unattended tasks, with pause-and-request behavior and explicit override authority. Start with personal/local policies if that matches deployment; do not build an unnecessary multitenant billing platform.

**Better earlier decision:** Include cost provenance and policy scope in the contract before designing totals and alerts.

**Implementation considerations:** Aggregate child work once, reserve conservatively for concurrent calls, and reconcile provider usage. Clarify that external billing may differ from local estimates. Reuse current alerts as the presentation layer where appropriate.

**Acceptance:** Missing price data renders as unavailable, not free. A run's limit applies across its children, and an override is attributable. Exercise unknown pricing, late usage, retries and partial failures.

Where rates and usage are known, acceptance also requires a visible calculated estimate. “Unavailable” is the last fallback, not the default replacement for zero.

### PR-06 — Publish a supported-client and feature matrix

**P2 · Source-confirmed divergence; product decision · Confidence: high · Users:** Installers, maintainers and company support.

**Evidence:** Root [README](../README.md), [fork map](FORK-MAP.md), [mobile plan](Raya-Mobile-Companion-Plan.md), [JetBrains package](../packages/kilo-jetbrains), and [extensions](../packages/extensions) describe or implement different product generations and distribution paths.

**Shortcoming:** A repository containing a client does not make it a supported Raya client. Branding, bundled backend, available features, and release validation are not uniformly aligned.

**Improve:** State which surfaces are company-supported, experimental, inherited infrastructure, or planned. For each supported client, name the backend version contract, authentication approach, update channel, platform support and feature differences. Keep mobile explicitly planned until a working client exists.

**Better earlier decision:** Establish a product support boundary at the fork, independently of code ownership.

**Implementation considerations:** A deliberate “VS Code first; inherited clients maintained but not Raya-certified” policy is legitimate. Avoid forcing visual parity on the keyboard-oriented TUI.

**Acceptance:** A colleague can identify the correct installer and expected features without reading source. CI and release notes use the same support matrix.

## 4. Engineering findings

### EN-01 — Gate destructive session migration on an explicit upgrade policy

**P0 if an affected existing database is supported; otherwise P1 documentation/guard work · Source-confirmed · Confidence: high · Users:** Users upgrading databases predating the reset migration.

**Evidence:** [20260622170816_reset_v2_session_state.ts:5](../packages/core/src/database/migration/20260622170816_reset_v2_session_state.ts) deletes session inputs/messages, context epochs, events and workspaces, and clears workspace associations. It is registered in the migration set; application of unapplied migrations is not itself a backup policy.

**Shortcoming:** The migration contains intentional data destruction. Whether it affects deployed Raya users depends on their database lineage. Fresh databases and databases that already applied it have different exposure. This audit did not run it against user data or establish that any user lost data.

**Improve:** Before another rollout, inventory the shipped database generations. If affected upgrades are supported, provide a verified backup/export and recovery path, or replace the destructive transition with a preservation strategy. If the migration was strictly for disposable experimental data, encode and document that boundary.

**Better earlier decision:** Treat stored conversations and work as a product durability contract before resetting a schema generation.

**Implementation considerations:** Use disposable upgrade fixtures representing real schema versions. Include interruption and rollback behavior; a backup that cannot be restored is not an acceptance criterion.

**Acceptance:** Every supported upgrade preserves the agreed data or explicitly records the approved reset condition. An automated fixture verifies pre/post history, workspace references and recoverability.

### EN-02 — Give routines atomic execution ownership and restart semantics

**P1 · Source-confirmed guards; concurrency risk · Confidence: high/medium · Users:** Unattended-work users.

**Evidence:** [task/index.ts:120](../packages/opencode/src/kilocode/task/index.ts), `next()`, suppresses only `running` history. [Task runner](../packages/opencode/src/kilocode/task/runner.ts) creates sessions and records runs through separate operations; parked waiting runs are blocked. Roster/history persistence uses read-modify-write collections.

**Shortcoming:** A waiting run does not have the same scheduling exclusion as a running one. Manual, event, and timer triggers need a shared claim to prevent overlap. Restart settlement also needs to distinguish interrupted active work from terminal failure rather than infer it from a small status mapping.

**Improve:** Specify an explicit run state machine with queued, claimed, running, waiting, paused, completed, failed and cancelled meanings. Add a per-routine atomic claim and a policy for overlapping triggers: skip, queue, or parallel with an explicit limit. Persist trigger identity and recovery information.

**Better earlier decision:** Model the scheduler as durable work ownership rather than a timer wrapped around session creation.

**Implementation considerations:** Reuse the ownership principles in [core run coordinator](../packages/core/src/session/run-coordinator.ts). A process mutex alone is insufficient if multiple backend processes can schedule the same persisted routine. Make restart reconciliation idempotent.

**Acceptance:** Simultaneous manual/timer/event triggers follow the declared policy; waiting for a user does not create unintended duplicate work. Kill/restart at each claim/session/history boundary and verify exactly the expected recoverable runs.

### EN-03 — Implement timezone and event-filter semantics end to end

**P1 · Source-confirmed · Confidence: high · Users:** Routine users across locations and event-trigger users.

**Evidence:** [task/index.ts](../packages/opencode/src/kilocode/task/index.ts) accepts `schedule.tz`, but `next()` calls the cron evaluator without it. [cron.ts](../packages/opencode/src/kilocode/task/cron.ts) uses local `Date` fields and minute scanning. `listen()` accepts a configured filter when the incoming filter is absent because comparison requires both to be truthy.

**Shortcoming:** Stored timezone metadata does not determine execution, and an event missing the expected filter can match. Timer polling also needs a declared policy for sleep and missed occurrences.

**Improve:** Evaluate schedules with an explicit timezone, reject unsupported cron constructs, require a matching filter when configured, and document catch-up behavior. Store the scheduled occurrence independently of actual start time.

**Better earlier decision:** Treat schedule metadata as executable semantics, with conformance cases for every accepted field.

**Implementation considerations:** Prefer a well-tested evaluator or a deliberately restricted grammar; benchmark pathological expressions. Distinguish daylight-saving skips/duplicates from missed wakeups.

**Acceptance:** The same routine produces the same intended local occurrences on hosts in different zones. Missing/mismatched event filters do not trigger it. Sleep/resume follows the stated catch-up policy.

### EN-04 — Acknowledge review actions before dismissing them

**P1 · Source-confirmed · Confidence: high · Users:** Anyone accepting or undoing edits.

**Evidence:** [InEditorReview.ts:123](../packages/kilo-vscode/src/edit-review/InEditorReview.ts): `undo()` catches a rejected discard call and then still adds the dismissal and emits an undo action. `keep()` dismisses before the asynchronous persistence result. Undo captures `target` for the request but uses mutable `sid` for the subsequent notification.

**Shortcoming:** Failure can look like success. Switching sessions while a request is pending can also associate its notification with a different session. These are trust-sensitive operations.

**Improve:** Model pending/success/failure explicitly; dismiss only after a confirmed successful response. Keep the session, directory, file and revision captured for the entire operation. Handle SDK error-valued responses as well as thrown errors according to the client contract.

**Better earlier decision:** Use optimistic UI only where rollback is safe and visible. Acceptance boundaries and destructive undo deserve server acknowledgement.

**Implementation considerations:** Prevent duplicate requests while pending, retain retry affordances, and refresh authoritative state after reconnect. Do not lose the user's selection on an error.

**Acceptance:** Rejected and error-valued responses leave the review available with an actionable error. Switching sessions mid-request never updates the wrong session. Retrying is idempotent.

### EN-05 — Identify reviewed content by revision, not line positions

**P1 · Source-confirmed · Confidence: high · Users:** Users reviewing iterative edits.

**Evidence:** [InEditorReview.ts](../packages/kilo-vscode/src/edit-review/InEditorReview.ts), `print(review)`, derives the dismissal identity from changed line ranges. Review construction skips entries without added ranges.

**Shortcoming:** Different edits to the same line range can share a dismissal identity. Deletion-only changes do not receive this in-editor review treatment, although other diff views remain available.

**Improve:** Use an authoritative patch/content revision as the acceptance identity. Represent additions, modifications and deletions in the review model. Anchor deletion actions to a meaningful neighboring line or the file header.

**Better earlier decision:** Make reviewed artifact identity a backend/UI contract instead of deriving it from presentation geometry.

**Implementation considerations:** Normalize paths consistently and handle renamed/deleted files. Do not invalidate accepted work merely because unrelated line offsets changed.

**Acceptance:** A second change to the same lines reopens review; deletion-only and renamed-file changes remain discoverable; stale actions are rejected or refreshed safely.

### EN-06 — Preserve the last working canvas across failed updates and restarts

**P1 · Source-confirmed · Confidence: high · Users:** People relying on generated visual artifacts.

**Evidence:** [canvas-compiler.ts:60](../packages/kilo-vscode/src/services/canvas/canvas-compiler.ts) writes source/data before build success. [Canvas panel](../packages/kilo-vscode/src/services/canvas/canvas-panel.ts) displays build/runtime errors and keeps current build state in memory. Restore messaging asks for a rerun/update to restore the live artifact.

**Shortcoming:** An invalid update can replace persisted working source. A successful artifact is not yet treated as a durable product object with a recoverable revision.

**Improve:** Save drafts separately, build a candidate revision, and promote only after compilation and render acknowledgement. Persist a manifest for the latest working revision. Offer “keep previous version,” “inspect error,” and “retry” without requiring users to reconstruct the prior result.

**Better earlier decision:** Define artifact lifecycle and recovery before treating compilation output as the artifact itself.

**Implementation considerations:** Keep source/data/bundle revisions coherent; include build identity in ready/render/error messages; ignore stale acknowledgements. Limit cache retention. Preserve existing design picking and capture functionality.

**Acceptance:** Syntax errors, runtime errors, late messages and extension restart leave the last working artifact accessible. A failed candidate is inspectable without becoming the committed version.

### EN-07 — Use explicit compatibility contracts during the runtime migration

**P2 · Source-confirmed transition; architectural risk · Confidence: high/medium · Users:** Engineers and all clients.

**Evidence:** [Protocol API](../packages/protocol/src/api.ts) labels the new surface experimental. [Client contract](../packages/client/src/contract.ts) maps endpoint names and explicitly omits selected endpoints. `sdk`, `sdk-next`, `client`, legacy `opencode` routes, `server`, `schema` V1 adapters and `session-ui` coexist. The architecture guard passed.

**Shortcoming:** Several valid layers are in transition. Without an explicit ownership/version map, new features can attach to whichever API is most convenient and multiply adapters. Broad casts at client bridges conceal semantic gaps even when types compile.

**Improve:** Publish an endpoint ownership matrix and migration criteria. Define client capability negotiation or an equivalent supported-version contract. Keep conversions in narrow, tested adapters; document omitted endpoints and legacy behavior intentionally retained.

**Better earlier decision:** Plan migration by user-visible capabilities and compatibility guarantees, not package extraction alone.

**Implementation considerations:** Preserve fine-grained reactive access in UI adapters; copying full session structures on each streaming delta can create avoidable rendering work. Keep Kilo/Raya changes at owned boundaries to limit upstream conflicts.

**Acceptance:** Each supported client has a contract suite against its supported backend. Unknown events are safely handled, required features fail clearly when unavailable, and generated outputs are checked for drift.

### EN-08 — Repair schema regression checks and isolate contract-test state

**P1 for failing baseline checks · Reproduced · Confidence: high · Users:** Maintainers and release owners.

**Evidence:** `bun test ./test --only-failures` in `packages/schema` produced **13 pass, 4 fail**. Two event-manifest assertions expected the old count/order: expected 55 server definitions, received 58. Two filesystem checks used a URL pathname yielding `/C:/...` on Windows. The client suite produced **13 pass, 1 fail, 1 error** when a transitive import attempted global state writes outside the sandbox.

**Shortcoming:** Some contract tests are stale or platform-dependent. Client test imports also reach writable user-state initialization before isolation is established. The client failure does not prove a production API defect, but it exposes test/environment coupling.

**Improve:** Verify manifests by stable event identities and compatibility assertions rather than brittle slice offsets alone. Convert file URLs using platform-aware APIs. Establish isolated state before runtime imports; keep pure contract modules free of incidental filesystem initialization where feasible.

**Better earlier decision:** Make portability and test isolation properties of the harness, not conventions individual tests must rediscover.

**Implementation considerations:** Investigate each new event before updating expectations; do not mechanically change 55 to 58 and call compatibility proven. Avoid massive schema-object diffs by comparing concise identifiers.

**Acceptance:** Schema and client suites pass on supported Windows/Linux environments with no writes to real user state. Deliberate event removal or incompatible payload change still produces a clear failure.

### EN-09 — Harden the update path and credential storage

**P1 · Source-confirmed · Confidence: high · Users:** Company users installing private releases.

**Evidence:** [update-checker.ts:31](../packages/kilo-vscode/src/services/update-checker.ts) reads the token from configuration. Its `compare()` simplifies prerelease comparison, and asset selection accepts a sole VSIX as fallback. The download/install path reviewed does not verify an accompanying artifact digest. The JetBrains downloader has stronger verification/staging patterns.

**Shortcoming:** Private-release credentials are treated as settings. Release eligibility, platform identity and artifact integrity deserve stricter handling than a generic release list and filename fallback.

**Improve:** Store private credentials through VS Code SecretStorage, migrate existing values carefully, and remove the old value after successful migration. Use semantic version precedence, explicit release-channel/tag rules, exact platform manifests and verified artifacts. Retain the working installed version on failure.

**Better earlier decision:** Design distribution as a versioned trust boundary before adding an update notification.

**Implementation considerations:** Use [VS Code SecretStorage](https://code.visualstudio.com/api/references/vscode-api#SecretStorage), not settings, for secrets. Define the source and trust of checksums/signatures; a checksum fetched from the same compromised source is not independent authenticity proof. Do not display tokens in errors or diagnostics.

**Acceptance:** Prerelease ordering, unrelated tags, wrong-platform assets, truncated downloads, verification failure, revoked credentials and interrupted installation have deterministic safe outcomes. No new token is written to settings.

### EN-10 — Specify the supported local-service security topology

**P1 before shared/remote deployment; P2 for local documentation · Source-confirmed/risk · Confidence: high/medium · Users:** Deployers and company users.

**Evidence:** [server/auth.ts](../packages/server/src/auth.ts) has optional configured Basic authentication. The extension uses a generated backend credential in its normal managed connection path. [Media service main](../services/raya-mf/cmd/raya-mf/main.go) defaults to loopback and exposes session control handlers. Container configuration reviewed publishes the media service on host loopback.

**Shortcoming:** Local process trust, user authentication and tenant isolation are different guarantees. Directory context in a shared backend is not an identity boundary. The reviewed media control surface needs a declared trust model if it ever moves beyond a single-user local setup.

**Improve:** Document and validate the supported topology: per-user local backend, credentials, bind address, origins, workspace scope, media service access and teardown. Gate remote/shared configurations on an explicit authentication and isolation design.

**Better earlier decision:** State deployment assumptions in executable configuration checks, not only architectural prose.

**Implementation considerations:** Preserve the current loopback defaults. Do not build enterprise multi-tenancy unless the deployment actually requires it. Bound request sizes and lifetimes on local control endpoints as defensive reliability measures.

**Acceptance:** Supported launch paths bind and authenticate as documented. A configuration that exposes an unsupported unauthenticated service is rejected or requires an explicit supported setup. Cross-directory isolation is tested independently from authentication.

### EN-11 — Give browser identity and captured authentication a lifecycle

**P2 · Source-confirmed persistence; risk · Confidence: medium · Users:** Browser automation users.

**Evidence:** [browser-session.ts](../packages/kilo-vscode/src/services/browser-automation/browser-session.ts) uses a persistent browser context. [browser-smoke.ts](../packages/kilo-vscode/src/services/browser-automation/browser-smoke.ts) captures authentication state for smoke workflows. Manual takeover and action serialization already exist.

**Shortcoming:** Persistent sessions are convenient but make identity, expiry, ownership and cleanup product concerns. Automation success can depend on a logged-in profile that users do not realize remains active.

**Improve:** Show which browser profile/workspace is active, offer deliberate session reset, define captured-auth retention and deletion, and make expired authentication a recoverable state. Explain whether a smoke check used saved authentication. Audit evaluation retries for operations that can have side effects; no duplicate-side-effect defect was reproduced in this audit.

**Better earlier decision:** Treat browser identity as user-managed state from the first persistent-profile implementation.

**Implementation considerations:** Never include cookies/tokens in routine diagnostics. Bound stored captures and scope them to intended projects. Preserve manual takeover and distinguish user navigation from agent navigation.

**Acceptance:** Expired login, profile lock, missing browser, restart and takeover all give actionable recovery. Deleting captured authentication removes the intended persisted files and subsequent runs cannot reuse them.

### EN-12 — Make media failures observable and session ownership atomic

**P2 · Source-confirmed ignored errors; concurrency risk · Confidence: medium · Users:** Voice users and support engineers.

**Evidence:** [Media service](../services/raya-mf) contains session manager, engine and room adapters. Reviewed session paths discard several media publish/interrupt/send errors. Manager creation checks and insertion are separate operations. The local Go test invocation failed because the installed Go standard-library source packages could not be resolved.

**Shortcoming:** Audio can fail at several boundaries with no useful user-facing distinction. Concurrent starts for the same session need atomic ownership. This audit did not establish end-to-end latency, audio quality or production failure frequency.

**Improve:** Define connecting/listening/thinking/speaking/interrupted/reconnecting/failed states with typed failure reasons. Claim a session before allocating transport resources; close all resources on partial setup failure and terminal disconnect. Audit bounded queue overflow and backpressure explicitly.

**Better earlier decision:** Define the media lifecycle, teardown and diagnostics alongside the happy-path streaming protocol.

**Implementation considerations:** Pin deployable media dependencies instead of relying on mutable image tags. Keep transcript telemetry opt-in and redacted according to company policy. Reproduce with synthetic audio and local adapters before using real conversations.

**Acceptance:** Duplicate starts allocate one owned session; disconnect/reconnect does not leak rooms or goroutines; interruptions stop the intended speech; engine/room failures produce a specific recovery action. Run the service tests in a known-good Go environment before release claims.

### EN-13 — Treat recordings and telemetry as separate data products

**P2 · Source-confirmed mechanisms; policy gap to validate · Confidence: medium · Users:** Company users and maintainers.

**Evidence:** [HTTP redaction](../packages/http-recorder/src/redaction.ts), [redactor](../packages/http-recorder/src/redactor.ts), [telemetry client](../packages/kilo-telemetry/src/client.ts), and [identity](../packages/kilo-telemetry/src/identity.ts). Recording redaction handles known structures; non-JSON bodies need separate treatment. Telemetry supports enablement controls and upstream ingest configuration.

**Shortcoming:** Header/JSON-key redaction does not guarantee that free text, SSE content or recorded responses contain no secrets. An upstream ingest destination is not itself evidence of improper collection; effective Raya enablement and company policy need explicit verification.

**Improve:** Inventory each outbound/recorded data category, destination, purpose and retention. Prefer allowlisted diagnostic fields. Separate local debugging cassettes from ordinary telemetry and provide an obvious opt-in path for sensitive recording.

**Better earlier decision:** Define data minimization by artifact type rather than assume one generic redactor makes every payload shareable.

**Implementation considerations:** Add adversarial synthetic examples across JSON, plain text, SSE, URLs and nested errors. Do not use actual company secrets as fixtures. Avoid publishing model prompts or file contents merely to diagnose latency.

**Acceptance:** A documented diagnostic bundle contains only approved fields; synthetic secrets are removed across supported formats; opt-out behavior is verified at the calling boundary, not just in the telemetry library.

### EN-14 — Measure recovery and streaming performance across client boundaries

**P2 · Architectural risk; measurement proposal · Confidence: medium · Users:** Long-session and multi-session users.

**Evidence:** [Run coordinator](../packages/core/src/session/run-coordinator.ts), server event routes, extension SSE adapters, session UI bridges, and routine history polling. Existing reconnection/heartbeat mechanisms are present. Routine refresh loads run histories per routine and polls repeatedly.

**Shortcoming:** Passing unit tests does not establish bounded work when many sessions, routines, tool parts and reconnects coexist. Frequent per-routine requests can amplify backend work; streaming projections can amplify rendering work.

**Improve:** Establish representative workload fixtures and measure input responsiveness, update latency, memory growth, reconnect recovery and request count. Add incremental/aggregated routine summaries and cancel stale refreshes when warranted. Define how clients resynchronize after dropped or unknown events.

**Better earlier decision:** Set workload and recovery budgets before optimizing isolated components.

**Implementation considerations:** Preserve existing reactive getter patterns and SSE recovery. Avoid premature virtualization or architectural rewrites without profiles. The measured preview bundle was a development build and is not a production size finding.

**Acceptance:** Large histories and multiple active sessions remain responsive under an agreed workload; reconnect reconciles authoritative state without duplicate messages or stuck spinners; routine refresh request volume is bounded and measured.

### EN-15 — Make release confidence reproducible across the fork

**P2 · Source-confirmed maintenance needs · Confidence: high · Users:** Maintainers and release owners.

**Evidence:** [Architecture guard](../script/check-architecture.ts), [workflow guard](../script/check-workflows.ts), [test inventory guard](../script/check-test-ci.ts), [Raya release workflow](../.github/workflows/raya-release.yml), package instructions and [fork map](FORK-MAP.md). The three executed guards passed. Some workflow runner choices assume infrastructure available to the upstream organization.

**Shortcoming:** Strong checks exist, but passing a workflow inventory is not proof that the fork can execute every required release check. Architectural documentation and product roadmaps also lag implemented paths.

**Improve:** Define one reproducible release evidence bundle: supported-platform build, affected tests, schema/SDK compatibility, migration fixture, packaged extension smoke, artifact verification and rollback notes. Verify runner access in the company fork. Update the architecture/fork map from actual entry points.

**Better earlier decision:** Treat fork maintenance as an ongoing product cost with named ownership and a small compatibility budget.

**Implementation considerations:** Reuse existing CI guards and test inventory. Keep changes in Kilo/Raya-owned boundaries where possible. Do not start disabled upstream workflows without understanding their permissions and infrastructure.

**Acceptance:** A maintainer can reproduce the required release checks from documented commands; every required workflow has a usable runner; the release evidence identifies exactly what was and was not exercised.

## 5. UX and UI findings

### UX-01 — Match review labels to action scope

**P1 · Source-confirmed · Confidence: high · Users:** Edit reviewers.

**Evidence:** [patch-ranges.ts](../packages/kilo-vscode/src/edit-review/patch-ranges.ts), `planReviewLenses()`, places Keep/Undo at changed regions but passes a file key. [InEditorReview.ts:170](../packages/kilo-vscode/src/edit-review/InEditorReview.ts) explicitly notes whole-file undo.

**Shortcoming:** Proximity implies that the adjacent region is the action target, while the implementation affects the file. A user can undo more than intended.

**Improve:** Immediately label the supported behavior “Keep file” and “Undo file,” with an accessible scope description. If region-level acceptance is a validated priority, implement stable hunk identities and backend conflict handling before presenting region-scoped controls.

**Better earlier decision:** Derive action placement and wording from the operation's real scope.

**Implementation considerations:** Explain accepted boundaries and subsequent edits. Offer a diff preview for broad revert/checkpoint operations where impact is not otherwise clear.

**Acceptance:** Users correctly predict what a click changes. Two-hunk, deletion-only, concurrent edit and stale patch scenarios preserve unaffected work according to the declared scope.

### UX-02 — Present progress as current work and next decision

**P2 · Rendered observation/design judgment · Confidence: high/medium · Users:** Goal users.

**Evidence:** Real GoalBannerView rendered in the preview in light/dark themes. The expanded state combined percentage, elapsed time, task count, turn count and tool count in a small metadata line. Work plan and recent activity can repeat the same “Now” information.

**Shortcoming:** Many precise-looking numbers compete without explaining progress confidence. Task completion percentage is not necessarily a forecast of remaining work. Tiny secondary typography makes this harder to scan.

**Improve:** Prioritize objective, current action, blocker/next decision, and last meaningful result. Group elapsed time and cost as supporting information. Put diagnostic turns/tool counts behind details. Label plan-based percentage as such or omit it where misleading.

**Better earlier decision:** Define the questions a progress view must answer before selecting available counters.

**Implementation considerations:** Preserve Steer/Pause/Stop controls and stable layout during streaming. Avoid announcing every token or timer tick to assistive technology.

**Acceptance:** In a five-second scan, users can explain what Raya is doing, whether they must act, and how to stop it. Paused, waiting and blocked states are distinguishable without relying on color.

### UX-03 — Use a consistent interruption and recovery vocabulary

**P1 for misleading errors; P2 for broader consistency · Source-confirmed/design judgment · Confidence: high/medium · Users:** All users.

**Evidence:** [routines.ts:43](../packages/kilo-vscode/src/kilo-provider/routines.ts), `reason()`, can map a generic HTTP 400 into role/consent guidance. Goal and routine state vocabularies, canvas errors, provider dialogs and media states express different recovery contexts.

**Shortcoming:** Incorrectly specific error guidance sends users toward the wrong remedy. “Blocked,” “waiting,” “paused,” and “failed” also need distinct meanings across surfaces.

**Improve:** Propagate typed error codes and safe human-readable context. Standardize a small state vocabulary: waiting for your answer, paused by you, retrying connection, failed with recoverable work, and completed. Every actionable error should identify what happened, what was preserved, and the next step.

**Better earlier decision:** Define error/state contracts jointly between backend and interface instead of translating generic statuses into guessed explanations.

**Implementation considerations:** Keep technical details expandable and copyable. Preserve user input on provider/setup failure. Avoid replacing a useful specific backend message with a generic friendly sentence.

**Acceptance:** Invalid schedules, denied capabilities and network errors receive different correct guidance. Dismissal is never interpreted as successful completion. Restart/reconnect returns users to the pending decision.

### UX-04 — Expose context provenance and control where work happens

**P2 · Source-confirmed foundation/design judgment · Confidence: medium · Users:** Users handling evolving or sensitive project knowledge.

**Evidence:** [ContextTab](../packages/kilo-vscode/webview-ui/src/components/settings/ContextTab.tsx) already provides memory enablement, auto-save, storage information and inspection. [Indexing orchestrator](../packages/kilo-indexing/src/indexing/orchestrator.ts) has progress/cancellation state. Memory has redaction and context boundaries.

**Shortcoming:** A settings-level inspect action does not fully explain why a particular answer used particular memory, files or indexed information. Users need to correct stale context at the point of consequence.

**Improve:** Add a compact “Context used” disclosure on relevant tasks/results, identifying source, project scope, freshness and whether content was attached, retrieved or remembered. Connect corrections to the existing memory inspection/edit workflow. Distinguish indexing disabled, building, stale and failed.

**Better earlier decision:** Design provenance together with retrieval, rather than expose only storage and token counts.

**Implementation considerations:** Avoid revealing content the viewer is not authorized to access. Keep provenance bounded and useful; do not dump the entire prompt. Preserve worktree/project scoping.

**Acceptance:** Users can identify and correct the source of a stale remembered fact. Disabled or failed indexing is not presented as an empty but healthy index. A worktree switch shows the correct scope.

### UX-05 — Make history a route back to work, not just a list

**P2 · Design judgment · Confidence: medium · Users:** Returning users and multitaskers.

**Evidence:** [HistoryView](../packages/kilo-vscode/webview-ui/src/components/history/HistoryView.tsx) already separates local/cloud/worktree sources and supports import; Agent Manager owns additional worktree/session navigation.

**Shortcoming:** Multiple storage/source concepts can obscure the user's practical question: where is the task, what state is it in, and can I resume it here?

**Improve:** Retain source filters but foreground task title, project, meaningful last result, status and required action. Explain cloud preview versus import and which environment will execute a resumed task. Keep history selections stable during refresh.

**Better earlier decision:** Organize retrieval around task continuity before storage origin.

**Implementation considerations:** Do not collapse local and cloud identities or silently execute an imported session in the wrong directory. Preserve existing accessible tab behavior.

**Acceptance:** Users can find an interrupted task, determine its project and resume safely. Failed import and unavailable worktree states preserve the item with a clear explanation.

### UI-01 — Test real components in the visual harness

**P1 for verification integrity; P2 for harness cleanup · Reproduced · Confidence: high · Users:** Designers and maintainers, indirectly all users.

**Evidence:** Extension preview uses real goal components but hand-authored composer/history fixtures. Automated panel checks found undersized composer fixture targets and invalid history fixture tab semantics. The production HistoryView already has the missing roles and keyboard behavior.

**Shortcoming:** A visually plausible duplicate can both invent failures and hide production regressions. Screenshot approval cannot be treated as product verification when the underlying component is different.

**Improve:** Render production components with minimal typed providers and deterministic state. Clearly label the remaining illustrative fixtures. Add interaction checks for the real composer, history, review and goal panels.

**Better earlier decision:** Make previewability a component boundary requirement instead of recreating interfaces for screenshots.

**Implementation considerations:** Use existing Storybook/provider patterns. Keep provider fixtures narrow without copying business logic into test implementations.

**Acceptance:** A production markup/style change appears in the corresponding preview. The visual report identifies real versus illustrative components and never attributes a fixture-only failure to production.

### UI-02 — Establish measurable accessibility gates

**P2 · Rendered fixture findings; product validation required · Confidence: high about observations · Users:** Keyboard, low-vision, motor and assistive-technology users.

**Evidence:** At 420px preview width, composer fixture attach/send targets measured approximately 17–18px wide by 28px high and failed the automated target-size check. Light history fixture group text measured 3.16:1 contrast; timestamps included 4.11:1 and 4.42:1. Real goal panel examples produced no scoped automated violations. These results do not certify complete workflows.

**Shortcoming:** The inspected fixtures expose target-size and contrast weaknesses, while the available automated evidence does not establish accessibility of the actual end-to-end product workflows.

**Improve:** Adopt practical gates for keyboard operation, visible focus, accessible names, contrast, zoom/reflow, and pointer targets. Use [WCAG 2.2](https://www.w3.org/TR/WCAG22/) as the reference and account for its [target-size spacing and exception rules](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Increase hit areas independently of icon size.

**Better earlier decision:** Include focus, target size and state announcements in component acceptance criteria from the beginning.

**Implementation considerations:** Validate both host themes and high-contrast configurations. Test page-level overflow as well as panel scroll width; the narrow fixture screenshot alone did not establish a responsive pass. Conduct manual screen-reader and keyboard testing on real workflows.

**Acceptance:** Every primary action is keyboard-operable and visibly focused; dialogs restore focus; asynchronous errors/status are announced appropriately; supported narrow layouts and zoom remain usable. Automated checks supplement, not replace, manual validation.

### UI-03 — Consolidate component semantics while preserving host-specific styling

**P2 · Source-confirmed differences/design judgment · Confidence: medium · Users:** All clients and UI maintainers.

**Evidence:** `kilo-ui` reuses parts of `ui`; it is not wholly duplicate. Shared UI and `kilo-web-ui` button implementations differ in default variant/size vocabulary. Extension, console, session UI and TUI have distinct host needs.

**Shortcoming:** Similar names can imply shared behavior while defaults differ. Cross-package screens become harder to reason about when component semantics and tokens drift.

**Improve:** Define shared semantic roles for primary/secondary/destructive actions, statuses, spacing, typography and focus. Map those to each host's tokens. Document justified differences instead of attempting one universal CSS layer.

**Better earlier decision:** Standardize interaction semantics first, then theme adaptations and component exports.

**Implementation considerations:** Inventory actual reuse before consolidation. Preserve VS Code theme integration, web layout needs and TUI keyboard conventions. Localize new user-facing state text through existing language facilities.

**Acceptance:** Equivalent actions have consistent meaning, naming and disabled/pending behavior across supported clients. A small component matrix covers themes, sizes, focus, loading, error and long translated labels.

## 6. Feature improvement specifications

These specifications translate the findings into reviewable experience changes. They are proposals, not claims that every item is currently absent.

| Workflow | Preserve | Proposed improved experience | Engineering boundary | Verification |
|---|---|---|---|---|
| First run/provider setup | Existing provider dialogs and model support | Recommended company setup; connection test; plain-language failure; advanced overrides | Config/provider/auth services | Fresh profile, expired credential, unavailable model, offline startup. |
| Chat/attachments | Streaming, mentions, paste/drop and explicit attachment action | Clear attached context; understandable send/stop state; preserve draft on failure | PromptInput and session submission | Submit failure, rapid resubmit, attachment error, session switch. |
| Plans/goals | Durable plan and completion evidence | Editable acceptance criteria; current action; pending decision; result package | Goal schema, runtime and banner | Change criteria mid-run; invalidate stale evidence; resume interruption. |
| Routing/subagents | Existing routing and delegation | Explain important delegation decisions; show owner and child status; offer override | Chief routing/task metadata | Curated ambiguous tasks, routing quality, cancellation propagation. |
| Routines | Definitions/history/session reuse | Structured schedule preview; access summary; overlap policy; run outcomes | Scheduler/store/runner | Simultaneous triggers, restart, DST, waiting approval, invalid schedule. |
| Review/undo | Diffs and accepted boundaries | Honest file scope; pending feedback; recoverable failure; revision-aware review | Review API and editor controller | Multi-hunk/deletion/rename, stale revision, network failure. |
| History | Local/cloud/worktree sources and import | Task continuity, project identity and safe resume | History/session/worktree services | Import failure, deleted worktree, large list and keyboard navigation. |
| Memory | Enable/inspect/auto-save and redaction | Context provenance and easy correction | Memory service and context disclosure | Stale memory, secret patterns, worktree scope, disabled state. |
| Indexing | Progress, cancellation, cache and overlays | Explain readiness/freshness and useful recovery | Index state/orchestrator/vector store | Large repository, cancellation, reconnect, stale overlay and ignores. |
| Canvas | Compilation, render acknowledgement, picking and capture | Stable last-working artifact; draft errors; reopen and revision history | Compiler/manifest/panel | Invalid update, runtime exception, restart and stale render message. |
| Browser | Persistent context, takeover and smoke evidence | Visible profile, explicit handover, expired-login recovery and reset | Browser host/bridge/profile | Missing Chrome, locked profile, auth expiry, redirect and takeover. |
| Terminal/Agent Manager | Worktree and terminal context | Always-visible target project/session; clear command ownership | Shared connection and directory-aware state | Parallel worktrees, terminal reconnect, session switch during action. |
| Voice | Native media path and transcript reconstruction | Listening/speaking/interruption feedback; actionable transport errors | Extension/media service/engine/room | Interrupt, device denial, reconnect, duplicate start and teardown. |
| Usage | Step-based aggregation and range selection | Known versus unknown cost; budget state; child attribution | Usage schema/query/policy | Missing prices, time boundaries, child runs and late records. |
| CLI/TUI | Keyboard-efficient workflows | Same lifecycle meanings and recovery guarantees with terminal-native presentation | TUI/runtime contract | Resize, cancellation, long output, reconnect and key conflicts. |
| Console/JetBrains | Existing client foundations | Explicit support/version status; shared behavior where promised | Client adapters and packaging | Supported backend matrix and packaged client smoke. |

### Routing evaluation specification

Do not interpret a routing threshold such as 0.7 as a calibrated probability without evidence. Create a versioned task corpus from anonymized, representative company work: coding, document review, analysis, design, simple questions, ambiguous requests, and mixed tasks. Label acceptable routes and when clarification is needed. Measure task success, unnecessary delegation, latency, tool cost, overrides and routing stability. Compare routing against a simple baseline. Improve the score/prompt only when it improves outcomes, not just the fraction routed automatically.

### Review and recovery specification

Every mutating user action should have a documented target, revision, pending state, acknowledgement, failure state and retry behavior. Apply this consistently to Keep/Undo, checkpoint restore, routine changes, memory changes and artifact updates. A user should never need to infer success from a control disappearing. Existing acceptance/checkpoint mechanisms should be extended instead of creating another parallel history model.

### Internal-company operating model

Start with the deployment actually needed: locally owned sessions with company defaults may be sufficient. Decide who owns recommended models, allowed integrations, support, release promotion and data retention. Add shared governance only where there is a concrete requirement. Avoid treating “internal tool” as either a reason to skip reliability or an automatic requirement for a large enterprise administration product.

## 7. Prioritized delivery plan

Effort: **S** is a localized change; **M** crosses a few components; **L** is a coordinated feature/state migration; **XL** requires architectural or multi-client work. These are relative sizes before implementation design.

| Order | Work package | Findings | Suggested owner | Effort | Dependencies | Exit criterion |
|---|---|---|---|---|---|---|
| 0 | Establish deployed database lineage and upgrade safety | EN-01 | Backend + release owner | S investigation; M/L remediation | Access to shipped-version inventory | Every supported database upgrade has a verified preservation/reset policy. |
| 1 | Repair review truthfulness and state acknowledgement | EN-04, EN-05, UX-01 | Extension + backend + design | M | Review response/revision contract | Failed actions remain actionable; labels match file scope; new edits reopen review. |
| 2 | Correct schedule interpretation and evaluation | PR-03, EN-03 | Backend + extension + design | M | Supported recurrence grammar | Correct examples, timezone behavior, filter rejection and next-run preview. |
| 3 | Restore trustworthy contract checks | EN-08 | Platform/testing | S/M | Event compatibility review | Schema/client checks pass in isolated supported environments. |
| 4 | Harden unattended routine ownership and authority | PR-04, EN-02 | Backend + security/platform | L | Schedule semantics; permission inheritance map | Atomic claims, intentional overlap, restart recovery and enforced capability tests. |
| 5 | Correct cost semantics and boundaries | PR-05 | Backend + product | M/L | Cost provenance schema | Unknown cost is distinct; agreed run-limit behavior works across children. |
| 6 | Protect canvas artifacts | EN-06 | Extension + UI | M | Revision/manifest design | Failed updates and restart retain the last working artifact. |
| 7 | Harden private update distribution | EN-09, EN-15 | Release/platform | M | Release manifest and credential migration | Verified platform artifact, safe update failure, no token in settings. |
| 8 | Replace misleading preview fixtures and add accessibility checks | UI-01, UI-02 | UI + QA/design | M | Real-component provider fixtures | Production components tested in themes, keyboard, zoom and narrow layouts. |
| 9 | Simplify first success and task progress | PR-01, PR-02, UX-02, UX-03 | Product + design + extension | L | User tasks; state/error contract | Moderated users complete and recover representative work unaided. |
| 10 | Improve context and work continuity | UX-04, UX-05 | Product + memory/indexing + UI | M/L | Provenance and task identity | Users find/resume work and correct stale context safely. |
| 11 | Stabilize browser and voice operations | EN-10, EN-11, EN-12 | Extension + media/platform | L | Supported local topology; test environment | Reconnect/expiry/teardown matrix passes with actionable feedback. |
| 12 | Ratchet architecture, performance and data policy | PR-06, EN-07, EN-13, EN-14, UI-03 | Platform + client owners | L/XL, incremental | Supported-client matrix and workload budgets | Compatibility, recovery, diagnostics and performance evidence accompany releases. |

### Suggested sequence

**First quality pass:** Resolve the conditional migration gate, review defects, scheduling interpretation, schema failures, and updater credential handling. These are concrete issues with clear checks. Freeze expansion of unattended behavior until routine ownership and authority are understood.

**Second quality pass:** Durable canvas updates, cost semantics, routine lifecycle, real-component previews and accessible interaction. These make existing features dependable under realistic failure conditions.

**Third quality pass:** Simplify onboarding/progress, add context provenance, validate routing, and exercise browser/voice end to end. Measure company task outcomes before increasing automation complexity.

**Ongoing:** Keep API migration, fork documentation, supported clients, release evidence and performance budgets current. Avoid a separate rewrite project unless measured constraints justify one.

### Proposed success measures

| Outcome | Measure | Initial gate proposal |
|---|---|---|
| Trustworthy review | Failed operation falsely shown as accepted/undone | Zero in the defined failure matrix. |
| Correct scheduling | Parsed schedule differs from confirmed user intent | Zero accepted ambiguous cases in the supported grammar corpus. |
| Recoverable work | Supported restart scenarios requiring manual reconstruction | Zero for committed artifacts and acknowledged acceptance boundaries. |
| Usability | Representative task completed without facilitator rescue | Establish a baseline with mixed-ability colleagues, then agree a release target. |
| Accessibility | Blocking keyboard/focus failures in primary workflows | Zero in the supported-client manual checklist. |
| Runtime reliability | Duplicate scheduled work, stuck active state, lost pending approval | Zero in deterministic concurrency/restart tests. |
| Performance | Input latency, memory growth, reconnect time, refresh request count | Measure realistic workloads first; set budgets from baseline and user tolerance. |
| Release safety | Supported upgrade/build/client checks lacking evidence | Zero unexplained omissions in a promoted release. |

Do not use test-file count, tool-call count, or number of shipped features as a proxy for product quality.

## 8. Repository coverage

This was a repository-wide, risk-based sampled review, not a line-by-line proof of every package. Major inherited and Raya-owned packages were considered for responsibilities, integration, testing and user impact. Large package size does not imply every module was read. “Source review” below is not a claim that the package was executed. Small support packages received proportionate inspection; no artificial defect was assigned merely to fill the table.

| Package/surface | Role and reviewed focus | Assessment / follow-up |
|---|---|---|
| `packages/opencode` | CLI integration, goals, routing, routines, usage, server integration and focused tests | Concrete scheduling/accounting findings; typecheck passed; retain owned Kilo boundaries. |
| `packages/core` | Session coordination, database/migrations, global state and extracted runtime boundaries | Strong ownership foundations; migration exposure and import-time state isolation need attention. |
| `packages/llm` | Provider/protocol structure, routing/auth/tool contracts and recorded-test organization | Preserve provider-specific behavior; expand representative compatibility/recovery evidence rather than replacing adapters wholesale. Not live-provider tested. |
| `packages/server` | Authentication, protocol composition and event integration | Clarify supported topology and compatibility/reconnect contracts. |
| `packages/protocol` | API grouping, middleware placement and experimental surface | Good separation; document ownership and version support during migration. |
| `packages/schema` | Current/V1 separation, events, generated manifest and tests | Executed suite has stale manifest assertions and Windows path defects. |
| `packages/client` | Promise/Effect clients, endpoint mapping/omissions and tests | Explicit contract structure; one test blocked by global-state import permissions. |
| `packages/sdk/js` | Legacy generated API client and consumer role | Keep generated outputs authoritative; ensure compatibility against supported backend versions. |
| `packages/sdk-next` | New embedded/runtime client boundary | Include in migration ownership and capability matrix; no separate live integration pass. |
| `packages/httpapi-codegen` | Contract-generation responsibility and tests/outputs | Guard reproducibility and semantic drift; no isolated codegen execution claim. |
| `packages/effect-drizzle-sqlite` | Effect/Drizzle adapter and transactional interface | Include real transaction, rollback and error-channel checks in database matrix; no reproduced independent defect. |
| `packages/effect-sqlite-node` | Node SQLite adapter | Small adapter with platform/error-boundary implications; validate against the same database contracts. |
| `packages/codemode` | Host capability boundary and execution API | Package policy is host-owned; verify host-provided budgets/permissions before claiming bounded execution. No bypass established. |
| `packages/kilo-vscode` | Main product, chat/settings/history, review, goals, routines, browser/canvas, updates, Agent Manager and preview | Deepest exercised client; concrete review/artifact/update defects and UX opportunities. Both typechecks passed. |
| `packages/kilo-jetbrains` | Split architecture, session/service responsibilities, downloader and packaging configuration | Significant inherited client; strong downloader pattern. Requires separate Raya support decision and runtime validation. |
| `packages/tui` | Terminal client structure, input/lifecycle/test organization and runtime coupling | Preserve terminal-native UX; include supported platform, resizing and cancellation checks. No rendered TUI pass. |
| `packages/kilo-console` | Console application/service boundaries and source tests | 33 tests passed. Browser/backend integration not exercised. |
| `packages/session-ui` | Shared session rendering, adapters and reactive boundary guidance | Narrow contract adapters and real-component previews are priorities; avoid broad copies on streaming updates. |
| `packages/ui` | Shared component structure and behavior contracts | Standardize semantics and accessibility; retain host adaptations. |
| `packages/kilo-ui` | Extension-oriented reuse/export layer and stories | Not wholly duplicate of UI; avoid unnecessary library consolidation. |
| `packages/kilo-web-ui` | Web component variants and styling semantics | Align interaction meanings and explicit defaults with shared foundations. |
| `packages/storybook` | Shared UI/session story infrastructure and preview role | Distinguish production components from illustrative fixtures; existing untracked build log left untouched. |
| `packages/kilo-indexing` | Orchestration, state, cancellation, cache/provider interfaces and worktree concerns | Substantial implementation; improve freshness/provenance UX and large-repository recovery evidence. |
| `packages/kilo-memory` | Context handling, redaction, scope, persistence and tests | 165 tests passed; two symlink setup failures were environment permissions, not demonstrated memory defects. |
| `packages/kilo-sandbox` | Backend/platform selection and confinement boundaries | Windows unsupported; fail-closed requested confinement is a strength. Surface capability honestly. |
| `packages/kilo-gateway` | Authentication/provider integration boundary and test organization | Include credential expiry and provider capability behavior in deployment acceptance. No live gateway calls. |
| `packages/kilo-telemetry` | Enablement, identity, destination and shutdown/test structure | Verify effective company defaults and data policy; public ingest configuration is not a secret. |
| `packages/kilo-i18n` | Translation responsibility and shared-client integration | Route new state/error text through existing facilities; test long labels and pluralization. |
| `packages/http-recorder` | Cassette matching, redaction and transport support | Free-text/stream redaction requires artifact-specific policy and synthetic checks. |
| `packages/plugin` | Plugin/tool API responsibility | Version capability/permission contracts; validate behavior at the consuming host. |
| `packages/plugin-atomic-chat` | Hook organization, validation and shared model-status cache | Reuse centralized cache/validation; include endpoint/auth change and stale model discovery in integration testing. No live service validation. |
| `packages/extensions` | Zed integration manifest | Inherited integration is not evidence of Raya feature parity. |
| `packages/containers` | Container/build infrastructure | Distinguish CI/build containers from runtime isolation; verify image/release reproducibility. |
| `packages/script` | Shared build/script support | Include with root script ownership and release reproducibility, not a user-facing product. |
| `packages/kilo-docs` | Product/contributor docs and architecture guidance | Reconcile current runtime topology and support status; avoid roadmap claims as implementation evidence. |
| `services/raya-mf` | Media control, session ownership, engine/room integrations and container setup | Source risks identified; Go toolchain prevented tests. End-to-end voice remains unverified. |
| Root scripts/workflows/docs | Architecture, workflow and test inventory checks, releases and Raya plans | Three guards passed; document actual support, migration and release evidence. |

The instructions mention a `packages/util` package, but it was not present in the inspected package inventory. This is another reason to reconcile documentation with the actual checkout rather than audit from the architecture prose alone.

## 9. Validation and limitations

### Checks performed

| Check | Result | Interpretation |
|---|---|---|
| Root architecture guard | Passed: 4 classified ratchet sites, 0 boundary violations | Positive structural evidence, not complete runtime correctness. |
| Root workflow allowlist guard | Passed: 30 workflows | Inventory is synchronized; runner availability/execution is separate. |
| Root test/CI inventory guard | Passed: 25 test-bearing packages and 11 root script test files | Confirms configured inventory, not that all tests pass. |
| Extension typecheck | Host and webview passed | No type failures observed in these checks. |
| Opencode typecheck | Passed | No type failures observed in this check. |
| Extension `preview:check` | Passed with approved subprocess access | Preview compilation works outside initial sandbox restriction. |
| Backend focused goal/routing/canvas/usage/voice-reconstructor run | 37 passed, 1 canvas test timed out at default 5s | Startup/network conditions contributed uncertainty; not evidence of a persistent canvas logic failure. |
| Backend canvas rerun with 30s timeout | 3 passed, 0 failed | Initial timeout did not reproduce with the larger startup allowance. |
| Extension routine schedule/patch ranges/browser smoke focused tests | 13 passed across 3 matching files | The command also named a nonexistent canvas-compiler test path; that path ran no tests. No extension canvas-suite pass is claimed. |
| Console source tests | 33 passed, 0 failed | Focused package test evidence only. |
| Memory tests | 165 passed, 2 failed during symlink creation | Windows EPERM setup failures before the relevant assertions; not proven memory-boundary failures. |
| Schema tests | 13 passed, 4 failed | Two stale event-manifest assertions; two Windows file-URL path failures. |
| Client tests | 13 passed, 1 failed, 1 error | Transitive initialization attempted writes to user state denied by sandbox. Requires isolated harness follow-up. |
| Go media service tests | Could not run successfully | Installed toolchain could not resolve standard-library packages under its Go source path. No media correctness conclusion. |
| Actual routine English parser probes | Incorrect results for Monday, Friday, interval and ambiguous examples | Reproduced schedule interpretation defects. |

Commands were package-scoped; root `bun test` was not used. No full monorepo suite, production deployment, model-provider transaction or user-data migration was performed. Passing targeted tests does not erase the source-confirmed issues outside their assertions.

### Visual inspection method and results

The in-app browser was unavailable: its runtime reported no available browser. A local preview was built, then inspected using an isolated headless Edge context through Node Playwright. The initial sandboxed preview server could not serve successfully because its build subprocess lacked access; the approved build and a local static preview enabled inspection. No signed-in personal browser profile was used.

Inspected states included conversation, expanded goals, blocked/discard states, composer, usage and history, with representative light/dark variants and narrow layouts. The static harness used the preview's theme attribute and built assets. Its outer stage is harness chrome, not Raya's production background.

Automated accessibility scans were scoped to the preview panel and selected WCAG tags. Real goal examples had no reported violations in those scans. Composer/history observations were fixture-specific until traced to production code. The production HistoryView already supplies tab roles and keyboard handling absent in its fixture. Small text, hierarchy and target-size recommendations remain useful, but this audit does **not** claim those fixture failures are production defects.

Screenshots were inspection aids in temporary storage, not permanent deliverables or independently reproducible release artifacts. Only this Markdown document is the requested audit deliverable.

### Important unresolved validation

- Whether deployed user databases can encounter the destructive reset migration.
- Packaged VS Code behavior, including real webview keyboard/screen-reader interaction and editor review failures.
- Real-provider authentication, billing, cancellation and quota behavior across supported company configurations.
- Complete delegated-tool/MCP/browser authority enforcement for routine access profiles.
- Real browser authentication expiry/reset and smoke capture retention.
- Voice latency, device permissions, interruptions and resource teardown with a working Go environment.
- JetBrains split-mode runtime, TUI rendering and console/backend behavior across supported versions.
- Production performance, accessibility at zoom/high contrast, and usability with company colleagues.

These are explicit follow-up tests, not assumed failures. This audit is a detailed source and focused-runtime assessment, not a security certification or a guarantee that every line or platform has been exercised.

## 10. Decisions and review worksheet

Use this section to turn the audit into an approved scope before implementation.

| Decision | Proposed default | Your notes / decision |
|---|---|---|
| First supported company client | VS Code, with explicit status for other inherited clients | |
| Unattended routine rollout | Expand after schedule, authority and restart gates pass | |
| Review interaction scope | Honest file-level actions first; evaluate true hunk actions separately | |
| Database upgrade policy | Preserve user work across every supported version | |
| Recommended provider/model setup | Company-maintained recommendation with visible expert override | |
| Cost policy | Calculate from known rates and usage; disclose provenance and genuinely unpriced portions; bound unattended work | |
| Browser identity retention | Explicit project/profile lifecycle and reset behavior | |
| Voice readiness | Experimental until reproducible end-to-end validation passes | |
| UI quality gate | Real components, keyboard/focus/contrast/reflow checks and mixed-ability task testing | |
| Architectural investment | Full named-system and UX overhaul, implemented through cohesive contracts and owned boundaries | |

### Approval checklist for the next implementation plan

- [ ] Confirm deployment and database lineage for EN-01.
- [ ] Select the first delivery tranche from the roadmap.
- [ ] Assign one accountable owner per work package.
- [ ] Agree supported clients, platforms and provider configurations.
- [ ] Convert acceptance criteria into implementation-specific checks.
- [ ] Record which design recommendations need user research before building.
- [ ] Retain this audit's IDs in subsequent plans so decisions and deferrals remain traceable.

The proposed direction is to invest first in the reliability and clarity of what Raya already does: predictable scheduling, honest review actions, durable artifacts, understandable progress and recoverable execution. Those improvements make the existing breadth useful to more of the company.

## 11. Ten requested overhauls

This section follows the user's ten requests in order. It distinguishes the **browser skill** (the agent's operating procedure and judgment) from the **browser product/runtime** (the capabilities that make that procedure possible). Both are required. These specifications supersede any narrower interpretation of the initial roadmap. Nothing in this document authorizes the future implementation agent to publish releases, send messages, or mutate external systems beyond the authority provided in that implementation session.

| Request | Jump to specification |
|---|---|
| 1 | [OpenAI realtime voice](#111-ovr-01--openai-native-realtime-multimodal-voice) |
| 2 | [Browser skill](#112-ovr-02--a-first-class-browser-skill-for-agents) |
| 3 | [Auto routing](#113-ovr-03--smarter-auto-routing-and-orchestration) |
| 4 | [Calculated costs](#114-ovr-04--calculated-explainable-token-and-tool-costs) |
| 5 | [Routines](#115-ovr-05--a-durable-understandable-routine-system) |
| 6 | [Goals](#116-ovr-06--an-outcome-driven-goal-system) |
| 7 | [Complete UI and UX](#117-ovr-07--complete-raya-ui-and-ux-redesign) |
| 8 | [Work tools](#118-ovr-08--broad-work-tools-with-discoverable-capabilities) |
| 9 | [Self-heal](#119-ovr-09--self-heal-as-verified-recovery-and-repair) |
| 10 | [Browser runtime and product](#1110-ovr-10--browser-runtime-and-product-overhaul) |

“World class” is a direction, not a claim this document can certify. Here it means high task success, clear interaction, correct authority, durable work, graceful recovery and measured performance across representative company tasks. The acceptance criteria below make that direction testable.

### 11.1 OVR-01 — OpenAI native realtime multimodal voice

**Priority:** P1 architecture and prototype, then supported rollout. **Related findings:** EN-10, EN-12, PR-05. **Owner:** Voice/extension engineer with runtime and product support. **Status:** Proposed migration, not wired in by this audit.

#### Current implementation and recommendation

The current path is broader than MiniMax alone. [SpeechService](../packages/kilo-vscode/src/speech/service.ts) owns MiniMax TTS, OpenAI transcription and voice handoff. [RealtimeVoice](../packages/kilo-vscode/webview-ui/src/context/realtime-voice.ts), [voice protocol](../packages/opencode/src/kilocode/voice/protocol.ts) and [voice service](../packages/opencode/src/kilocode/voice/service.ts) contain Qwen-specific realtime contracts over LiveKit, backed by `services/raya-mf`. Therefore, replacing only the TTS client would leave the principal realtime architecture unchanged.

**Recommendation:** Make OpenAI speech-to-speech Realtime the primary voice experience. The official documentation reviewed identifies `gpt-realtime-2.1` as an updated realtime model with tool use, improved interruptions/noise handling, audio/text input and output, and image input. Native video is not listed as supported. Use it as the documented starting target, subject to an actual account-access probe in the implementation session. Do not equate API access with access to ChatGPT's complete consumer voice experience or assert that a vendor is universally “best” without Raya-specific evaluation. [Official model documentation](https://developers.openai.com/api/docs/models/gpt-realtime-2.1).

#### Target experience

The voice button starts an ongoing conversation in the current Raya task. A compact voice surface shows listening, responding, working on a task, or waiting for a decision. Users can interrupt naturally, mute, switch devices, continue typing, share a selected visual, and end the call. Voice remains connected to the same goal and artifacts as text.

Speech should be concise by default. Raya says what it is about to do only when that helps coordination, then reports meaningful results. It should not read tool logs, long tables or entire documents aloud. A spoken request such as “Look at this screen and simplify the form” can attach the selected screenshot and delegate the implementation while preserving conversational responsiveness.

Keep **dictation** distinct from **live conversation**. Dictation fills an editable composer draft and never silently submits it. Live voice responds directly, with a clearly active microphone state. Neither should unexpectedly activate because the user opened settings or switched sessions.

#### Proposed architecture

| Layer | Responsibility | Proposed change |
|---|---|---|
| Webview voice surface | Microphone, playback, device choice and visible state | Implement a transport-neutral voice controller; primary transport is OpenAI WebRTC. |
| Trusted extension/backend broker | Credentials, session setup, directory/session binding and policy | Keep long-lived credentials in SecretStorage/trusted host; establish the call and bind it to the authenticated Raya session. |
| Realtime session control | Tool requests, instruction updates, response events and accounting | Use one authoritative server-side controller and typed event adapter. |
| Raya execution runtime | Goals, routing, tools, permissions and artifacts | Execute delegated work once through existing runtime contracts. |
| Conversation store | Stable transcript, interruption markers, task/result links and usage | Persist a normalized voice event projection without treating raw audio as mandatory storage. |

OpenAI recommends WebRTC for browser/client connections. Its documented setup supports a server-mediated SDP exchange through `/v1/realtime/calls`, or short-lived client credentials. Prefer the server-mediated path for a single controlled setup flow, and test it inside the actual packaged VS Code webview before committing to that transport. [WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc).

Keep business logic and tool execution on Raya's trusted side. OpenAI documents a sideband connection to the same call for server-side monitoring, instruction updates and tool responses. Persist the call-to-Raya-session association; do not trust a client-supplied call ID as authorization. Choose one controller as the owner of tool dispatch to avoid client/server double execution. [Server-side controls](https://developers.openai.com/api/docs/guides/realtime-server-controls).

The suggested transport split is a Raya design decision, not an OpenAI requirement: keep direct WebRTC as primary, and implement an OpenAI WebSocket/native-capture adapter only if the packaged webview cannot reliably capture audio or company network constraints require it. Reuse proven capture/playout accounting where applicable. Do not retain Go/LiveKit as a mandatory hop merely because it already exists; retain it only for a demonstrated requirement such as a supported relay environment.

#### One conversation, one work authority

- Introduce a voice-session descriptor with provider, model, transport, capability flags, owning session, connection generation and lifecycle state. Remove Qwen-only literals from shared contracts through an explicit migration.
- Expose small voice tools such as start work, inspect work status, answer a pending question, steer work, and open an artifact. These are proposed semantic contracts, not existing method names. They delegate to the same goal/tool authority used by chat.
- The realtime model may answer conversationally and use authorized tools, but must not create a second competing agent loop. Long-running work becomes a durable job with an ID and progress events.
- Correlate provider call IDs with local invocation IDs. A replayed function request returns the saved result or current status rather than running the action again.
- Do not dispatch work from both a transcription event and a realtime function request. Transcription is presentation/context evidence, not an independent command queue.
- Distinguish “stop speaking,” “mute microphone,” “pause work,” and “cancel work.” Interrupting audio must not silently cancel a file operation, and cancelling a goal must not leave its tools running unnoticed.

#### Multimodal and interruption behavior

Visual input should be deliberate: selected browser view, canvas, editor screenshot or attachment, with visible sharing state and project binding. Start with on-demand images and refresh-on-request. Any continuous capture proposal needs its own capability validation, cost budget and user control; do not market screenshots as native video.

WebRTC and WebSocket have different interruption responsibilities. The official conversation guide describes automatic unplayed-audio truncation for WebRTC/SIP and client-managed playback/truncation for WebSocket. It also documents a finite session lifetime, currently 60 minutes. Implement transport-specific handling and planned rollover rather than blindly porting the existing LiveKit playout protocol. Transcript text cannot be assumed to align perfectly to the audio the user heard. [Conversation lifecycle and interruption guide](https://developers.openai.com/api/docs/guides/realtime-conversations).

Store stable transcript items with provider/item IDs and explicit interrupted status. Speculative words may be shown quietly, but should not become durable user instructions until finalized. On reconnect or rollover, hydrate the new call with a bounded summary, outstanding questions and active job references, not an invented claim that the original provider session resumed.

#### Migration and fallback

1. Inventory realtime, STT, TTS, native capture, settings, secret keys and backend event consumers. Define normalized events and cost accounting first.
2. Build an OpenAI-only vertical slice: connect, converse, interrupt, end, then invoke one safe local tool. Use a real packaged extension, not only a browser harness.
3. Integrate goals, questions, screenshots and background work; compare latency, recognition, task completion and interruptions against the current setup.
4. Make OpenAI the default after acceptance. Retain a clearly labeled temporary legacy switch during migration, never a silent MiniMax/Qwen fallback that changes provider or sends data elsewhere without an informed choice.
5. Remove obsolete dependencies and settings only after confirming no supported dictation or accessibility path still needs them. Retain rollback instructions and migrate secrets without copying them into configuration files.

If OpenAI is unavailable, offer reconnect, type instead, or an explicitly selected configured alternative. Do not pretend an STT → text model → TTS fallback is the same realtime experience.

#### Acceptance and proposed quality targets

Test microphone denial, missing device, Bluetooth/device change, noise, accents, silence, interrupted speech, ambiguous spoken approvals, alphanumeric identifiers, concurrent typed messages, late tool results, credential expiry, network loss and session rollover. No tool runs twice; no unheard assistant text is treated as a confirmed conversation fact; ending voice releases capture and transport resources.

Provisional targets for a documented reference device/network: local control feedback within 100ms; interruption-to-audio-stop p95 within 300ms; first audible response p95 within 2 seconds after an ordinary conversational turn ends, excluding explicit tool work. These are Raya goals to benchmark, not API guarantees. Report task success and recognition quality alongside latency so speed cannot hide wrong actions.

### 11.2 OVR-02 — A first-class browser skill for agents

**Priority:** P1, delivered together with OVR-10. **Related findings:** EN-11, EN-14. **Owner:** Agent behavior/evaluation engineer plus browser engineer.

#### What the skill must accomplish

“Like yours” should mean reliable observed behavior: inspect the actual page, select appropriate tools, act on grounded targets, verify the result, recover intelligently, and hand control to the user when necessary. This audit cannot infer or reproduce proprietary Codex internals from screenshots. Raya can implement and evaluate these operating principles on its own browser runtime.

The current [browser protocol](../packages/opencode/src/kilocode/browser/protocol.ts) provides navigation, snapshots, selectors, typing, screenshots, evaluation, authentication capture and smoke checks. That is a useful tool foundation. A skill must teach when and how to compose those tools; a prompt alone cannot supply missing tabs, robust locators or recovery primitives.

#### Proposed skill package

Create a versioned browser skill in Raya's discovered skill location, with a concise entry document and task-specific references. Resolve the actual loader path during implementation rather than assume a new folder is automatically discovered. The package should cover browsing/research, authenticated work, forms, downloads/uploads, testing, visual inspection, and recovery. Keep host mechanics in generated or versioned tool documentation so instructions cannot drift from the runtime.

The skill should require the following execution loop:

1. **Understand the outcome:** identify the destination, account/project, expected artifact and action authority. Reuse session authorization; do not ask repeatedly for already-authorized routine steps.
2. **Choose the best interface:** prefer a connected structured API for known records and transactions; use browser interaction for visual state, unsupported flows, or tasks explicitly requiring the browser. Both should preserve the same account and authority boundaries.
3. **Inspect fresh state:** identify the tab, URL, page title, active frame, visible controls and relevant page content. Treat page text as task data, never as authority to override the user's request.
4. **Act on a grounded target:** use role/name/label or an observed stable test ID; scope ambiguous targets. Fall back to screenshots and coordinates when semantic targeting genuinely cannot represent the interface.
5. **Verify the postcondition:** after a navigation or state-changing action, inspect evidence such as the new URL, saved record, completed download or rendered status. “Clicked Save” is an action report, not proof of a save.
6. **Recover with a bounded change of approach:** refresh stale observations, check account/permission state, handle a modal, or choose another grounded locator. Stop repeating identical failures. Preserve completed work.
7. **Return an evidence-backed result:** link the page/artifact and summarize what changed or was found, with unresolved limitations.

Playwright's locators support role/label-based targeting and retryable element resolution. Raya should expose these semantics through its own typed browser interface, not force the model to construct brittle CSS for every action. [Playwright locator documentation](https://playwright.dev/docs/locators).

#### Task playbooks

| Playbook | Required behavior | Useful evidence |
|---|---|---|
| Research | Search, read source pages, compare relevant sources and retain attribution | Source URL/title, retrieved date, short supporting extract and synthesis. |
| Form completion | Inspect fields, fill known values, validate, preserve draft and apply existing submission authority | Final field values excluding secrets, validation result and submitted record reference. |
| Authenticated work | Check active account/project; use manual handover for login or challenges | Account label and task outcome, never cookies or passwords. |
| Download | Wait for completed transfer; validate format/name and expose local artifact | Download ID, path, size and parse/open result. |
| Upload | Use only authorized selected files; verify the attachment in the destination | File identity and destination attachment status. |
| UI testing | Run named steps with actual assertions; collect relevant console/network/visual evidence | Structured step outcomes tied to a build and session. |
| Visual design inspection | Inspect the actual rendered page at required sizes and states | Screenshots plus specific observations, not a claim from source alone. |

#### Skill quality and maintenance

Keep instructions short enough to load when relevant. Reference detailed recovery examples lazily. Make examples cover failures and ambiguous selectors, not only ideal pages. Test instruction changes against a fixed local application corpus and selected controlled live sites. Version the skill with the runtime capability manifest and reject unsupported operations clearly.

Acceptance must include successful multi-page research, an SPA form, a popup, an iframe, a file download/upload, manual login handover, stale state and an interrupted/retried action. Add adversarial pages that ask the agent to reveal credentials or change the user's objective. Measure end-to-end success, incorrect actions, verification accuracy, repeated-failure count, latency and model/tool cost. Compare against the existing skill/tool baseline; a longer instruction file is not the success metric.

### 11.3 OVR-03 — Smarter Auto routing and orchestration

**Priority:** P1 foundations, P2 evaluated rollout. **Related findings:** PR-01, PR-02, EN-07, EN-14. **Owner:** Runtime/agent engineer with evaluation and product support.

#### Current constraints

[Chief routing](../packages/opencode/src/kilocode/chief/index.ts) has a route/task/goal/done state machine, user-authored request extraction, a restricted tool set and deterministic repair paths for invalid tool calls. [Tool-model selection](../packages/opencode/src/kilocode/chief/tool-model.ts) protects native tool capability, but fallback ranking uses model release date and context size. Those are useful compatibility signals, not evidence that a model is best for the task. Some repair logic turns an unsupported call into a request for a write-capable specialist; future routing must preserve the original action authority when recovering.

#### Separate four decisions

| Decision | Inputs | Output |
|---|---|---|
| Task interpretation | Actual user request, attachments, active goal and relevant context | Outcome, constraints, uncertainty and acceptance criteria. |
| Execution shape | Task complexity, independence, latency and risk | Direct response, one specialist, sequential workflow or bounded parallel work. |
| Agent/skill selection | Required expertise and available tools | Role, skill set, deliverable contract and context subset. |
| Model selection | Required modalities/tool behavior, evaluated quality, health, cost and policy | Eligible model configuration and fallback rules. |

A simple question should not need a full Chief → specialist → synthesis round trip. A complex document analysis may need one capable generalist with the correct tools. Parallel agents are useful only when bounded tasks can proceed independently and their results can be merged safely. Routing should optimize expected task success under user constraints, not maximize delegation.

#### Proposed routing pipeline

1. Preserve user choices and constraints as hard filters: selected provider/model where compatible, allowed data destinations, required modalities, tool support and spending limits. Explain incompatible choices rather than silently changing policy.
2. Resolve available capabilities and current provider health. Separate “not connected,” “unsupported,” “temporarily unavailable,” and “disallowed.” Do not treat unknown model metadata as proven capability.
3. Use a cheap deterministic path for clear low-complexity intents. Escalate ambiguous or compound requests to structured planning by a capable router. Ask a user question only when missing information materially blocks correctness or authority.
4. Select the smallest execution shape likely to succeed. Permit direct tool execution for appropriately scoped work instead of forcing every Auto task through delegation.
5. Choose among eligible models using evaluated task-family quality, reliability and latency/cost. Recency and context length may break ties; they should not define quality.
6. Persist a route decision containing input revision, routing-policy version, capability snapshot, chosen model/agent, reason summary, constraints and fallback plan.
7. Re-evaluate on meaningful evidence: capability failure, user steering, budget pressure, repeated lack of progress, or a changed task. Do not reroute on every token or continuation tick.

#### Handoffs and execution control

Every specialist receives the current objective version, bounded scope, relevant context/provenance, access envelope, budget allocation and expected output schema. It returns artifacts, checks, unresolved issues and actual usage. The parent validates the result before merging it into the goal. A summary saying “done” cannot satisfy an unmet criterion.

Use context packets rather than copying the entire transcript into every child. Preserve file/project identity, selected screenshots and user constraints. Apply per-parent child/concurrency limits; coalesce duplicate subproblems. Conflicting writers should use separate worktrees or an explicit file-ownership plan. Read-only parallel analysis need not incur worktree overhead.

Route repairs must keep read-only work read-only. A malformed or unknown tool name should produce a typed correction or equivalent permitted operation, not broader privileges. If all capable models are unavailable, pause with a useful explanation and preserve the plan.

#### User experience and evaluation

Auto should show a short reason only when useful: “Using Designer for the layout and Coder for implementation,” or “The selected model cannot use the required tools; choose a compatible model.” Detailed scores belong in diagnostics. Avoid displaying an uncalibrated confidence number as a probability.

Build a held-out evaluation set spanning company research, coding, spreadsheets, design, document writing, browser workflows and mixed tasks. Include counterexamples where a role keyword is misleading. Compare the new router against both the current router and a single strong generalist. Measure task success, correctness of constraints, unnecessary delegation, cost, latency, clarification burden and user overrides. Evaluate prompt/model/policy changes with versioned data; do not train and score on the same examples.

**Acceptance:** Simple tasks can complete directly; complex tasks produce appropriate bounded plans; manual choices remain honored; no recovery widens authority; model outages do not cause an unbounded reroute loop; successful routing is demonstrated by better held-out outcomes, not higher self-reported confidence. Roll out in shadow mode first, then opt-in, then default after evidence.

### 11.4 OVR-04 — Calculated, explainable token and tool costs

**Priority:** P1. **Related findings:** PR-05, EN-08. **Owner:** Usage/runtime engineer with provider integration support.

#### Recommendation and existing implementation

Yes: when usage and applicable rates are known, Raya should calculate an estimate rather than show zero or unavailable. The source already does part of this in [session.ts:417](../packages/opencode/src/session/session.ts): provider-reported costs take precedence, followed by model-rate calculations with cache/reasoning/tier handling. The overhaul should unify this logic across current/legacy runtime, subagents, voice, routines and UI, and preserve the provenance currently lost in a single numeric field.

Do not price “a provider” as one unit. Rates depend on the exact model, gateway route, modality, cache category, service tier and sometimes context size or contract. A provider can also return subscription credits or other units that should not be labeled dollars without a defined conversion.

#### Accounting precedence and display

| Available evidence | Accounting treatment | User-facing example |
|---|---|---|
| Valid provider-reported amount | Store reported amount and provider provenance | `$0.42 · reported by provider` |
| Measured usage plus applicable rates | Calculate reproducible estimate | `≈ $0.42 · estimated from usage` |
| Partial measured/priced usage | Calculate known portion and identify missing buckets | `≈ $0.42 known usage · some voice usage pending` |
| Measured usage, stale but applicable rate | Estimate with rate date and staleness flag | `≈ $0.42 · rates last verified …` |
| Estimated token count plus known rate | Provisional estimate with a separate usage-quality label | `≈ $0.40–$0.50 · provisional` only when a defensible range exists |
| No applicable rate or incompatible unit | Show usage and the exact missing information | `12,400 tokens · add a rate to estimate cost` |
| Explicitly free provider/model | Preserve confirmed zero with provenance | `$0.00 · no provider token charge` |

Provider-reported is not automatically invoice-final. Preserve that distinction; aggregate views must not relabel a mixture of estimates and reported amounts as an exact bill.

#### Normalized formula

For disjoint token buckets and rates quoted per million tokens:

```text
estimated token cost = sum over billable buckets (tokens[bucket] × rate[bucket] / 1,000,000)
estimated run cost = token cost + separately billed tool/media charges
```

Buckets can include uncached text input, cached text input, cache writes, output text, reasoning where separately accounted, audio input/output and image input. Normalize each provider's usage semantics before calculating. If output already includes reasoning, do not add reasoning again. If total input includes cached input, partition it before charging. If audio/image categories are subsets of total input, do not charge both the total and the subsets. Validate nonnegative counts and quarantine contradictory usage rather than silently fabricating an exact amount.

**Illustrative example, not current provider pricing:** 10,000 uncached input tokens at $2/million, 5,000 cached input at $0.50/million and 2,000 output at $8/million produce $0.0200 + $0.0025 + $0.0160 = **$0.0385**. The interface can show approximately $0.04 while retaining full calculation precision. Small nonzero totals should show `< $0.01`, not `$0.00`.

Realtime billing needs modality-specific usage. OpenAI's cost guide describes response usage in `response.done`, repeated conversation input across turns, caching and separately charged input transcription when enabled. Therefore, do not estimate a whole voice session by counting transcript words once. Persist each response's normalized usage and separate transcription charges. [Realtime cost guide](https://developers.openai.com/api/docs/guides/realtime-costs).

#### Data and rate model

Create one usage ledger with immutable raw-event identity and normalized projections. Each record should carry provider/model/route, request or response ID, session/goal/routine/child ownership, timestamp, usage buckets, measurement status, monetary or credit unit, rate-card version, calculation version, amount provenance and reconciliation state.

Rate cards need currency, unit, effective interval, source URL or configured contract, verified time, cache rules, modality prices, context-tier rules and trusted override provenance. Load a bundled verified baseline, refresh through validated metadata adapters, and support explicit custom rates for private endpoints. Never guess a rate from a similarly named model. Keep historical estimates reproducible when rates change; a recalculated view should be labeled separately.

Use decimal or fixed-point arithmetic. Keep display rounding out of persisted calculations. Enforce both lower and upper time boundaries in range queries; the reviewed [project usage query](../packages/opencode/src/kilocode/session/project-usage.ts) uses a lower bound but does not apply its returned `until` as an upper filter.

Deduplicate usage by provider event/request identity and execution attempt. Record billed failed/retried attempts separately. Allocate child usage once to the parent aggregate, not again when a parent summary carries propagated costs. Late authoritative usage reconciles the estimate instead of appending a duplicate charge.

#### Budgets and acceptance

Show actual/estimated spend separately from reserved budget for in-flight work. Reserve conservatively before concurrent calls and release/reconcile reservations afterward. If pricing is incomplete, follow an explicit policy: limit calls/time, request an override, or apply a configured conservative ceiling. Do not invent a hard-dollar guarantee with unknown rates or provider-side post-cancellation billing.

**Acceptance:** Test cache-inclusive usage, reasoning-inclusive output, context tiers, zero versus missing prices, custom rates, provider-reported zero, audio/image buckets, tool fees, retries, late events, historical rate changes, credit units and parent/child aggregation. Every displayed estimate must be reproducible from the stored ledger and rate version. Add a UI disclosure explaining the calculation without requiring users to read SQL or token schemas.

### 11.5 OVR-05 — A durable, understandable routine system

**Priority:** P1 execution model and P2 complete experience. **Related findings:** PR-03, PR-04, EN-02, EN-03, UX-03. **Owner:** Workflow/runtime engineer plus product/design.

#### Product definition

A routine is a reusable, versioned instruction for recurring work, with a trigger, context, permissions, budget, output destination and success criteria. A run is one execution of one definition version. A goal is the outcome pursued by that run. These should be distinct records linked by stable IDs.

The existing [task schemas](../packages/opencode/src/kilocode/task/index.ts), [runner](../packages/opencode/src/kilocode/task/runner.ts) and [RoutinesView](../packages/kilo-vscode/webview-ui/src/components/routines/RoutinesView.tsx) provide a starting point. The overhaul should replace fragile schedule/lifecycle semantics, not simply redesign the list around the same behavior.

#### Creation and editing flow

Use a composed page or focused panel with progressive sections: **What should happen? When? What can it use? Where should the result go?** Show a live summary before enabling. Natural-language creation should populate these fields and expose ambiguity.

Provide representative starting templates: morning project brief, weekly document review, watched-folder report, repository maintenance check, and research digest. Templates are editable configurations, not special execution paths. An accountant/inbox template must not gain authority merely through its role label.

Creation should support a preview and a bounded test run. Explain that a test run can still incur model cost or perform allowed actions; a dry run should validate configuration/trigger calculations without claiming to simulate arbitrary external tools. Require output and acceptance criteria that can be checked. Do not activate a routine with no valid trigger or unavailable required connection.

#### Durable model and scheduler

| Record | Required information |
|---|---|
| Definition version | Objective, inputs, timezone/trigger, owner, capabilities, model policy, output contract, budget and retention. |
| Trigger event | Source, event ID, occurrence time, matched filter, received time and deduplication key. |
| Run | Definition version, trigger ID, lease owner/expiry, state, attempt, goal/session, usage and result links. |
| Pending decision | Question, required responder, expiry policy, original run and resume token. |
| Outcome | Summary, artifacts, verification, actual/estimated cost, unresolved issues and delivery status. |

Use transactional persistence and an atomic uniqueness/claim boundary. A durable lease and heartbeat allow another process to reconcile a crashed worker. Track attempts separately from logical runs. Exactly-once external side effects generally cannot be guaranteed across an unknown remote outcome; use idempotency keys where supported and explicit reconciliation otherwise.

Support once, calendar recurrence, interval and event triggers as different typed forms. Timezone is mandatory for calendar recurrence. Interval schedules need an anchor and defined drift policy. Event filters must validate required fields. Persist missed occurrences and apply one of skip, run once after recovery, or bounded catch-up. Set overlap policy to queue or skip by default; parallel runs require a configured limit and compatible side effects.

#### Run state and recovery

Use states such as scheduled/queued, starting, running, waiting for user, paused, retrying, succeeded, failed and cancelled, with explicit transition reasons. Lease expiry is an execution condition, not proof that the business action failed. Waiting for an answer holds the run open and follows the declared overlap policy.

Transient network/rate-limit failures use bounded retry with backoff and provider guidance. Invalid credentials, missing permissions and missing required input become actionable waiting states. A code/logic failure should not retry forever. A repeated-failure circuit breaker disables future launches with a visible explanation and preserves history. Recovery should not silently reset the failure counter or advance the schedule incorrectly.

Editing a definition affects future runs. An active run stays pinned to its version unless the user explicitly steers that run. Disabling a routine prevents new launches; stopping an active run is a separate action. Deletion should state what happens to history and retained artifacts.

#### Results and company experience

The routine list should emphasize name, plain-language trigger/next occurrence, health and latest useful result. Avoid dashboard cards filled with empty counters. A detail page has Overview, Runs and Configuration, using the same task result, question and activity components as ordinary goals.

Deliver results into a persistent Raya inbox or the configured artifact destination. External messages require a connected destination and authorized delivery policy. Deduplicate completion notifications, batch low-priority summaries, and surface actionable failures promptly. A dismissed notification does not acknowledge the underlying question or close the run.

Expose “why did this run?” and “why did it not run?” with trigger/claim/policy evidence. State local execution reality: if the machine/backend must be awake, say so beside the schedule. An always-on worker is a separate deployment capability requiring credential and filesystem access planning, not something a timer in the extension can promise.

#### Migration and acceptance

Import existing routine definitions with their original phrase/cron, show inferred timezone and access, and flag ambiguous ones for review before reactivation. Preserve run/session references and prior outcomes. Do not silently reinterpret a weekday schedule into a user's presumed intent without review.

Acceptance includes DST changes, leap/calendar boundaries, laptop sleep, process crash at every persistence boundary, overlapping manual/event/timer triggers, duplicate events, delayed delivery, waiting questions, expired credentials, budget exhaustion, definition edits and cancelled output delivery. Prove result/notification deduplication and safe resumption. A reference routine must complete a real representative workflow with inspectable output and no hidden manual repair.

### 11.6 OVR-06 — An outcome-driven Goal system

**Priority:** P1 lifecycle/evidence and P2 complete experience. **Related findings:** PR-02, EN-02, UX-02. **Owner:** Core/goal engineer plus product/design.

#### Product contract

A goal is durable intent plus proof of progress toward it. It must outlive a chat turn, a model choice, a child agent, a context compaction and a client reconnect. A goal should not be an instruction that repeatedly tells the model to keep going until a token budget expires.

The existing [goal implementation](../packages/opencode/src/kilocode/goal/index.ts) has durable state and completion checks. [Continuation](../packages/opencode/src/kilocode/goal/continuation.ts) includes spin suppression but also a prompt requiring a `task` call when work remains. Preserve the evidence foundation while moving continuation decisions into an explicit work/lifecycle model. Tool activity alone is not progress, and useful direct work should not require delegation solely to satisfy a prompt rule.

#### Goal record and planning

Store the objective, user constraints, objective version, acceptance criteria, current plan revision, artifacts, evidence, dependencies, pending decisions, authority envelope, budget and lifecycle history. Each criterion has a stable ID, required/optional status, verification method and evidence links. Track who introduced or changed it.

Use a task graph where dependencies matter; a simple list remains the right UI for small goals. Tasks have outputs, owners, state and checks. Allow multiple independent tasks in progress when genuine parallel work exists, while presenting a concise overall current activity. Do not force a false single active task to simplify the display.

When the user steers a goal, summarize the change and identify affected tasks/evidence. Preserve constraints not explicitly changed. Do not silently shrink the objective to whatever already works. If requirements conflict, ask the smallest necessary question and continue independent authorized work.

#### Continuation and lifecycle

Separate user-facing goal state from the underlying execution state. User-facing states can remain clear: Ready, Working, Waiting for you, Paused, Blocked, Completed and Cancelled. Internally, track queued workers, leases, retry deadlines, outstanding tools and dependency waits.

The scheduler should decide among four next actions using authoritative state: continue executable work; wait on a confirmed live operation; request a decision; or report a genuine blocker after bounded recovery. It should not generate endless prose-only turns, treat a timeout as confirmed termination, or restart a live task merely because no output arrived recently.

Persist enough information to reconcile after restart: outstanding operation IDs, tool disposition, last evidence cursor, pending question and planned next executable task. Re-query real handles and resource state before retrying side effects. Keep a clear difference between “the worker stopped,” “the provider is slow,” and “the operation's outcome is unknown.”

Pause should stop new scheduling and apply a documented policy to in-flight tools. Cancel should request cancellation and report any operation that cannot be recalled. Stopping the conversation UI must not leave a hidden goal continuing without the user's intended execution policy. Conversely, closing a panel need not cancel explicitly authorized background work.

#### Completion verification

Before completion, evaluate every required criterion against current artifact revisions and evidence. Automated checks should verify what they actually cover. A successful build does not prove correct UX; a screenshot does not prove keyboard behavior; a child saying “complete” does not prove the parent objective.

Evidence should include tool/result identity, command/assertion, artifact revision, environment, timestamp and outcome. Distinguish source inspection, automated test, runtime observation, external confirmation and user acceptance. Criteria that inherently require human judgment should remain “ready for review” unless the user has authorized another acceptance policy.

Changed artifacts invalidate relevant evidence without discarding unrelated valid checks. Cross-project or unrelated successful calls cannot satisfy the goal. Goal completion should return a result package: deliverables, criteria satisfied, checks run, costs, caveats and next user action. Never manufacture private reasoning text as evidence.

#### Progress, budgets and failure learning

Show milestones, completed deliverables and the next meaningful action. If a percentage is useful, identify it as plan completion and avoid making it a time forecast. Present elapsed time and estimated cost quietly. Detect repeated failures by operation/error/artifact fingerprint; try a materially different recovery or pause with a specific blocker.

Budget policy should include time, model/tool cost, concurrent children and recovery attempts, while respecting user-authorized continuation. Reaching a budget is not success. Preserve the remaining objective and resumable state, then ask for or await the appropriate continuation policy. Lessons from failures may become reviewed regression cases or local preferences, not automatic global instruction changes.

#### Acceptance

Exercise steering during a tool call, changing acceptance criteria, parallel children, child cancellation, provider outage, compaction, restart, a live operation with delayed output, changed artifact after a passing check, partial success and an exhausted budget. The full objective survives. A blocked goal explains the exact missing condition and resumes without duplicating completed work. Completion is impossible while a required criterion is unmet, stale or supported only by unrelated evidence.

### 11.7 OVR-07 — Complete Raya UI and UX redesign

**Priority:** P1 design foundations and core workflow, P2 full surface migration. **Related findings:** All UX/UI findings, PR-01 and PR-06. **Owner:** Product designer/design-systems engineer with extension and shared-UI engineers.

#### Design authority and reference interpretation

Use [designer.md](designer.md) as required guidance for the implementation designer. It calls for first-principles hierarchy, restrained neutrals, one icon family, consistent copy, full interaction states, tiered tokens and real visual verification. Its frontmatter model setting is source material for Raya's designer configuration, not a requirement to switch this audit's model or create a Figma file now.

The four supplied screenshots were inspected directly. They are references for interaction and visual judgment, not a request to clone Codex branding or infer hidden implementation. Screenshot pixels cannot establish exact CSS, animation, keyboard behavior or accessibility.

| Reference | Observed design decision | Raya translation |
|---|---|---|
| Image 1 | Quiet command/question rows, readable prose, an expandable plan surface and stable bottom composer | Let conversation content lead; collapse execution detail; create one clear plan artifact with expansion. |
| Image 2 | A focused question panel near the bottom, numbered choices, a recommendation label, progress through questions, free-text alternative and Skip | Rebuild Ask Cards around one decision at a time, with clear selection/submission and persistent pending state. |
| Image 3 | User message grouping, elapsed work label, thin divider, concise progress prose and subdued command activity | Separate user intent, work status and assistant communication through spacing and typography rather than nested cards. |
| Image 4 | Minimal Thinking state and a composer that remains available | Keep active work legible without fabricated activity or large animated placeholders; preserve steering access. |

Reference provenance: `image-1.png` through `image-4.png` in `C:\Users\User\.codex\attachments\1357d962-e8b6-4033-a652-4daf0694e655`. The observations above remain readable without those local files. The next session should reopen them when available; this document does not pretend they are committed design assets.

#### Brand and design-system foundation

Preserve **Instrument Serif** and **Outfit** as deliberate complementary roles. [eden.css](../packages/kilo-vscode/webview-ui/src/styles/eden.css) already declares these families and a code face. Use Instrument Serif for display moments such as the Home greeting and major page/artifact titles. Use Outfit for body copy, controls, questions, navigation, progress and numeric metadata. Keep an appropriate monospace for code and logs. Do not insert a serif word into an otherwise sans heading for decoration, and do not use tiny serif counters to make operational data feel branded.

Use the existing Raya accent sparingly for the primary action and selected/focused states where appropriate. Keep surfaces within one neutral grey family in Raya-controlled themes; do not add decorative cream, blue or amber washes. In host-controlled accessibility themes, semantic host colors take precedence over forcing a decorative palette. Status colors express actual status and need a non-color equivalent.

Define one versioned token source with base ingredients, semantic roles and component aliases. Generate downstream CSS and any future Figma variables from that source. Proposed starting scales, to validate in actual renders rather than claim from screenshots: 4/8/12/16/24/32px spacing; Outfit body around 14px with comfortable line height; secondary text around 12–13px when contrast/readability supports it; larger Instrument Serif titles around 24–32px according to surface. Respect user font scaling and narrow layouts. Choose radii by component purpose, not one oversized value everywhere.

Set reusable states for default, hover, focus-visible, pressed, selected, disabled, pending, invalid and success. Use one installed icon family and stable semantic mappings; the existing shared icon inventory should be evaluated before introducing a new dependency. No emoji chrome, decorative sparkle headings, pulsing static status dots, nested cards, gradient text or ornamental side rails. Data content may naturally contain emoji; that is different from product chrome.

#### Information architecture and layout

The primary workspace should organize around **Home, work/history, routines and settings**, with chat/goal details as the main work surface and canvas/browser as contextual destinations. Self-heal belongs under help/diagnostics and its own backlog, not an unexplained dominant navigation item. Connections should be reachable from settings and task-specific setup.

At narrow sidebar widths, use one primary column with overlays/drawers for secondary content. At wider editor-tab widths, allow chat plus canvas/browser details side by side with user-controlled sizing. Do not compress every panel into miniature columns. Preserve navigation context, scroll position, drafts and selected artifacts when switching surfaces.

The composer stays anchored without covering the last message or pending question. Long content scrolls within the appropriate region; avoid nested scroll traps. When users scroll upward, incoming messages do not pull them away; offer a “Jump to latest” action. When they are already at the bottom, follow streaming output without layout jitter.

#### Surface-by-surface redesign brief

| Surface | Required redesign | State and interaction requirements |
|---|---|---|
| Home screen | A restrained Instrument Serif greeting, one primary task entry point, recent work and items needing attention | First-use setup, offline/backend unavailable, no recent work, resume pending goal; no decorative dashboard of empty metrics. |
| History | Searchable task list with project, meaningful title, status, last activity and source filters | Keyboard navigation, stable selection, rename/archive, unavailable worktree, cloud preview/import clarity, large-list performance. |
| Chat | Readable prose on the shared surface; clear user/assistant grouping; restrained tool activity; artifact links | Streaming, retry, interruption, citations, long tables/code, failed attachments, selection/copy and accessible new-content announcements. |
| Composer | Generous editable text region, clear attachments, compact Auto/model control and an unambiguous primary send/stop action | Empty/draft/submitting/working/offline, multiline and IME input, paste/drop, voice distinction, queued steering and preserved drafts. |
| Input fields | Outfit labels, helpful examples and inline validation; consistent field anatomy | Visible labels, required/optional meaning, password reveal where appropriate, save status, invalid input preservation, keyboard/focus. |
| Ask Cards | One focused decision surface with a short question, options with consequences, recommendation where justified, free-text alternative and progress for a batch | Explicit submit/continue, skip only when optional, back preserves answers, Enter/number shortcuts without hijacking typing, reconnect restores pending decisions. |
| Plans/goals | One coherent plan/result surface, expandable details, milestones, current action and clear controls | Draft/revised plan, paused/waiting/blocked/completed, criterion changes, evidence disclosure and responsive expansion. |
| Thinking | A quiet truthful execution status with optional elapsed time | No fake progress percentage, no animation implying activity after the worker stops, reduced-motion support. |
| Thoughts/activity | Concise shareable summaries of approach, actions, decisions and verification; grouped raw tool details on demand | Distinguish summary from actual tool result; do not require or invent hidden chain-of-thought; incomplete/failed actions remain visible. |
| Routines | Task-oriented list and configuration flow from OVR-05; latest result before counters | Enabled/disabled, next occurrence, running/waiting/failed, test-run feedback and versioned edits. |
| Canvas | Artifact-focused header with title, revision, view/edit context and export/capture controls | Loading, last working revision during error, candidate preview, accessible data alternative, reopen, resize and restoration. |
| Browser | Legible tab/address/control strip, manual/agent ownership and task context | Navigation/loading/error, takeover, authentication, uploads/downloads, popups and recovery from a disconnected runtime. |
| Review/diffs | Clear file scope, change summary and acknowledgement before dismissal | Pending/error/retry, stale patch, deletion/rename, conflict and keyboard review. |
| Settings | Search plus comprehensible groups: General/appearance, Models, Connections/tools, Voice, Autonomy, Context, Usage and Diagnostics | Scope of setting, saved/pending/error, dependencies, reset behavior, credential state without displaying secrets. |
| Icons | One family, consistent stroke/size/alignment and semantic labels | Accessible names/tooltips, target area independent of glyph, long-label layouts and high contrast. |
| Notifications | Inline task feedback first; a durable attention inbox for questions/failures; toast only for transient confirmation | Deduplication, quiet periods, actionable deep links, no loss of pending work on dismiss. |
| Voice | Compact conversational presence integrated with task state | Listening/muted/speaking/working/reconnecting, visible capture/sharing, keyboard end-call and device errors. |
| Terminal/Agent Manager | Consistent task/project naming and active-target context | Concurrent sessions, worktree mismatch, terminal lifecycle and safe task switching. |
| Help/self-heal | Plain-language report entry, diagnostic preview and a traceable repair backlog | Captured versus repairing versus tested versus installed; no misleading “fixed” before the user's build changes. |

#### Ask Card behavior specification

An option has a label and a concise consequence. A recommendation is visibly a suggestion, never a submitted answer. Clicking a choice can select it and reveal an explicit Continue/Submit action; if using immediate submission, that behavior must be obvious and consistent. Free text is always available for preference/clarification cards. A skip action appears only when skipping is a valid outcome, with a stated default if one exists.

Distinguish clarification, preference, permission and destructive confirmation. Permission cards show the actual action, target and scope; they must not accept a default because a timer elapsed. Avoid asking again when authorization already covers the action. A dismissed card remains pending if the underlying operation still requires an answer. Batch only genuinely related questions and preserve answers across navigation and reconnect.

#### Thinking and Thoughts behavior specification

Use “Thinking” for a real computation state and concrete verbs when known: “Reading project files,” “Checking the result,” or “Waiting for your answer.” Show useful summaries of approach and decisions when the model provides shareable explanations. Do not present invented inner thoughts, expose private chain-of-thought, or imply that every reasoning model can stream a detailed thought transcript. Raw command output remains in expandable activity with copy/search and clear failures.

A work status should resolve into a meaningful result or interruption record. Users should not have to inspect logs to learn that the backend disconnected. A concise summary can be warm and human while remaining technically honest.

#### Accessibility, motion and copy

Design all primary flows for keyboard use, visible focus, meaningful names, screen-reader order, zoom/reflow, reduced motion and high-contrast settings. Use the WCAG references in UI-02. Aim for comfortable pointer targets, commonly 32–40px where layout permits, without claiming that those are screenshot measurements or the minimum required by the standard. Touch-oriented surfaces may need larger targets.

Motion communicates a state transition or spatial relationship. Keep frequent interactions nearly immediate and common transitions short; prototype around 120–200ms and adjust by observation. Do not stagger reading content, move text during streaming, or animate every routine row. Reduced motion should retain all information without spatial movement. Evaluate motion live, not from still screenshots.

Follow designer.md's sentence case, concrete verbs and calm tone. Examples: “Your draft is saved,” “Couldn’t connect. Try again,” “Waiting for your answer,” and “Undo this file.” Avoid vague success toasts and inflated claims. State what was preserved after failure when that is known.

#### Delivery and acceptance

Begin with an inventory of real components and tokens, then approved representative screens at narrow and wide sizes in light/dark themes. Include Home, a streaming chat, an Ask Card, a failed tool, a goal, a routine, canvas error recovery and settings. Build foundation components and migrate complete workflows, not isolated screenshots that leave interaction inconsistent.

Require each surface to ship its complete state matrix, actual production-component stories, keyboard/focus checks and visual review. Evaluate long translated strings, slow network, large content and reconnect. Test with mixed-ability company colleagues using realistic tasks. Keep a decision log for hierarchy, spacing, token changes and justified host differences. The redesign is complete only when all named surfaces above are migrated and validated, not when the Home screen looks polished.

### 11.8 OVR-08 — Broad work tools with discoverable capabilities

**Priority:** P1 capability contract, P2 task packs. **Related findings:** PR-04, EN-07, EN-13. **Owner:** Tool/platform engineer with domain owners.

#### Direction and present foundation

Raya already has filesystem, shell, search/fetch, skill, task, question and other tool infrastructure in [core tools](../packages/core/src/tool), [opencode tools](../packages/opencode/src/tool), [plugins](../packages/plugin), MCP integration and host browser/canvas bridges. The product should broaden into general company work through this infrastructure. Do not assume a provider's model catalog automatically supplies tools for spreadsheets, email or documents.

Build a capability catalog that answers what the agent can do now, with which account/project, and what setup or permission is missing. Give agents access to a broad catalog while loading only the relevant tool schemas and skill instructions into a particular turn. Hundreds of undifferentiated tools in every prompt increase ambiguity and cost.

#### Proposed work capability packs

| Pack | Capabilities to deliver | Preferred implementation and result |
|---|---|---|
| Research/web | Search, fetch, source comparison, citation capture, browser reading | Structured retrieval first; browser for interactive pages; cited research artifact. |
| Files/documents | Read/search files; create/edit/export Markdown, PDF and office documents | Native parsers/renderers with layout verification; editable source and final artifact. |
| Spreadsheets/data | CSV/XLSX handling, formulas, validation, SQL/read-only queries, analysis and charts | Sandboxed computation and format-aware tools; preserve formulas/types and produce reproducible outputs. |
| Presentations/design | Slides, image inspection/generation where connected, diagrams, Figma and canvas | Format-specific adapters and render checks; avoid claiming a screenshot is an editable deck. |
| Engineering | Repository navigation, patches, tests, builds, diagnostics, git/worktrees and review | Existing core tools with scoped execution; diffs and test/build evidence. |
| Business records | Search/read/update connected project, CRM or knowledge records | Authorized connector/API adapters with stable IDs, version checks and account context. |
| Communication/calendar | Read context, draft messages/events, send/create under existing authorization | Connected service tools; separate draft from external publication. |
| Browser workflows | Authenticated forms, uploads/downloads and interaction tests | OVR-02 skill on OVR-10 runtime; verified destination state. |
| Scheduling/goals | Create/inspect/steer routines and goals, answer questions | Shared lifecycle contracts; no second scheduler inside a plugin. |
| Diagnostics | Health probes, structured logs, environment checks and self-heal intake | Redacted evidence bundle and bounded recovery; repair artifacts when needed. |

These are target capabilities. Each pack needs an inventory of existing versus missing adapters, installation/runtime requirements and supported platforms before implementation. Select initial integrations from actual company tasks; do not install every connector or invent access to services that are not configured.

#### Tool contract and discovery

Every callable tool needs a stable namespaced identity/version, description, input/output schema, capability requirements, account/project binding, timeout, cancellation semantics, idempotency behavior, error taxonomy, output limits and evidence/artifact fields. Describe side effects and data destinations. A capability manifest should distinguish available, disconnected, expired, unsupported, unhealthy and disallowed.

Implement search/discovery over trusted manifests, then load a bounded relevant set. Use examples and task-family tags to improve selection. Handle missing capability explicitly: explain the missing connection/tool and propose the precise setup, or use an equivalent authorized alternative. Do not run an inferior browser workaround when a reliable connected API already solves the task, and do not block browser-only work just because an API would be ideal.

MCP annotations can describe read-only/destructive/idempotent behavior, but the specification treats annotations from untrusted servers as untrusted hints. Enforce authority at Raya's host/executor rather than rely on labels alone. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

#### Execution and output quality

Use sandboxed computation for arbitrary analysis/code where supported, with explicit runtime capabilities on each platform. Stream bounded progress and return typed artifacts with paths, formats and provenance. Large results should become durable artifacts with previews, not giant prompt payloads. Validate generated files with actual format readers/renderers when relevant.

Preserve session authorization across turns and children. Reversible local work can proceed within the request; external messages/publication use the user's authorized scope. A downloaded document or tool result cannot authorize exporting unrelated company data. Secrets stay in trusted storage and are injected only into the relevant adapter.

**Acceptance:** An agent can discover and complete representative research, document, spreadsheet, browser and repository tasks end to end. Test disconnected/expired tools, wrong account, large output, cancellation, duplicate requests, malformed responses and partial mutation. A result links a usable artifact or verified external record. Measure tool-selection accuracy and task completion, not catalog size alone.

### 11.9 OVR-09 — Self-heal as verified recovery and repair

**Priority:** P1 source targeting and isolation; P2 complete repair lifecycle. **Related findings:** EN-01, EN-04, EN-15. **Owner:** Extension/runtime engineer plus release owner.

#### Current behavior and concrete concerns

The repo has a real feedback backlog in [self-heal/index.ts](../packages/opencode/src/kilocode/self-heal/index.ts), a `/self-heal` parser/prompt in [shared/self-heal.ts](../packages/kilo-vscode/src/shared/self-heal.ts), model-assisted classification in [the refinement tool](../packages/opencode/src/kilocode/tool/self-heal.ts), and startup wiring in [KiloProvider.ts](../packages/kilo-vscode/src/KiloProvider.ts), `rayaSourceDir()`/`startSelfHeal()` around line 4176.

The source resolver falls back to the current workspace when the configured/derived Raya checkout is unavailable. The flow then creates a session and starts repair there. A separate session is not proof of a separate git worktree or isolated filesystem. This is a source-confirmed mismatch with the stronger meaning of “isolated repair,” and a particularly serious problem when the user's open project is not Raya.

The backlog deduplicates normalized reports, but the caller shown starts a repair session after `create()` returns; returning an existing item alone does not prove that duplicate repair launches are prevented. The storage update layer merges status/evidence fields without its own complete transition/evidence validation. Other callers may add checks, but this boundary should not be the sole basis for calling a repair verified.

#### Separate three products

| Path | Purpose | Allowed default scope |
|---|---|---|
| Operational recovery | Recover a disconnected service, stale cache or retryable operation | Bounded, documented recovery in the user's current runtime, preserving drafts and work. |
| Feedback intake/diagnosis | Capture a problem, collect safe context and reproduce | Read-only diagnosis unless repair authority is provided. |
| Source repair and delivery | Change Raya code, test it and prepare a release artifact | Verified Raya source checkout in isolated worktree; later delivery follows the release policy. |

The label “Self-heal” can remain an approachable entry point, but the UI must show which path is happening. “Report saved,” “Repair in progress,” “Fix tested,” “Ready to install,” and “Installed” are different outcomes.

#### Intake and triage

Capture the user description, Raya version, platform, feature, relevant session/operation IDs, recent typed error and optional redacted screenshot/log extract. Let the reporter inspect attached diagnostics. Never automatically collect the entire workspace or raw credentials/transcripts.

Use deterministic fingerprints for exact duplicates and model-assisted triage for semantic similarity. Keep user wording and classification provenance. A proposed duplicate should reference the canonical item and its status; do not erase distinct reports solely because they share “browser” or “crash.” Aggregate occurrences and affected versions. Keep a minimal durable resolution/regression record even if detailed diagnostic content expires.

#### Repair workflow

1. Resolve a registered Raya repository using verified repository identity and supported base revision. If unavailable, keep the report and explain setup; never fall back to mutating the unrelated open workspace.
2. Atomically claim one repair attempt for the canonical issue. Repeated reports attach to it. Persist lease, owner, source commit and environment.
3. Create a dedicated worktree/branch with scoped tools. Preserve user changes and isolate concurrent repairs; no reset/clean of the main checkout.
4. Reproduce using a minimal real test or recorded runtime sequence. Distinguish “reproduced,” “environment failure,” and “not reproduced.” Do not invent a test that mirrors the proposed implementation and call it proof.
5. Diagnose the owning boundary and make the complete repair. Keep changes focused but do not stop at suppressing the symptom. Follow fork markers and package instructions.
6. Verify the original failure and relevant regression risks. UI issues require real-component/runtime evidence; packaging/startup issues require packaged validation. A separate verifier pass or deterministic gate should inspect evidence independently of the repair's success claim.
7. Produce a review package: original report, reproduction, root cause, diff, tests, artifact/build identity, limitations and rollback. Do not mark installed solely because source tests passed.
8. Merge/package/install only through the authorized release process. Verify the installed version and replay the relevant check, then notify the reporter once with a concrete result.

#### Recovery limits and integrity

Set per-issue attempt, time and cost limits. A repair failure must not recursively create more repair sessions. Repeated failures trip a visible stop condition and preserve evidence. Self-heal must not disable tests, weaken permissions, remove data or change acceptance rules merely to turn a status green. Proposed changes to those controls require explicit review within the repair scope.

Operational recovery can reconnect transport, restart an owned failed process, or rebuild a derived cache when the action is safe and authorized. It should snapshot relevant state first where needed, verify the postcondition, and stop after bounded attempts. If an external action may already have succeeded, reconcile it instead of replaying it.

Use lifecycle states such as captured, triaged, reproducing, repairing, verifying, ready for review, released, installed, blocked, duplicate and closed. Store evidence with artifact/version identity and enforce legal transitions. Duplicate status does not imply fixed; released does not imply installed for every user.

#### Acceptance

Test no configured source path with an unrelated open project: no source mutation occurs there. Test duplicate intake races, simultaneous repairs, crash after worktree creation, unreproducible reports, failing tests, missing tools, provider outages, stale base commits and upgrade rollback. The original report must be demonstrably fixed in the identified artifact before a verified status; the user's installed version must change before the interface says installed. No recursive repair storm, hidden mutation or misleading closure is acceptable.

### 11.10 OVR-10 — Browser runtime and product overhaul

**Priority:** P1 foundation with OVR-02; P2 complete browser workflows. **Related findings:** EN-10, EN-11, EN-14, UI-02. **Owner:** Browser/extension engineer plus product/design.

#### Current baseline and target

[BrowserSession](../packages/kilo-vscode/src/services/browser-automation/browser-session.ts), [panel](../packages/kilo-vscode/src/services/browser-automation/browser-panel.ts), [bridge](../packages/kilo-vscode/src/services/browser-automation/browser-bridge.ts) and [smoke service](../packages/kilo-vscode/src/services/browser-automation/browser-smoke.ts) already provide persistent automation, screenshots, manual control, serialized actions and assertions. The protocol is largely selector-based. Expand this into a dependable work browser whose state the user and agent can both understand.

The target is not merely a screenshot stream beside chat. It is a browser workspace with clear tab/profile ownership, grounded interaction tools, accessible manual control, reliable artifact transfer, recoverable sessions and verifiable outcomes.

#### Browser service model

Use explicit browser, profile, context, tab, frame and operation identities. Bind a task to its allowed context/profile rather than “whatever page is currently active.” Every observation carries page identity and a freshness/revision token; every action carries the intended target and optional expected revision. A stale revision causes a refresh/replan response instead of an action on an unintended page.

Use one action owner per tab. Independent reads and actions on separate tabs may run concurrently within limits, but state-dependent actions on the same tab must remain ordered. Manual takeover pauses agent writes and cancels pending coordinate actions. Returning control requires a fresh observation and preservation of the user's intervening changes.

#### Capabilities to add or formalize

| Capability | Required contract | User benefit |
|---|---|---|
| Tabs/popups | List/open/select/close, opener relation and stable identity | Work across sources and authentication popups without losing context. |
| Semantic interaction | Role/name/label/test-ID locators, scoped frames and ambiguity errors | Robust forms and controls instead of fragile guessed selectors. |
| Observation | Bounded DOM/accessibility snapshot, visible text, screenshot and URL/title | Grounded actions and readable evidence without overwhelming context. |
| Wait/assert | Visibility, navigation, download, state and explicit bounded conditions | Wait for the actual result, not arbitrary sleeps. |
| Upload/download | Authorized file references, completion, destination and artifact metadata | Reliable work with reports, attachments and exports. |
| Dialogs/frames | Explicit dialog handling and iframe targeting | Correct behavior on real business applications. |
| History/navigation | Back/forward/reload and recovery state | User-directed navigation without confusing task ownership. |
| Diagnostics | Scoped console/network failure summaries and optional redacted traces | Explain failures and produce useful smoke evidence. |
| Profile lifecycle | Create/select/reset, account indicator and expiry handling | Predictable identity and control over persisted authentication. |
| Visual fallback | Screenshot-based coordinates tied to viewport/revision | Support canvas-heavy interfaces when semantic controls are unavailable. |

Formalize the currently available subset first, then add missing capabilities with protocol-version support. Keep screenshot transforms, device pixel ratio, scroll offset and frame coordinates explicit so visual clicks do not drift. Read-only page evaluation should be a separate operation from arbitrary script execution. Retry only before a side effect or after confirmed nonexecution; a script that throws after a mutation must not be automatically executed again in another syntactic wrapper.

#### User-facing browser

Show a compact tab strip, back/forward/reload, address/title, active profile/account where discoverable, and an unmistakable manual/agent control. Display “Raya is using this tab” with Pause/takeover, not an intimidating permanent warning. Keep status and task controls outside the webpage so page content cannot impersonate them.

Make downloads accessible from the browser and linked to the task result. Uploads show the selected local file and destination. Login, MFA and challenge flows hand over to the user without promising automation of every challenge. Resuming after handover checks the account and target state again.

Provide keyboard access to browser chrome and host actions. A screenshot canvas alone is not a fully accessible web browsing experience; decide whether supported use includes native page interaction, an accessible semantic control view, or opening the page in a normal browser for manual work. Test that path with assistive technology instead of calling a screenshot surface accessible because its buttons have labels.

#### Reliability and security boundaries

Probe browser availability/version, launch capability, profile locks and webview connectivity at startup or on demand. Offer an actionable install/select/retry path. Avoid hardcoded platform identity that contradicts the actual host. Separate profile storage by the intended user/workspace policy and prevent concurrent ownership corruption.

Apply authorization to the real navigation/action path, including redirects and downloads, while supporting legitimate local development sites under the task's scope. Treat webpage instructions and downloaded content as untrusted data. Captured authentication has bounded retention and explicit reset. Do not export cookies into model-visible context or logs.

Recover from browser-process death by preserving task/operation state and reopening appropriate pages, then inspecting authoritative state. Do not replay a submitted form because the confirmation was lost. Where an API or record lookup can determine the outcome, use it; otherwise explain the uncertainty and request the needed decision.

#### Verification and rollout

Build a deterministic local test application covering SPA updates, navigation, two similar buttons, iframe forms, popups, slow responses, delayed downloads, file uploads, dialogs and ambiguous completion. Add controlled authenticated smoke scenarios with disposable accounts. Run production bridge/panel integration tests in addition to unit tests of browser methods.

Acceptance includes stable tab identity, grounded targeting, takeover during a pending action, expired login, locked profile, crash/restart, redirect failure, large downloads, upload cancellation, stale screenshots and side-effect uncertainty. A smoke result must reference actual assertions and build/session IDs. Track task success, wrong-target actions, duplicate mutations, recovery success, operation latency and resource growth across long sessions.

The browser overhaul and browser skill are delivered together: runtime capabilities without good agent procedure remain brittle; a sophisticated skill on an inadequate runtime cannot deliver the target experience.

## 12. Integrated overhaul delivery and handoff

### 12.1 Shared contracts to design first

Several requests depend on the same underlying guarantees. Implement those once, then reuse them across voice, goals, routines, browser and self-heal.

| Shared contract | Consumers | Required invariant |
|---|---|---|
| Task/goal identity and objective revision | Chat, Auto, voice, routines and self-heal | Every operation belongs to the correct objective/project version. |
| Operation identity and acknowledgement | Tools, browser, review and voice | Retries do not blindly repeat mutations; pending/failure is distinct from success. |
| Capability and authority envelope | Auto, specialists, tools, browser and routines | Delegation/recovery never silently widens authority. |
| Durable execution/lease state | Goals, routines and repair jobs | Restart reconciles real work before scheduling another attempt. |
| Evidence/artifact revision | Goal completion, review, canvas and self-heal | Verification applies to the current result, not an unrelated past success. |
| Usage ledger/rate provenance | Models, voice, tools, children and routines | Costs are reproducible, attributed once and honestly estimated. |
| Pending decision | Ask Cards, goals, routines, voice and permissions | Dismissal/default selection/timeout is not an answer or approval. |
| UI tokens and state vocabulary | All supported product surfaces | Equivalent actions/states have consistent meaning and presentation. |

Design these contracts within current owned boundaries and migration constraints. A shared concept does not require a new universal framework package. Prefer the smallest cohesive implementation with typed adapters into inherited surfaces.

### 12.2 Full implementation sequence

This sequence expands section 7. It is not permission to omit later stages once the first fixes pass.

| Stage | Concrete deliverable | Scope | Completion gate |
|---|---|---|---|
| A | Confirm deployment/migration exposure, baseline failures and design inventory | EN-01, EN-08, OVR-07, OVR-09 | Safe source/data boundaries; reproducible baseline; actual component/token map. |
| B | Shared lifecycle, evidence, operation and usage contracts | OVR-03 through OVR-06, OVR-08 through OVR-10 | Contract tests cover identity, concurrency, cancellation, authority and accounting. |
| C | UI foundation and complete Home → chat → Ask Card → result flow | OVR-07 | Approved on-brand real components with full states, keyboard and responsive verification. |
| D | Browser runtime plus browser skill vertical slice | OVR-02, OVR-10 | Representative multi-page task with upload/download, takeover and verifiable result. |
| E | OpenAI realtime voice integrated with that same task system | OVR-01, OVR-04 | Packaged extension conversation, interruption, one tool, goal/question handoff and accurate usage. |
| F | Goal and routine overhaul | OVR-05, OVR-06 | Durable restart/overlap/budget/evidence gates and complete routine UI pass. |
| G | Auto routing and broad tool packs | OVR-03, OVR-08 | Held-out task improvements; domain artifacts work; capability discovery and permission tests pass. |
| H | Verified self-heal repair and delivery | OVR-09 | Correct repository/worktree, deduplicated repair, evidence package and authorized release handoff. |
| I | Remaining UI surfaces, cross-client support and rollout hardening | OVR-07 plus all integration work | Every named surface migrated; supported-platform checks and mixed-ability task testing pass. |

Independent work can proceed concurrently after contracts are agreed, but each vertical slice needs one accountable owner. Do not defer UX until backend work is “finished”; review actual workflow states throughout. Likewise, do not ship beautiful mock screens against placeholder lifecycle behavior.

### 12.3 Required deliverables from the implementation session

- A refined implementation plan tied to OVR IDs and the original audit findings, with explicit migration/rollback steps and supported-platform scope.
- A versioned capability and state contract, including error/cancellation/acknowledgement semantics.
- Real-component UI stories/screens for every named surface and meaningful empty/loading/error/recovery state, using designer.md and the four references.
- An OpenAI voice adapter with verified current model/API configuration and packaged-runtime evidence; no claim of implementation based solely on changing a model string.
- A browser skill package paired with the browser runtime capability manifest and evaluation corpus.
- A routing evaluation report against the current system and a simple baseline.
- A reproducible usage ledger/rate calculation suite and visible estimate provenance.
- Durable routine/goal migration and restart/concurrency tests, including pending decisions and external-outcome uncertainty.
- A self-heal workflow with source identity, worktree isolation, repair deduplication, evidence and release-state separation.
- A tool-pack inventory identifying implemented, connected, unsupported and planned capabilities, plus usable example artifacts.
- A final requirement-by-requirement verification report. Unverified live integrations remain explicitly unverified; passing mocks or screenshots cannot stand in for them.

### 12.4 Review decisions and recommended defaults

| Decision for review | Recommended default | Reason / tradeoff |
|---|---|---|
| Voice provider and target | OpenAI native Realtime, starting from documented `gpt-realtime-2.1`, revalidated at implementation | Matches requested direction; account access and latency/cost still require testing. |
| Voice transport | Direct WebRTC with trusted broker/sideband; native/WebSocket only for a proven need | Simplifies primary media path while preserving host tool authority. |
| Legacy voice | Temporary explicit migration fallback, then retire unused paths | Avoids permanent parallel complexity and hidden provider switching. |
| Browser priority | Skill and runtime are one delivery track | Neither alone meets the requested quality. |
| Auto policy | Quality-first within user constraints, direct work when appropriate, bounded delegation | Smarter routing is measured success, not more agents or newer models. |
| Cost display | Reported amount or calculated estimate, with provenance and partial coverage | More useful than unavailable when rates exist; avoids false precision. |
| Routine execution location | Clearly labeled local execution initially; separate always-on worker only when needed | A sleeping workstation cannot guarantee scheduled execution. |
| Goal behavior | Durable full objective, explicit decisions, evidence-based completion | Prevents premature completion and repeated work after interruption. |
| Design direction | Codex-inspired interaction restraint with Instrument Serif display and Outfit UI/body | Preserves Raya identity while improving hierarchy and usability. |
| Tool breadth | Broad discoverable catalog, focused task packs and explicit connection status | Expands useful work without flooding every prompt or inventing integrations. |
| Self-heal | Bounded operational recovery plus isolated source repair and controlled delivery | Makes “healed” a verified outcome rather than a model status claim. |

### 12.5 Expansion verification record

This expansion was grounded in the current audit document, the full `docs/designer.md`, all four supplied screenshots, and renewed source inspection of speech/realtime contracts, Chief/model selection, usage calculation, goals/continuation, browser protocol/runtime and self-heal intake/storage. Official OpenAI Realtime/model/transport/cost documentation, Playwright locator documentation and the MCP tool specification were consulted for current technical recommendations.

The new sections are design and engineering specifications. No OpenAI session was opened, no billable provider test was run, no browser/voice implementation was changed, no self-heal repair was launched, and no external connector was installed or invoked. The original validation results in section 9 remain baseline evidence, not tests of these proposed overhauls.

| Requested item | Detailed specification | Verification required later |
|---|---|---|
| 1. OpenAI live multimodal voice | OVR-01 | Real packaged voice/tool session, interruptions, multimodal input and accounting. |
| 2. Browser skill | OVR-02 | Grounded end-to-end browser tasks and skill evaluations. |
| 3. Smarter Auto routing | OVR-03 | Held-out quality/latency/cost comparison and authority invariants. |
| 4. Calculated token cost | OVR-04 | Reproducible provider/model bucket calculations and UI provenance. |
| 5. Routine overhaul | OVR-05 | Scheduling, recovery, versioning, outcomes and complete UI. |
| 6. Goal overhaul | OVR-06 | Objective preservation, continuation, decisions and criterion evidence. |
| 7. Entire UI/UX with brand and references | OVR-07 | Every named surface/state, real renders, accessibility and user tasks. |
| 8. Broad work tools | OVR-08 | Discovery, connected capabilities, correct artifacts and scoped execution. |
| 9. Self-heal overhaul | OVR-09 | Verified source target, isolated repair, deduplication and delivery status. |
| 10. Browser overhaul | OVR-10 | Runtime capabilities, manual control, identity, recovery and integration tests. |

The document is ready for review when these ten specifications are present and internally consistent. The product overhaul is ready only after their implementation evidence exists. Keep that distinction explicit in the next session.
