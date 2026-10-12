# Raya current readiness

Updated October 12, 2026 from the installed registry, current Git delivery, saved installation receipts and read-only runtime checks. This is the current handoff; dated trial details belong in the history.

## Installed now

Everyday Raya is **`7.4.23-snapshot+f3a3aa4df9.local.1791823909482`**, built from `f3a3aa4df9e39f4979010357aefcdbaad2d2642d`. The installed registry was independently read after delivery. Main and the consolidation branch include this release and its delivery documentation; the current documentation checkpoint is `5ea449a666`.

| Area | Current status | Remaining scope |
|---|---|---|
| Routine conversation reports | Installed: one saved card per occurrence, selectable ordinary workspace conversation, worker link and persistent long-wait notice | Ordinary installed workflow, actual enabled runs and restart behaviour on this release |
| Routine scheduling choices | Installed: skip or queue one busy occurrence; skip or run the latest missed occurrence once | Installed acceptance; no blanket replay or recovery guarantee |
| Conversation Memory | Setup, management and scoped retrieval source improvements are installed; capture preference is enabled | Actual native recovery exposed an omitted helper recipe. Verified source fix awaits installation; supported closed-pair recovery and live save/recall remain required |
| Voice | Source improvements are present in the installed package | User explicitly deferred voice; no fresh microphone, audible continuity or hands-free acceptance |
| Recovery | Closed installation preserved saved data; protected rollback copy verified | Live restore, full local-service recovery and actual Windows postboot acceptance |
| Models, tools and context | Earlier model comparisons and targeted context fixes have evidence | Candidate-specific everyday General/Coder/tool acceptance; historical model trials do not qualify every current workflow |

The full roadmap remains in [Raya-Implementation-Progress.md](Raya-Implementation-Progress.md) and [Raya-Local-Readiness-Gates.md](Raya-Local-Readiness-Gates.md). This page does not reduce that scope. The retained **48/100** and **38 unfinished requirements** are historical formal bookkeeping, not a measured completion percentage for this installation or an ETA.

## What was verified

- The official installer exited successfully. Closed comparison preserved **2,892 saved files**, their listed folder structure, **538 non-package payloads**, and unrelated extension registrations.
- Backend checks cover bounded scheduling policies, queue identities/leases, destination binding, monotonic report updates, waiting-notice deduplication and publication scope. UI/host checks cover real controls, SDK transport and the repaired refresh race.
- Production host/webview types, lint, bundle and Knip passed. The qualified CLI and archive match their source inputs. Normal Git delivery passed its unchanged pre-push gates.
- A permanent rollback copy at `D:/RayaBackups/Everyday-routines-20261012-ce50c5684e5342139cbc317fd4804ad4` matches all **2,897 source files / 1,913,355,083 bytes** by path, length and SHA-256. Its copy receipt SHA-256 is `77eb69c2c7f6996d734819c5ca5dc2b1805705e2d93cd545e49b91b62e1762c3`.

These checks establish source/component correctness and closed installation preservation. They do not establish loaded GUI, ordinary-profile routine execution, live Memory use or human voice acceptance. Original compiler/package cleanup failures remain separately recorded in the implementation journal; successful artifacts do not turn those lifecycle failures into passes.

## Next work

1. Build chat: verify the installed routine-report API and cold reopening in a private profile, preserving occurrence identity and checking that no work replays. Run a small model-backed case only where it supplies missing evidence.
2. Setup chat: complete supported closed-pair recovery for the currently selected Memory pair, then verify conversation saving and recall. The October 12 read-only check found no separate pending uncertainty entry; historical audits remain retained. Do not substitute older fresh-start plans from another managed container.
3. User: reopen Raya and try the routine workflow. The [routine guide](Raya-Routine-Conversation-Reports.md) explains the chat-header reports control, report destination and scheduling choices. Human listening remains deferred until requested.

## Constraints observed now

At the read-only check, Code/kilo were absent, Ollama's resident-model list was empty, and Home Assistant's VM was **powered off intentionally**. Do not treat that as an outage or restart it without a new request. Do not change lights, microphone state, or protected user applications for acceptance work. Second-PC migration and Raya's cloud-worker work remain canceled/released. Current peer/subagent coordination is authorized.

Keep original notes, capture policy, credentials, grants and uncertain operation receipts. Do not silently enable capture, clear debt or reinterpret a failed trial as successful. Repeat a passed check only after relevant changes, a failure, or a concrete unresolved requirement.

The current saved Memory container is `raya-memory-managed-ec734ff345644fc6b1f13257270c2f46`, run `f4a1448cc1bbbecc79c1dad70f654155`, ports 53676/53677. The actual `closed-recovery.review()` and `absent()` accepted its original pair references, exact closure and present producer/listener absence without starting services or modifying the profile. Closed receipt SHA-256: `044a98dc28fbf84e9467007b5aa1444620249ea080523ba4509830d5b9c9e05f`. The installed package exposes **Raya: Recover a Closed Memory Pair**. This establishes recovery eligibility, not publication, startup, capture success or downstream family settlement.

## History

The previous 124,492-byte readiness page is preserved byte-for-byte in [Raya-Readiness-Journal-20261012.md](Raya-Readiness-Journal-20261012.md), SHA-256 `3054b9c88cffb841dc8705652966105a4252c56fe027bc4e99c69e2657458d9f`. Earlier material also remains in [Raya-Readiness-History.md](Raya-Readiness-History.md). Historical active-version, VM-state and pending-build statements are not current instructions.
