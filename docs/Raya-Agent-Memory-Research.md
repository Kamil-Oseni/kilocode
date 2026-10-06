# Agent Memory Repo: adoption study for Raya

Reviewed 2026-10-06. Recommendation: adopt the compact linked-memory format and add a bounded consolidation worker that proposes memory updates and evidence-backed self-heal lessons. This document contains the design and historical implementation checkpoints. Use the current status below rather than older statements that a source feature remains unfinished. Automatic capture, scheduled Dreaming and automatic repair dispatch remain disabled.

## Current implementation and acceptance

Status checked against source at `9d5f0fdf3ac6b80e235cae71f918a5c488ebefea`, 2026-10-06, with the test-fixture corrections recorded below. Cloud workers are stopped and all their task/file reservations are released. Local work continues; no acceptance depends on a cloud worker returning.

| Requirement | Current source state | Still required |
|---|---|---|
| Bounded linked retrieval | Existing context/recall paths validate roots, link targets, source hashes and request budgets. Source and host preview plumbing are implemented. | Configured installed-corpus recall, held-out preference/contradiction quality and resource measurements. |
| Explicit consolidation | Native approved-source/target/model selection connects the manual job to the original SDK client and existing pending-proposal owner. It does not publish notes. | Matching installed Start, consent, real model output, cancellation and original process/GPU retirement. |
| Review, correction and deletion | Revision-aware review, rationale/conflict presentation, durable dispositions and deleted-fact suppression are implemented. Saved original IDs support outcome reconciliation without replay. | Installed review/edit/reject/apply/delete and restart acceptance against the configured service. |
| Activity and saved recovery | Memory/Admin show the original run and lifecycle; exact-run Cancel joins its original host promise. Read-only checkpoints explain pending and unconfirmed outcomes. Missing activity replies expire and permit a fresh read. | Installed host-reload/transport-failure presentation and native cleanup evidence. A saved phase is not cleanup proof. |
| Publication and retrieval freshness | Applied proposals expose separate native source review and confirmed sync through the existing control owner. Pending control requests block duplicate commands; indexing retries do not repeat publication. The view still distinguishes publication from unverified retrieval freshness. | Configured source-hash-matching retrieval after publication/sync, including unavailable index and restart acceptance. Never retry publication to repair indexing. |
| Repair lessons | Existing self-heal evidence/applicability and recurrence boundaries remain the owners; hypotheses cannot mint verified repair or delivery receipts. Earlier source checks are retained below and in the Dream checkpoint record. | Held-out repeated-failure reduction and installed repair/lesson acceptance. No automatic repair dispatch. |
| Foreground priority and resources | Existing scheduler/model contracts supply bounded background admission and original SDK settlement/retirement handling. | Real foreground conversation under consolidation load and native model/unload measurements. |
| Automatic capture and idle schedules | Disabled by policy. The manual workflow grants no authority to enable them. | Separate user decision after the required readiness checks. |

The full Memory package now passes **211 tests, 952 assertions, 20 files**. All seven extension Dream suites pass **21 tests, 138 assertions**. The backend's original inspection/settlement suite passes **2 tests, 14 assertions**. Memory typecheck passes. The original test command handles returned exit 0; no test command was restarted after a wait timeout. The package uses disposable ledgers and actual pinned-Python proposal-store fixtures, alongside controlled generation ports. The extension suites cover actual selection/review/transport helpers with synthetic native/HTTP responses. These checks establish the current source cohort, not native inference, installed services, human speech or device behavior.

Logs are retained at `.tmp/memory-private/memory-cohort-full.log`, `dream-cohort-full.log`, `dream-cohort-backend.log` and `memory-cohort-types.log`. The current native UI and missing-reply browser evidence is recorded in [the Dream checkpoint](Raya-Dream-Input-Checkpoint.md). Broader workflow gates and installed readiness remain open; these source counts do not increase the readiness score.

## Combined Memory regression checkpoint, 2026-10-06

After merging the local diagnostic cohort and the recall/health fixes, the full Memory package passes **211 tests, 952 assertions, 20 files**. The explicitly qualified extension SecondBrain cohort passes **160 tests, 1,363 assertions, 28 files, no skips**. Current-client and original-owner fixtures verify all twelve production source images against the current release catalog before loading the real Python Journal/certificate codecs. Historical operation-codec checks retain the original review SHA `f99cc7a0819bb7c2216c727e03620ca56ac3b1e8fc94ef0207ad3e7ccda7d037` and its actual saved source images under `D:/Raya/Services/Memory/Candidates/MemoryWorkerLedger-20261003-v3`. The pinned Python executable SHA is `b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2`. The current-client tests require that pinned interpreter; the historical tests also require the explicit retained source directory.

The broad run exposed stale tests: the DOM fixture advanced before pending review finished, singleton registration expected one command after the separate Dream inspector was added, and an obsolete generated JavaScript test contradicted the authoritative TypeScript version's v2-loading and durable-debt checks. These fixtures are corrected without weakening production release selection. Earlier failed and partially skipped logs remain retained. The initial qualified run used the wrong source directory; the retained-source rerun then exposed the eleven-versus-twelve-pin fixture mismatch. Both current-client and owner fixtures now use an explicit current-catalog mode, while historical mode keeps its unchanged review hash.

Final logs: `.tmp/memory-private/memory-postmerge-full.log` and `memory-postmerge-extension-final.log`. Full extension compile, host/webview typechecks, lint, bundle, Knip and required formatting pass. Pure codec fixtures use an inert publication sink; source/native-helper fixtures use disposable roots and controlled callbacks. This does not prove installed consent, real model output, GPU retirement, foreground priority, personal recall quality or complete everyday readiness. All corresponding acceptance gaps above remain open.

## Recall qualifier checkpoint, 2026-10-06

The linked reader previously began at the highest query-overlap line. Actual reader regressions showed it could omit a preceding historical/replaced qualifier, or fit a matching fact while dropping its following unconfirmed-suggestion qualifier. Selection now includes the complete matched paragraph before extending the passage. If that paragraph cannot fit with its source/section labels, the reader omits it with explicit budget diagnostics rather than returning an orphan fact. Source hashes, exact contiguous line coordinates, immutable reviewed notes, cancellation and capture-disabled behavior are preserved. Navigation admission also accounts for existing diagnostics so an omitted passage cannot overflow the bounded diagnostic list.

The context release catalog pins the newly reviewed `index.py` bytes; it does not allow arbitrary source revisions. A configured old release requires the existing explicit native release-selection workflow before this new reader is used. This is a local reader-quality fix, not a semantic model benchmark or proof that every contradiction is resolved correctly. Installed source selection, corpus quality, foreground resource measurements and the acceptance gaps above remain open.

Validation: the production-reader Python suite passes 19 tests, the request decoder passes three, and the qualified transport/result/release/control cohort passes 19 tests with 150 assertions. The three qualifier regressions failed against the previous selector before the change. Extension compile, lint, Knip, required formatting and source/table guards pass. Logs are `.tmp/memory-private/recall-qualifiers-*`; the initial stale-release refusal is retained. Final `index.py` SHA-256 is `55d17ba416e1cf187a5497c4257d07a5628a66e30d49ef75e18ca169567315e5`.

## What Cognition released

[Cognition's page](https://cognition.com/agent-memory-repo) describes durable linked notes and periodic Dreaming: finding patterns across sessions and maintaining existing memory. The public implementation is substantially smaller than a complete memory service.

The complete [GitHub tree at commit 1db04a5735adbc4f2158308f2077fd960e243c04](https://github.com/AgentMemoryRepo/agentmemoryrepo/tree/1db04a5735adbc4f2158308f2077fd960e243c04) contains five files: a plugin manifest, README, specification, license and agent skill. There is no Dreaming scheduler, database, retrieval engine, model or repair implementation in that tree. The [skill](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/1db04a5735adbc4f2158308f2077fd960e243c04/skills/agent-memory-repo/SKILL.md) explicitly excludes startup hooks and scheduled jobs. It performs local memory work when invoked.

The project is [MIT licensed](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/1db04a5735adbc4f2158308f2077fd960e243c04/LICENSE). Reused source or substantial documentation excerpts must retain the applicable attribution and license. No upstream code was incorporated during this study.

## What fits SecondBrain

The [specification](https://github.com/AgentMemoryRepo/agentmemoryrepo/blob/1db04a5735adbc4f2158308f2077fd960e243c04/SPEC.md) uses a short MEMORY.md entry point, topic files, source/date metadata and root-relative wiki links. Git supplies history and conflict detection. These ideas fit Raya's existing categorized notes without replacing the folder structure.

| Idea | Proposed Raya adaptation |
|---|---|
| Compact entry point | Treat the existing INDEX.md as the supported entry point, or provide a small compatibility MEMORY.md later. Include essential preferences and topic links; enforce a measured token budget. |
| Linked topic files | Keep Areas, Projects, Preferences, Decisions and Commitments. Add validated links so retrieval can follow related topics within a bounded depth and size. |
| Source metadata | Record source session/event IDs, timestamps and hashes. Separate user statements, measured results and model hypotheses. |
| Revision history | Preserve existing versions and publication journals. Evaluate local-only Git as an additional history/export mechanism through the supported writer; no remote sync is required. |
| Clean-up | Propose duplicate merges, outdated-status corrections and broken-link repairs. Keep older evidence recoverable. |
| Separate ownership | Keep personal memory, project knowledge and system repair knowledge distinguishable in retrieval and permissions. |

The current personal SecondBrain uses manually curated Markdown and a separately configured retrieval/control service. The inherited Kilo memory package also has capture, consolidation, review and recall primitives. These are separate paths today. Integration should connect their contracts and provenance rather than introduce a third competing memory store.

Do not import the upstream automatic-edit loop unchanged: Raya's agreed memory behavior includes reviewable updates and currently disabled automatic capture. The external skill is research material here, not installed instructions or authority to edit notes.

## Dreaming for Raya

Dreaming should be a background maintenance job, not model training or an always-resident extra model. It can reuse an existing local model under the resource scheduler.

1. Select newly eligible, authorized session summaries, approved notes and verified repair outcomes since the last durable checkpoint. Do not scan every personal file or record new activity.
2. Retrieve relevant topic notes and the raw evidence needed for each candidate. Bound input tokens, elapsed time, output operations and memory use.
3. Produce typed proposals: add a sourced fact, revise a stale entry, connect related notes, merge a duplicate, or flag a contradiction. Each proposal names its baseline source hashes and evidence.
4. Validate paths, provenance, secret redaction, link targets and conflicting revisions before presenting the diff in the existing review flow.
5. Publish accepted changes through the supported memory owner, then update the derived index and confirm retrieval points to the new source hashes. Keep rejected proposals from repeatedly reappearing unchanged.
6. Advance the checkpoint only after durable publication/rejection records. On cancellation or restart, reconcile the retained run rather than replay uncertain writes.

Start with manual runs against synthetic fixtures and approved notes. A future idle schedule should yield promptly to voice and foreground jobs, unload its model afterward and perform no device actions. Scheduling or automatic capture needs a separate explicit decision; this study does not activate either.

## Connection to self-heal

The useful extension is a repair-learning loop. A dream worker can group recurring failure evidence, identify which fixes actually worked, and propose a reusable diagnostic or regression. It must not turn a plausible explanation into a verified repair.

Proposed flow: failure evidence → recurrence/hypothesis proposal → reproduction → owned repair worktree and goal → actual verification → reviewed delivery → sourced lesson.

Raya already has durable feedback items, owned repair attempts, source snapshots, verification receipts, completion records and artifact approval. Dreaming should feed those existing boundaries. It cannot mint completion receipts, approve its own package, install a release or automatically replay an uncertain repair dispatch.

A repair lesson should retain the symptom, relevant version/environment, evidence references, unsuccessful approaches, verified fix, regression test and applicability limits. Distinct incidents remain individually traceable even when grouped. If a later release invalidates a lesson, mark its applicability stale rather than erase the old evidence.

Concrete example from current work: a goal pause rotates intent, while ordinary turn accounting can advance revision without changing semantic identity. A sourced lesson can help a future repair agent distinguish those cases. Its evidence should cite the actual implementation and regression, rather than merely repeating a chat summary.

## Implementation order and acceptance

1. Add a compact entry-point/link contract to existing retrieval. Verify bounded loading, missing links, root escapes, foreign memory roots and stale source hashes.
2. Add a proposal-only consolidation run using existing memory review/publication contracts. Verify conflicting baselines refuse publication, duplicate runs do not repeat accepted writes, deleted facts stay deleted and cancellation leaves no partial publication.
3. Add repair-lessons retrieval and recurrence proposals to the existing self-heal backlog. Verify hypotheses cannot mark a repair complete and unrelated versions do not inherit unsupported fixes.
4. Evaluate source-grounded preference recall, contradiction resolution and actual repeated-failure reduction using held-out sessions. Measure latency, tokens and peak RAM/VRAM against the current baseline.
5. Consider scheduled idle operation only after those checks and installed recovery/Stop behavior pass. Preserve ordinary conversation priority and the user's device/sleep restrictions.

Source inspection for this study covered `packages/kilo-memory/src/effect/service.ts`, `packages/opencode/src/kilocode/memory/ports.ts`, `packages/opencode/src/kilocode/self-heal/{index,repair,schemas,completion,artifact}.ts`, `packages/kilo-vscode/src/second-brain/host.ts` and the current SecondBrain INDEX.md. It establishes available source structures, not full installed runtime acceptance.

## Build design and parallel implementation boundaries

The user has stopped Raya’s cloud workers and released their work reservations. Continue these implementation workstreams locally; do not assign or restart cloud workers. This section defines the intended implementation; it does not claim these features are built. Keep current installations usable while patches are prepared in isolated workspaces. One integration lead owns the shared contract and merges compatible patches. Reserve paths before editing; the installed acceptance owner retains installation, runtime trials and release decisions.

### Existing boundaries to extend

`second_brain_proposal` already permits list/read/propose and deliberately excludes applying, editing or cancelling proposals on the model's authority. It validates project-local source hashes and bounded source snapshots. The extension's `second-brain/host.ts` separates model proposal requests from the human review/apply flow. Reuse those boundaries; a Dream worker cannot become an alternate writer. Existing proposal states include pending, cancelled, applying and applied: a rejected Dream candidate needs its own durable disposition without inventing an incompatible proposal status.

The inherited memory service and `memory/ports.ts` already contain consolidation/model plumbing. Recalled-memory turns are excluded from capture to prevent memory echo. Dream selection must likewise exclude recall-only answers and previously generated proposals as fresh factual evidence. Self-heal already stores source snapshots, repair attempts, verification receipts and completion/artifact records. Lessons cite those records rather than replacing them.

### Shared contracts

| Record | Required content |
|---|---|
| Memory source | Authorized root/namespace, normalized root-relative path, content hash, source kind, original event/session identifier and timestamp when available. Missing metadata remains unknown. |
| Retrieval result | Selected passage, source hash, relevance reason, followed links, truncation/skip reasons and budget consumed. Facts, measurements and hypotheses remain distinguishable. |
| Dream run | Stable run ID, root and project identity, source-selection checkpoint, input hashes, model/config identity, bounded resource policy, phase and original owner. |
| Dream candidate | Stable evidence-derived fingerprint, kind, proposed changes, baseline note revisions, source references, explanation and unresolved contradictions. |
| Review disposition | Candidate and exact reviewed revision, accepted/rejected/superseded/deleted disposition, reason when provided, publication receipt or unresolved outcome. |
| Repair lesson | Incident references, symptom, source/release/environment applicability, failed approaches, verified fix and regression references, current applicability status. |

Use existing schemas and IDs wherever their meaning matches. Add versioned Kilo-owned contracts only for missing semantics. A checkpoint is a processed selection cursor with per-input dispositions, not permission to forget evidence or a claim that every proposed change was accepted. Record a durable pending proposal before advancing selection past it; later apply/reject outcomes remain separately reconcilable. Unknown creation or publication outcomes block replay until the original identifier is reconciled.

### Workstream A: compact linked retrieval

Extend the configured retrieval owner with an INDEX.md entry point and optional MEMORY.md compatibility alias. Resolve links under the authorized memory root; reject absolute paths, root escapes, foreign roots, symlink escapes and stale source hashes. Follow a bounded graph with cycle detection and a deterministic priority order: relevant topic hits first, related links second. Never load the whole vault merely because it has links.

Initial configurable engineering budgets are 2,000 estimated entry-point tokens, depth two, at most twelve linked documents and 12,000 total retrieved tokens, always capped below the request's remaining context budget. These are starting defaults to measure, not model capacity guarantees. Oversized notes return selected passages with explicit truncation. Missing or invalid links produce diagnostic skips, not fabricated facts. A failed index refresh must not represent an older index as current.

### Workstream B: proposal-only Dream job

Implement a manually started background job selecting only already-authorized summaries, approved notes and verified repair outcomes. It does not enable capture or observe new daily activity. Use the existing resource admission/model routing owner; yield to foreground conversation and voice, bound each batch, and release model residency when idle. Initial limits should be explicit configuration: one active run per root, bounded input/output tokens, at most twenty proposals per run and a finite elapsed-time deadline.

Persist phases for selection, generation, validation, proposal submission, review-pending, reconciliation and terminal outcome. Cancellation stops selection/model work promptly and joins the original worker; already durable proposals remain pending and visible. If submission may have succeeded, record an unknown outcome and inspect the original ID rather than creating a replacement. Restart resumes reconciliation, never uncertain writes. Concurrent runs cannot claim the same input batch without an ownership decision.

Validate evidence, link targets, secrets and baseline revisions before submission. Only the existing review/publication owner may publish. A changed baseline requires regeneration or renewed review of the changed diff. Rejections suppress identical candidate fingerprints; new evidence may produce a distinct candidate. User deletion records a suppression/tombstone so later consolidation cannot silently resurrect the same fact. A changed accepted note remains historical evidence rather than being erased from provenance.

### Workstream C: repair lessons and recurrence

Retrieve system lessons separately from personal preferences and project knowledge. Group recurring symptoms into evidence-backed proposals while retaining individual incidents. Separate suspected cause, reproduced cause and verified repair. A lesson with missing verification is a hypothesis and cannot satisfy completion. Applicability must include the relevant source/release and environment; similarity alone cannot transfer a fix to an unrelated version.

Create or link an existing self-heal backlog item using its normal ownership/permission boundary. Dream may recommend reproduction or a regression, but cannot dispatch an uncertain repair twice, create verification receipts, approve an artifact, install a package or operate devices. Later invalidation marks the lesson stale and links the contradicting evidence.

### Workstream D: review and activity experience

Provide a manual “Review memories”/“Consolidate approved notes” entry in Memory and expose the run through the existing activity panel. Show actual phase, model, bounded progress and a working Cancel action; do not animate progress after ownership is lost. The review lists grouped proposals with readable before/after diffs, original source links, rationale and contradictions. Users can approve the exact revision, reject, edit then review again, or delete a remembered fact through the supported writer.

Keep a visible distinction between “proposals prepared,” “changes published” and “search index refreshed.” Publication without successful refresh must report that state and offer a safe retry of indexing, not repeat the write. Existing trust/read permissions remain meaningful; ordinary conversation should not require navigating technical settings. Automatic capture and idle scheduling remain off until separately enabled by the user.

### Integration and later verification

Local implementation delivers actual patches against an identified baseline and documents contract changes. The former cloud reservations no longer block these workstreams. Shared backend contracts land before dependent UI patches. A cloud-only patch cannot claim Windows process, installed service or native runtime verification. Follow repository changeset, SDK regeneration, source-link and annotation requirements when applicable. After implementation, run focused actual-implementation checks and the combined installed flows; keep the nine existing acceptance gates intact.

Acceptance must include bounded relevant recall; malicious/missing/cyclic/stale links; conflicting revisions; deterministic duplicate suppression; deletion persistence; cancellation during generation and submission; crash after proposal creation and publication; unavailable index/service; unknown outcome without replay; foreground priority; visible pending review; and a verified lesson versus an unsupported hypothesis. Use synthetic/private fixtures first. Personal data, microphone, audible playback, Home Assistant, lights and VM maintenance stay outside these implementation trials.

## Local implementation checkpoint, 2026-10-06

Cloud reservations are released. The linked-reader foundation is implemented locally in the existing Memory retrieval owner, `script/memory/service/index.py`, rather than a third store. Its internal `Index.context` operation starts with validated search revisions, then reads an approved INDEX.md and follows relative Markdown links breadth first. It retains the existing admission lease, tokenizer, deadline and cancellation checks. Returned passages include exact source hashes and line coordinates, measured token usage, depth and explicit truncation; rejected navigation returns diagnostic skips. Defaults bound depth to two, documents to twelve and each passage to 2,000 tokens, with a caller budget capped at 12,000.

Fourteen private-file tests exercise the production reader with the real source policy: cycles, depth, passage provenance, budget exhaustion, stale seeds, changed approved files, exclusions, absolute/encoded/foreign/missing links, fenced examples, cancellation, hard links, mid-read changes and bounded navigation attempts. Those tests supply a deterministic character counter; they prove budget enforcement against the supplied counter, not a particular model's tokenization or context capacity. Three clean-fixture portability checks and three existing lazy-tokenizer checks pass. The selected Memory source pins and supervisor pin were refreshed; the dispatch-release regression, extension typechecks and affected catalog lint checks pass.

The next local stage adds an explicit `context_budget` to the existing search operation, without inventing another request owner or cleanup protocol. Normal search bodies and result schemas remain unchanged. Linked replies contain no additional unbudgeted search passages. The request's original fingerprint includes its budget; the client checks exact linked-result fields, root containment, source hashes, coordinates, document/depth/token bounds, duplicate sources, totals and truncation. Its operation owner uses the existing durable-before-submit and original-client retirement path. A previously selected release lacking this capability is refused before health, journal publication or POST, while ordinary search remains supported.

A loopback test passes a real production Python reader and Journal result through the TypeScript client, preserving Unicode and rejecting changed receipt data. It also verifies one POST after durable preparation and no submission for invalid budgets or old releases. Four strict result-contract tests and the dispatch-release regression pass: six TypeScript tests with seventy assertions. Three production request-decoder tests cover legacy normalization and invalid context admission. The extension typechecks, affected lint, bundle, Knip and change-marker guard pass. The fixture uses disposable notes, a deterministic character counter and an inert publication sink; it does not prove actual model tokenization, native/ACL ownership, installed cancellation or personal recall.

This remains **not installed or available to ordinary conversation yet**. The host/model bridge, connecting the read tool to its request allowance, and display of diagnostic/truncation data remain to be implemented. The existing semantic search still scans approved sources and may sync its derived index; this checkpoint does not prove that indexing loads only selected notes. Dream jobs, review UI, durable candidate dispositions and self-heal lessons remain unfinished. Automatic capture and scheduling remain off. No personal notes, live services, devices or VM settings were changed for these tests.


### Request context allowance checkpoint

The backend now creates one context allowance per resolved tool owner and binds it to the actual assembled outgoing provider frame. It estimates messages and schemas with the existing conservative overflow estimator, retains reported usage when higher, and reserves output plus a 1,024-token margin. Unknown context/output capacity refuses recall. Concurrent reservations consume the same allowance; failure does not refund uncertain work. Superseding frames and cancellation invalidate publication, and each reservation can publish only one fully serialized result within its reserved estimate. Mixed original owners refuse rather than multiplying capacity. This is an engineering estimate, not an exact provider tokenizer guarantee.

Six production-helper tests pass with 28 assertions, including copied executor identity, parallel reservations, metadata overhead, supersession, cancellation and unknown capacity. CLI typechecking and shared-code annotation/Promise-facade guards pass. This adds the budget hook; the model-facing read tool is still pending, and no installed conversation or native service acceptance is claimed.


### Backend recall contract checkpoint

The existing Second Brain request owner now accepts an explicitly bounded, non-empty context query alongside its unchanged proposal commands. Recall replies retain their authorized project, Memory root, source coordinates and hashes, passage counts, token totals, skips and truncation. Reply validation rejects wrong projects, root escapes, relative or restricted source paths, invalid source revisions, duplicate sources, inconsistent totals and budget excess before settling the original deferred. Cancellation uses the existing session owner. This verifies reply metadata and request correlation; the trusted host/service remains responsible for actual source revision checks.

Fourteen focused tests pass with 118 assertions across proposal lifecycle, public/model schemas and request allowances. The OpenAPI nullable-field repair was updated for the new proposal-result component; its regression passes and the SDK was regenerated by its build script. CLI and extension typechecks pass. The context read tool and host/service hookup remain pending, so no installed recall acceptance is claimed.


### Read-tool and host hookup checkpoint

The source now registers second_brain_recall for the VS Code host and includes it in the bounded initial discovery catalog when it fits. It requires the original request allowance and its own read permission, reserves serialization overhead, and verifies the final JSON estimate before returning sources. A forged allowance, missing frame or exhausted context fails before host publication. Completed sourced recall is excluded from capture as fresh factual evidence.

The trusted workspace host now validates the exact context command and calls the existing BrainService intake and OperationOwner context path. Parent cancellation aborts the original controller; pending work remains joined through Stop/disposal, and legacy setups refuse before network search. Host result arrays are copied for the generated SDK contract. The existing read/proposal/budget tests pass (13 tests, 111 assertions), the three actual discovery-binding tests pass (134 assertions), and eleven coordinator/SDK-bridge tests pass (69 assertions). CLI/extension types, affected lint, bundle, Knip and change-marker guards pass. The new coordinator case verifies refusal and cancellation intake; it does not establish a successful native v2 context operation.

These checks use private HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG profile variables, or the CLI private test preload. Earlier commands did not explicitly isolate the full set; the integration owner reported concurrent normal-profile log changes and is repeating preservation verification after those writers stopped. No process from those earlier runs remains pending.

Next verify the combined supported v2 host/service path, native release compatibility and diagnostics display before handing this off for deployment. No installed recall gate has passed. Dream/review jobs and repair lessons remain unfinished; capture and scheduling stay off.


### Linked preview and coordinator verification checkpoint

Memory now provides an explicit Preview linked context action using a 3,000-passage-token engineering budget. It shows source paths and line coordinates, source hashes, passage counts, truncation and skipped-link reasons. This manual preview stays in the panel; conversation recall uses its separately authorized model tool. The host validates the preview query and budget and retains its original cancellation owner. Unsupported service releases return a useful setup message.

The selected twelve-source release now passes the updated host/Journal fixture. Eleven coordinator and real-DOM tests pass with 198 assertions; five actual reader/result-contract tests pass with 52 assertions. The new coordinator context case is a genuine zero-passage Journal transaction with an inert publication sink. It establishes original request/debt settlement across BrainService, OperationOwner and ClientV2, not a native retrieval worker or a successful non-empty source query. The non-empty reader test separately uses real disposable notes and a character counter. DOM checks render controlled sourced metadata, prove diagnostics are escaped and reject stale replies; the fixture now supplies the actual ServerProvider required by proposal UI.

Both extension typechecks, affected ESLint, bundle, Knip and change-marker checks pass using private profiles. No installed gate is earned by these fixtures. Next connect a supported private native service fixture to the complete non-empty host flow, verify release compatibility, and then prepare the combined source handoff. Dream/review jobs and repair lessons remain unfinished.

### Private lifecycle and recall-error checkpoint

Thirteen private startup and retirement tests pass with 113 assertions using the retained supported native helper and pinned Python. They verify original child identities, protected namespaces, joined exits, readiness failures and clean restart guards. Controlled phase fixtures establish lifecycle behavior; they do not establish full model inference, a successful non-empty native recall query or installed acceptance.

Recall cancellation, timeout, rejection and disconnect errors now distinguish read-only context requests from proposal writes. Seven backend tests pass with 85 assertions, along with CLI typecheck, affected lint and annotation guards. Proposal failures retain their original reconciliation guidance. All checks use private profile paths. Cloud work reservations remain released; local implementation continues without cloud assignments, automatic capture or scheduling.

### Dream candidate bookkeeping checkpoint

The existing MemoryFiles boundary now exposes a versioned, project-bound candidate ledger using its existing root queue and publication admission. Selection retains at most twenty new candidates per call, with a bounded 128-row ledger. Fingerprints include stable owner-supplied fact identity, source revisions and exact proposed changes; explanation rewording cannot defeat duplicate suppression. Rejection suppresses the same fingerprint. Deletion retains a fact tombstone across changed evidence and blocks acceptance of another candidate for that fact. Review history preserves earlier publication receipt references after deletion or supersession.

Submission records the original proposal ID before the caller invokes the existing proposal owner. A submitting row represents an unresolved outcome and cannot be resubmitted; reconciliation must retain that ID. Acceptance requires a receipt reference. This library checks bookkeeping identity, not source bytes or receipt authenticity: the trusted selection/review owner must validate those and supply stable fact IDs. Proposed lesson content does not establish a verified repair. It grants no publication authority and writes no notes.

The final package suite passes 177 tests with 745 assertions, including five ledger tests with 24 assertions, alongside package typecheck and affected lint. Tests use actual disposable file-backed ledgers, reload uncertain submissions, reject project/revision changes and exercise the existing root queue concurrently. Invalid relative identities fail before creating a queue lock. They establish ordinary reload behavior, not power-loss durability or installed acceptance. The manual Dream generation job, resource admission, cursor reconciliation, review UI and verified repair-lesson plumbing remain unfinished. Capture and scheduling stay off.

### Manual Dream execution checkpoint

The MemoryFiles boundary now exposes an explicitly invoked Dream job and retained run records. One active run per root survives ordinary reload; another run cannot replace it. Records retain the original run/owner IDs, selected source revisions, model identity, deadline, engineering token budgets and candidate checkpoint. Phase transitions reject replay of generation after reconciliation, advancement without retained candidates and completion while proposals are unknown or reviews remain pending. The job admits through a supplied existing scheduler/model owner, awaits its original generation promise, validates selected evidence and secrets, retains candidates, and submits only original-ID pending proposals. It never applies notes. Source revisions are checked again through the trusted review owner immediately before submission.

Cancellation aborts the original signal and waits for generation settlement before lease retirement. A lost proposal reply preserves the original ID and active reconciliation. A failed retirement also preserves reconciliation instead of allowing replacement. The output cap uses the package's character-based token estimate with a 30% margin; it is not an exact model tokenizer limit. The host adapter must enforce actual input/output limits, foreground priority and owned resource retirement.

The package suite passes 186 tests with 786 assertions, alongside package typecheck and affected lint. New tests exercise real disposable evidence files, revision checks, pending proposal files and persisted run/candidate records. Generation and resource ports are controlled fixtures; these checks do not prove inference, native process retirement, real scheduler priority or installed operation. Existing model invocation currently races its timeout against the original call without joining that call before returning; it cannot be directly reused for Dream until that ownership gap is addressed. Scheduler/model adapters, original proposal reconciliation after restart, manual review/activity UI and verified repair lessons remain unfinished. No capture, scheduling, device operation or installed acceptance was enabled.

### Model operation ownership and priority checkpoint

The existing MemoryModel adapter now aborts at its deadline but awaits its original SDK operation before returning. It rejects late output after timeout or parent cancellation and refuses an already-cancelled call before dispatch. Controlled delayed provider tests cover both non-streaming completion and streaming opening. A provider that ignores cancellation can therefore keep the call pending; the adapter does not claim retirement merely because its timer elapsed. This establishes original JavaScript-operation ownership, not GPU/native retirement.

Explicitly configured local providers now receive the existing scheduler's background lane tag for consolidation. Remote providers receive no internal tag. Thirty focused model/scheduler tests pass with 135 assertions, including actual loopback HTTP queue-priority, retained-body and header-stripping checks. CLI typecheck and annotation/facade guards pass. Affected lint reports zero errors and seventeen existing warnings in the adapter/test files; new cancellation tests use no new unsafe casts.

The broader Memory filter passed 53 tests but failed the native Source drain case because the default executable was absent. Repeating that case with the retained fb46 helper (exe df193ae49c7d8458cabb5868aa31f56686f98ed3ed9400414249bb0980a0dff1) also failed: Source export transport refused, with RAYA_SOURCE_IMAGE_CURRENT_BIRTH_REFUSED/ENOENT in the private cleanup log. Receipt at C:/Users/kamil/AppData/Local/Temp/raya-memory-source-drain-lhSaQN/receipt.json has forced false and only the initial accepted-write checkpoint, not a successful export. Its historical hardcoded sourceQualified true must not be treated as proof; the fixture now sets that field only after the successful encrypted-drain assertions. The failed trial is retained. No native Source gate or installed gate is claimed. The retained helper is not the currently compiled recipe. Scheduler/model Dream adapters and review UI remain pending.

The corrected fixture was rerun with the same retained helper and again failed at the Source export boundary. Its new receipt at C:/Users/kamil/AppData/Local/Temp/raya-memory-source-drain-s4T0oc/receipt.json correctly records sourceQualified false and forced false, retaining only the initial checkpoint. Both original test processes and the final typecheck are terminal. This confirms truthful failure recording, not successful native drain or whole-family retirement.

### Bounded model lease integration checkpoint

MemoryModel now accepts explicit manual-job input/output budgets. It rejects malformed budgets, unknown or exceeded configured model limits, and oversized estimated prompts before provider dispatch; it sends maxOutputTokens to the actual SDK and refuses oversized returned text. Legacy capture calls omit the new budget and retain their previous request behavior. The input/output text guards use the package's character estimate with a 30% margin and do not establish exact tokenizer counts. The controlled compatible-provider HTTP test observes max_tokens on the wire.

The Dream model lease reuses that host model port, preserves the explicitly selected model, refuses fallback or lease reuse, and joins its original generation/decoding promise on retirement. Resolution must execute through a supplied retained host runtime; the package creates no replacement runtime or model server. The trusted decoder assigns fact identities; model-generated text cannot choose deletion identities or publication authority. Job admission now projects the model, source revisions and budgets from the saved run and uses its remaining deadline, rather than retaining mutable caller settings. The lease also captures its prompt and budgets before asynchronous resolution.

Seventeen adapter tests pass with 49 assertions, including a composed DreamJob → DreamModel → actual AI SDK → shared local scheduler → loopback HTTP transaction → retained pending proposal file. It proves configured output-cap propagation, internal-header stripping, pending review, no note publication and zero active/queued transport slots afterward. The endpoint returns controlled output; it is not a local-model quality test, real Second Brain proposal service or GPU-residency proof. The package suite passes 187 tests with 792 assertions; package/CLI typechecks and guards pass. Affected lint has zero errors, with the same seventeen existing CLI adapter/test warnings. The native Source failure remains unresolved. Trusted approved-note selection, actual proposal owner/reconciliation, ordinary review/activity UI and installed verification remain pending; automatic capture and scheduling stay off.
