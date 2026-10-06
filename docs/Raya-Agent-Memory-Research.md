# Agent Memory Repo: adoption study for Raya

Reviewed 2026-10-06. Recommendation: adopt the compact linked-memory format and add a bounded consolidation worker that proposes memory updates and evidence-backed self-heal lessons. This is a design proposal; automatic capture, scheduled Dreaming and repair execution were not enabled.

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
