# Raya portable capture writer audit

ChatGPT read-only source audit: **2026-09-30 07:43 EDT / 11:43 UTC**. This document records the source state during durable composer bridge validation. No production code, live profile, desktop, runtime tests or dependencies were changed by this audit. Ship and verify the current composer bridge before starting this work.

## Requirement and current decision

[FUT-DATA-01 in the implementation progress document](Raya-Implementation-Progress.md) requires durable chats, workers/specialists, drafts, organizations, Routines, schedules, memory and terminal receipts across restarts and reinstall; consistent versioned encrypted backup; integrity and bounded-path validation; atomic restore into a new profile; workspace remapping and credential reconnection; imported automation held for explicit review; and no replay of uncertain effects or source-device authority. Verify restored state on a second profile/PC and later client without duplicate automation.

**Portable capture remains refused.** The production [writer manifest](../packages/opencode/src/kilocode/migration/writer-manifest.ts) has 32 writer boundaries: 11 integrated, 16 declared-unintegrated and 5 uncertain. `complete` remains false and its gaps remain authoritative. Integrated means the declared boundary participates in its existing admission mechanism; it does not establish all-process or complete-profile coverage. Do not close this gate by excluding inconvenient writers or changing classifications without implementation evidence.

Credentials must not appear in the portable bundle. Credential writers still participate in admission and drain: excluding a file from the output does not prove the containing profile is quiescent. Reconnect providers/MCP credentials on the destination; never import source device leases, live process ownership or authority to resume effects.

## Authoritative writer inventory

Paths below are repository-relative. The manifest supplies each boundary's full methods, lifecycle and copy policy; this table preserves its exact current classifications and representative source boundaries.

| Writer ID | Classification | Roots | Sources |
|---|---|---|---|
| `profile.bin.language-servers` | declared-unintegrated | bin | `packages/opencode/src/lsp/server.ts` |
| `profile.bin.ripgrep` | declared-unintegrated | bin | `packages/core/src/ripgrep/binary.ts` |
| `profile.bootstrap.roots` | uncertain | data, state, config, bin, log, tmp, repos | `packages/core/src/global.ts`; `packages/core/src/kilocode/{global,spotlight}.ts` |
| `profile.cache.browser-uploads` | integrated | cache | `packages/opencode/src/kilocode/browser/upload-stage.ts` |
| `profile.cache.models` | declared-unintegrated | cache | `packages/core/src/models-dev.ts` |
| `profile.cache.skills` | declared-unintegrated | cache | `packages/{core,opencode}/src/skill/discovery.ts` |
| `profile.config.global` | uncertain | config | OpenCode CLI agent/MCP/plugin commands, config, plugin install/TUI runtime; `packages/opencode/src/kilocode/{agent/builder,config/config,config/overlay,tui/config}.ts` |
| `profile.credentials.auth` | integrated | data | `packages/opencode/src/auth/index.ts` |
| `profile.credentials.mcp` | integrated | data | `packages/opencode/src/mcp/auth.ts` |
| `profile.data.memory` | declared-unintegrated | data | `packages/opencode/src/kilocode/memory/runtime.ts`; `packages/kilo-memory/src/storage/paths.ts` |
| `profile.data.plans` | uncertain | data | `packages/opencode/src/session/session.ts`; `packages/opencode/src/kilocode/plan-artifact.ts` |
| `profile.data.repos` | declared-unintegrated | repos, state | `packages/core/src/{git,repository-cache}.ts` |
| `profile.data.revert-note` | integrated | data | `packages/opencode/src/kilocode/session/revert-note.ts` |
| `profile.data.self-heal` | declared-unintegrated | data | `packages/opencode/src/kilocode/self-heal/{artifact,completion,index,publication,repair,snapshot,verification,worktree}.ts` |
| `profile.data.session-export` | declared-unintegrated | data | `packages/opencode/src/kilocode/session-export/{sequence,session-export,workspace-provider}.ts`; `worker/storage.ts` |
| `profile.data.snapshots` | declared-unintegrated | data | `packages/opencode/src/snapshot/index.ts` |
| `profile.data.tool-output` | integrated | data | `packages/opencode/src/tool/{truncate,truncation-dir}.ts` |
| `profile.data.worktrees` | declared-unintegrated | data | `packages/opencode/src/worktree/index.ts` |
| `profile.log.diagnostics` | integrated | log | OpenCode CLI run trace, TUI, heap and TUI worker; `packages/opencode/src/kilocode/cli/heap-snapshot.ts` |
| `profile.log.runtime` | declared-unintegrated | log | `packages/core/src/{observability/logging,util/log}.ts` |
| `profile.sqlite.primary.effect` | declared-unintegrated | data | `packages/core/src/database/{database,migration}.ts`; `packages/core/src/kilocode/{database-compat,migration-backup}.ts` |
| `profile.sqlite.primary.legacy` | declared-unintegrated | data | `packages/opencode/src/storage/db.ts` |
| `profile.state.background-process` | declared-unintegrated | state, log | `packages/opencode/src/kilocode/background-process/index.ts` |
| `profile.state.daemon` | declared-unintegrated | state, log | `packages/opencode/src/kilocode/daemon/daemon.ts` |
| `profile.state.indexing` | declared-unintegrated | state | `packages/opencode/src/kilocode/{indexing-worker,indexing,lancedb}.ts` |
| `profile.state.model` | uncertain | state | JetBrains `KiloBackendModelStateManager.kt`; VS Code `src/kilo-provider/model-state.ts`; CLI `run/variant.shared.ts`; `src/kilocode/config/model-state.ts`; TUI `src/context/local.tsx` |
| `profile.state.plugin-meta` | integrated | state | `packages/opencode/src/plugin/meta.ts` |
| `profile.state.sandbox-policy` | integrated | state-parent | `packages/opencode/src/kilocode/sandbox/store.ts` |
| `profile.state.sandbox-preference` | integrated | state-parent | `packages/opencode/src/kilocode/sandbox/preference.ts` |
| `profile.state.tui-kv` | uncertain | state | `packages/tui/src/{context/kv.tsx,util/persistence.ts}` |
| `profile.storage.json` | integrated | data | `packages/opencode/src/storage/storage.ts` |
| `profile.tmp.attachments` | integrated | tmp | `packages/opencode/src/kilocode/remote-attachments.ts` |

Keep the two manifest maintenance entries separate: legacy JSON-to-SQL migration is exclusive maintenance; uninstall is exclusive destructive maintenance. Neither is an ordinary writer that may reopen admission after successful destructive work.

## Source findings and ownership limits

- [Writer live registry](../packages/opencode/src/kilocode/migration/writer-live.ts), lines 11–19, automatically registers only integrated boundaries and exports a snapshot, not a production capture controller. [Registry](../packages/opencode/src/kilocode/migration/writer-registry.ts), lines 47–50 and 125–141, refuses incomplete coverage/registration before invoking maintenance. It is process-local; compiled service graphs and other clients need their own coordinated admission.
- [Profile maintenance](../packages/core/src/kilocode/profile-maintenance.ts), lines 228–259, coordinates cooperating primary SQLite/JSON participants only. Portable intent is rejected before the callback, and receipts say `completeProfileCoverage: false` and `portableCaptureAuthorized: false`. Admission/drain has a bounded deadline; callback settlement is not given a false overall deadline guarantee.
- [Native SQLite boundary](../packages/core/src/kilocode/profile-sqlite.ts) and [JSON boundary](../packages/opencode/src/kilocode/migration/storage-admission.ts) now protect actual operations in cooperating builds, including transactions/iterators and lazy JSON migration. This is narrower than complete manifest registration and lifecycle/cutover integration; the manifest's two primary SQLite classifications must not be changed mechanically.
- [Core migration](../packages/core/src/database/migration.ts), lines 75–79, captures its [SQL recovery archive](../packages/core/src/kilocode/migration-backup.ts) inside the same immediate transaction as a destructive upgrade. It preserves that database's older schema and exact SQL values. It does not snapshot JSON, memory, files, client state or another SQLite database. The [backup command](../packages/opencode/src/kilocode/cli/cmd/db-backups.ts) exports this historical SQL archive into a new file, not an encrypted personal-profile bundle.
- [Extension server disposal](../packages/kilo-vscode/src/services/cli-backend/server-manager.ts), lines 313–336, sends termination and returns immediately; its later force-kill timer is not an awaited exit receipt. Its managed child identity is useful evidence but cannot prove independently launched CLI/daemon/worker/JetBrains processes stopped. Unknown or older writers must cause refusal, not be silently killed or assumed absent.
- [Memory runtime](../packages/opencode/src/kilocode/memory/runtime.ts), lines 14–23, installs paths/events once. A path-generation change needs drained memory services and explicit disposal/reconfiguration; rebinding Global alone is insufficient.
- [Transfer hold](../packages/opencode/src/kilocode/task/hold.ts), lines 52–54, explicitly requires retiring/draining source work before arming it, or arming before destination startup. It prevents new work; it does not cancel effects already inside a model or OS call. Full capture needs authoritative queued/backlog/uncertain-effect seals as well as this hold.
- Preserve the manifest's unresolved generic shell/process access, injected/external roots, command saves/removals, independent Core service graphs and direct JetBrains writes. New admissions must cover actual resolved roots and child-process/finalizer lifetime, not just the apparent caller function.

## Next complete production boundary: session export

**2026-09-30 14:55 EDT update:** The worker drain/close race and parent false-success shutdown in points 1–3 below were repaired in commit `832161175c50c94080ec833c40478e72985057ab` and tested with a real worker/private SQLite plus wrong-ID/timeout parent refusals. The remaining sequence/worker store admission, failed-envelope retention, detached workspace work, shared state publication and cross-process proof in point 4 and the following audit are still open. The writer remains declared-unintegrated and portable capture remains refused. The numbered findings below describe the pre-fix source state and are retained to explain the requirement.

**2026-09-30 15:04 EDT update:** A later source guard refuses a second workspace's different raw `dbPath` before the first worker is changed; the first worker continues serving its workspace in a focused regression. This is not a canonical resolved-path or cross-process identity proof. The shared workspace state publication and remaining writer boundaries are still open.

There is a concrete shutdown defect to address before treating session export as drained:

1. [Worker `drain()`](../packages/opencode/src/kilocode/session-export/worker.ts), line 30, returns immediately if another drain is active. The active drain awaits `handleEvent` while processing its batch.
2. Worker shutdown, lines 107–119, awaits this non-joining drain, then closes storage. An earlier awaited event handler can resume against the closed store. A close acknowledgement therefore needs to join the exact active drain promise and prevent new intake/flush work first.
3. [Parent shutdown](../packages/opencode/src/kilocode/session-export/session-export.ts), lines 126–140, resolves identically for timeout and `shutdown_done`, then terminates the worker. Its successful return cannot distinguish confirmed drain from timeout.
4. [Parent sequence store](../packages/opencode/src/kilocode/session-export/sequence.ts), line 4, and [worker storage](../packages/opencode/src/kilocode/session-export/worker/storage.ts), line 43, open separate SQLite handles outside the primary SQLite boundary. Include their initialization, writes, transactions and close, plus all resolved workspace destinations.

Implement closed intake, a joinable drain, bounded correlated confirmed/refused shutdown receipts, exact handle closure and cross-process admission for both stores and their worker/parent lifetimes. Preserve queued evidence on failure. This closes one real production writer boundary; it must not claim complete portable transfer or weaken the global refusal.

### ChatGPT 2026-09-30 08:46 EDT - connected export lifecycle and destination audit

Further read-only inspection confirms the boundary includes more than the worker drain. `session-export.ts:35` keeps export disabled by default; preserve that behavior. Shutdown unsubscribes, but direct capture calls and respawn have no stopping epoch. Close intake before unsubscribe, fence initialization/capture/respawn, and make concurrent shutdown callers join the same correlated operation. `workspace-fiber.ts:107–118` detaches eventual snapshot completion after its timeout; joining the timeout winner does not join that writer. Track baseline, eventual completion, delta and workspace scan work, including exact Git child exit.

`kilocode/bootstrap.ts:170–172` gives workspace providers one shared `session-export-workspace.json`, while `workspace-provider.ts:20,34,46,130–133` loads independent in-memory state and writes it wholesale. Multiple workspaces can overwrite another provider's records. Replace stale whole-document publication with an admitted, serialized merge/CAS contract that preserves every workspace. Validate shared worker database identity before accepting another initialization: `session-export.ts` can currently keep the first worker database while creating a later sequencer for a different `dbPath`.

`capture.ts:126,170,211,336` advances sequence before posting an envelope; failed IPC only invokes the error callback. `worker.ts:38–55` catches handler failure after draining the batch without retaining its envelope. Persist pending envelopes until exact correlated persisted receipts; preserve unresolved work on failure and refuse confirmed capture while any remains. A forced worker termination must never certify successful quiescence. Stop upload scheduling and join or abort-and-join active upload work before closing its storage.

Acceptance uses a real Bun worker, private SQLite, loopback upload server, private Git repository and independent writer process. Add blocked drain/upload, late baseline completion, shutdown correlation, intake/respawn denial while stopping, failed-envelope recovery, different database refusal, two-workspace publication without loss, resolved alias admission, exact handle closure and restart sequence continuity. Existing fake-worker respawn tests cannot establish these guarantees. Keep the manifest boundary unintegrated until connected production acceptance passes.

## Implementation order for the full transfer

1. Ship and verify durable composer hydrate/save/promote/accepted-send behavior. Export needs acknowledged flush from every registered main and Agent Manager composer, retained pending identities and a rechecked generation/sequence fence. A process-local composer flush is not a profile writer drain.
2. Fix and integrate session-export shutdown above. Then implement actual admission/lifecycle adapters for all remaining manifest boundaries, including background/daemon/indexing children, memory, config/client state, Git/installer children and both logger systems. Integrate initialization and exclusive maintenance too. Test the full inventory and independently compiled graphs; keep uncertain/older/unowned writers fail-closed.
3. Add a host-owned source controller: canonicalize actual roots without bootstrapping a writer, close new admission, retire work and await exact owned exits/drains, seal authoritative backlog and uncertain effects, then acquire a complete cross-process capture proof. Revalidate ownership after waits and before publication. Never manufacture completeness from an empty registry, PID scan or stale heartbeat.
4. Capture consistent typed SQL and allowlisted JSON/files under that proof. Authenticate a versioned, bounded encrypted bundle and manifest; validate paths, byte/count limits, schema/version, digests and referential integrity. Prevent path traversal, symlink/reparse escape and partial publication. Keep source authority/credentials out while retaining identities and references required to interpret evidence.
5. Restore into an isolated staging profile, validate before publication, remap workspaces, arm a durable destination hold before any runner starts, and atomically publish a new profile. Reconnect credentials and require explicit destination review. Neither import failure nor startup may silently reset initialized data or resume source work.

## Required acceptance and current test boundaries

Use actual implementation and independent processes, not replicas of gate logic. Existing [native SQLite tests](../packages/core/test/kilocode/profile-sqlite.test.ts) cover real Bun/Node adapters, transactions/savepoints, prepared iterators, WAL peers and crashed-owner recovery. [Profile maintenance tests](../packages/core/test/kilocode/profile-maintenance.test.ts) cover cooperating root admission and refusal; [migration backup tests](../packages/core/test/kilocode/migration-backup.test.ts) cover exact historical SQL recovery. [Manifest/registry tests](../packages/opencode/test/kilocode/migration-writer-manifest.test.ts) enforce the incomplete gate. These narrower checks do not prove whole-profile consistency; this audit did not rerun them.

Acceptance must additionally prove:

- Real session-export work paused mid-event cannot be closed early; late intake is refused; timeout/lost acknowledgement never produces a false confirmed drain; retained rows survive reopening.
- Every real included writer and initialization path joins capture admission. Late startup, delayed child/finalizer writes, alternate roots, aliases, other clients, older/unowned processes and detached workers cannot publish during capture. Live or uncertain ownership is never reclaimed merely because a heartbeat is stale; aborted capture cannot publish a valid bundle.
- A simultaneous SQL/JSON/file consistency fixture restores one coherent generation with intact chats, worker identity, organizations, schedules, drafts, memory, terminal receipts and authoritative backlog/effect seals. Include independent writers and actual worker databases, not only primary SQL and JSON.
- Wrong keys, tampering, malformed/oversized entries, path escapes, corrupt references, unsupported versions and interruption fail before destination activation; the source and existing destination remain intact.
- A fresh second profile/PC and later client load the restored state under the hold. Completed/question-waiting workers and overdue schedules remain inactive; source device leases and uncertain effects never replay; explicit review releases only the reviewed destination generation.

No full-capture readiness increase is justified by this audit or by closing the session-export boundary alone.
