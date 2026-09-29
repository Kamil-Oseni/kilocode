# Browser confirmation contract

Status: **proposed; not implemented or verified**. This contract describes a future bounded backend journal. It does not claim that the current host journal converges successful acknowledgements after restart, or that multiple hosts currently share dispatch ownership.

## Existing boundaries

`packages/opencode/src/kilocode/browser/service.ts` holds requests and their waiting Deferred values in directory-scoped memory. Its `reply` removes a pending request and settles the waiter. A backend restart loses that waiter; a receipt must not recreate it.

`packages/kilo-vscode/src/services/browser-automation/browser-bridge.ts` retains small successful results in memory. Its current persistent journal retains selected unknown failures. `BrowserAutomationService` supplies `context.globalState`; adding full results there would retain page data and potentially secrets.

`packages/opencode/src/storage/storage.ts` exposes `create` through `packages/opencode/src/kilocode/session/review-publish.ts`: write complete temporary JSON, sync the file, then hard-link it into an exclusive destination. An existing destination returns false. `replace` is atomic publication, not a compare-and-swap operation. The append-only ownership/revision pattern in `packages/opencode/src/kilocode/tool/mutation-journal.ts` is the relevant precedent.

## Private admission and canonical origin

Before publishing `kilocode.browser.requested`, persist a version 1 admission bound to an opaque admission ID, request ID, canonical directory scope hash, server-issued request digest, operation, session ID, assistant message ID, and tool call ID. Pass canonical origin privately from the real `Tool.Context` in `packages/opencode/src/kilocode/tool/browser-host.ts`; do not infer it from a session's latest tool or expose it as provider authority.

Validate the actual retained tool's session/message/call identity, tool name, and eligible pending/running state. The request digest binds the exact request, including sensitive fields, without persisting those fields in the journal. Its encoding must be defined once by the backend; the host echoes the opaque value. Authorization-only requests remain distinct from native dispatch and cannot become dispatch grants through confirmation.

## One-time dispatch ownership

An additive dispatch endpoint validates admission identity and a fresh host invocation ID, then uses `Storage.create` to publish one immutable dispatch claim. Only the caller that successfully creates that claim receives a one-time dispatch grant. A grant is distinct from the immutable receipt: reading an ownership receipt is never permission to execute.

An exact duplicate reads the existing record and reports ownership without a new grant. A changed invocation, scope, digest, origin, or operation refuses. A lost first grant response remains conservative: the host cannot know whether an attempt became possible, and does not retry execution. Death of an owner does not establish absence of a browser effect. The host retains its current-process active-request guard and records its attempt before native execution.

## Metadata-only completion and acknowledgement

An additive confirmation endpoint accepts a closed version 1 payload containing admission/dispatch/request identities, session/scope/digest, acknowledgement ID, operation, confirmed outcome, and bounded start/finish timestamps. It validates the exact persisted admission and dispatch before exclusively creating an immutable confirmation record.

An identical duplicate returns the original acknowledgement. Changed identity, timing, or outcome refuses. An authenticated exact receipt/read endpoint resolves a lost response without execution. Route definitions and handlers belong in `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts` and `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`; schemas belong in the Kilo browser boundary. Endpoint changes require generated SDK updates.

Current pending requests may still deliver their ordinary full result through the existing reply path. After restart, a historical acknowledgement means **metadata retained**, not that the original model waiter received a result. It must not change an interrupted/error/cancelled tool into success, reopen a turn, fabricate task completion, or dispatch another model request. Cancellation/tool-delivery outcomes and native action confirmation remain separate facts.

Page state and omitted result payloads require a fresh authorized observation with a new request/observation identity. Confirmation must not pretend that a snapshot, screenshot, evaluation result, or original full response has been recovered.

## Capacity and privacy

Reserve capacity before request publication or native dispatch. A proposed maximum is 256 unresolved entries per scope, with a separate bounded global entry count and aggregate byte limit. Global bounds must include retained scopes and terminal records, not just live waiters. Fixed exclusive slot claims, or a scope mutation lock covering capacity and admission, must prevent independent callers from exceeding it; counting followed by unrelated writes is insufficient.

Never evict unresolved admitted/attempted/unknown entries to admit new work. Refuse overflow before effects. Terminal collection requires durable confirmation/acknowledgement and absence of a current waiter; collection cannot make an old posted ID eligible for a new dispatch. An absent admission always refuses a dispatch rather than reconstructing one from caller input. Define terminal retention and cleanup separately from unresolved capacity.

All persisted payloads use closed, bounded schemas with strict identity/timestamp validation. Reject unknown keys, malformed entries, and inconsistent cross-record identities. Do not retain typed input, selector text, URLs or query strings, titles, snapshots, frame contents, screenshots, evaluation output, credentials, authentication/profile state, file/transfer contents, or free-text errors. Opaque tab/frame identifiers are not page contents and must never substitute for a fresh observation or grant authority. Diagnostic output contains fixed classifications and bounded identifiers/digests only.

## Failure and restart behavior

| Boundary | Required behavior |
|---|---|
| Admission/capacity publication fails | No request publication or native dispatch. |
| Admission exists; dispatch claim absent | No inferred execution or success. |
| Dispatch grant response lost | Retain uncertainty; duplicate/read grants no attempt. |
| Native effect is partial or unknown | Preserve unknown and the existing safety fence; no automatic replay. |
| Confirmed effect; completion publication fails | Do not repeat the effect; retain uncertainty about durable acknowledgement. |
| Completion commits; response lost | Exact read/retry returns immutable acknowledgement without execution. |
| Backend restarts | Historical confirmation is read-only evidence; original waiter/model state is not reconstructed. |
| Stop/cancel races with late confirmation | Preserve cancellation and confirmation separately; no new work or turn reopening. |
| Corrupt, oversized, or inconsistent journal | Fail closed before effects; no guessed confirmation or silent unresolved removal. |

## Acceptance and durability limits

Use the real canonical tool, backend HTTP/SSE, host bridge, and a disposable local browser destination. Lose a confirmation response after commit, restart host and backend, then verify one destination mutation, immutable exact acknowledgement, unchanged historical tool outcome, and a separately authorized fresh observation. Test changed retries, unknown partial effects, Stop races, orphan origins, capacity contention, and failed publication. Secret/DOM/iframe/evaluation/image canaries must be absent from journal and diagnostic artifacts.

Existing publication syncs file contents and atomically exposes complete JSON through a hard link. It does not currently establish a directory-sync/power-loss guarantee or a multi-record transaction. Claim only the tested process-kill/restart properties. A later storage change or platform-specific proof is required before claiming power-loss durability. No cross-host dispatch or successful-result convergence is established by this design document.
