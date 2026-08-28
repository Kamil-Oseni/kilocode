<!-- raya_change - evidence-based interaction foundation before Raya's visual self-redesign -->
# Raya Agent UX Foundation

Raya already has most of the machinery expected from a serious coding agent: durable goals, safe-boundary prompt handoff, queued-message cancellation, snapshots and revert, diff review, model and reasoning controls, permission rules, worktrees, background agents, subagent transcripts, and project memory. The present problem is not primarily missing intelligence. It is that related controls are scattered across the goal banner, transcript hover actions, task header, composer, Changes viewer, and Agent Manager. Users should not need to know the architecture to understand what Raya is doing or how to intervene.

The foundation therefore follows one rule: increase autonomy without reducing legibility or reversibility. Progress must come from real tasks and tool activity, not decorative telemetry. Intervention must happen at explicit safe boundaries. Destructive actions must report whether they actually succeeded. Existing capabilities should become discoverable before new mechanisms are invented.

## Evidence from Cursor and Codex

Cursor's current agent documentation treats checkpoints, queued follow-ups, immediate steering, browser verification, and review as one continuous workflow. A queued message waits visibly; a follow-up can steer at the next safe tool boundary; checkpoints restore files without erasing conversation history; and review remains available after the run. See [Cursor Agent](https://cursor.com/docs/agent/overview), [Agent Review](https://cursor.com/docs/agent/agent-review), and the [permissions reference](https://cursor.com/docs/reference/permissions).

Codex makes operational capabilities discoverable through both the composer and slash commands. Its IDE command surface includes `/plan`, `/review`, `/status`, `/side`, `/fork`, `/worktree`, `/ide-context`, model reasoning controls, and cloud delegation. Subagent work remains inspectable and steerable as separate threads while inheriting the parent's permission policy. See [Codex IDE commands](https://developers.openai.com/codex/ide/commands), [Codex subagents](https://developers.openai.com/codex/subagents), and the [Codex configuration reference](https://developers.openai.com/codex/config-reference).

Raya should adapt the interaction contract, not copy either visual language. Cursor is strongest at reversibility and active-run intervention. Codex is strongest at command discoverability, execution-mode clarity, and inspectable delegation. Raya's advantage should be a durable goal control plane that joins these ideas to real todos, routing, voice, local model choice, and explicit cost awareness.

## Missing essentials

These are required before Raya performs the broader visual redesign.

1. **One active-run language.** Sending while Raya is working must say what will happen: the instruction is queued and takes over at the next safe step. Stop remains available at the same time. Goal steering must clearly mean “revise the durable objective for the next continuation,” which is different from a queued conversational follow-up.
2. **Authoritative queue state.** The backend already emits `session.queue.changed`; the webview should consume it rather than infer every queued item from transcript shape. Queued prompts need visible order, cancellation, and eventual edit or reorder support.
3. **Reliable review and rollback.** Review must be scoped to the current goal or turn where possible. Discard must sequence workspace rollback before clearing goal state, must not refill the composer, and must never report success when snapshots are unavailable or the session is still busy.
4. **Discoverable commands and context.** The composer needs direct entry points for commands and `@` context. Existing review, fork, worktree, model, reasoning, memory, export, sandbox, and settings actions should also be reachable by predictable slash commands.
5. **One truthful progress surface.** The current step should come from the in-progress todo or real session status. Goal progress, task todos, working state, and subagent activity should be composed without duplicate timelines, pulsing dots, fake logs, or permanent activity chrome.
6. **Historical model economics.** Users need project-wide tokens and settled cost grouped by provider and model over 24 hours, 7 days, 30 days, and all time. Input, output, reasoning, cache read, and cache write must remain separate. The source of truth is persisted `step-finish` data, not model-selection counts or propagated parent-session totals.
7. **Keyboard and accessibility parity.** Every active-run control must be keyboard reachable, expose its state through ARIA, preserve IME input, respect reduced motion, and remain usable in a narrow sidebar.

## Needed improvements

After the essentials are stable, Raya should add a checkpoint picker in the conversation timeline, edit and reorder for queued prompts, review comments in the sidebar Changes viewer, per-file keep or discard where the diff source can safely revert, explicit Plan and Status commands, an IDE-context toggle, a temporary side-chat command, and direct subagent steering. These should reuse the snapshot, queue, diff, local-tab, and subagent-session systems already present.

Per-hunk acceptance is valuable but is not a superficial button. Raya currently has per-file revert only for worktree-capable diff sources. Hunk-level keep or discard needs a patch-aware mutation contract, stale-diff detection, and tests proving that unrelated edits survive. It belongs after goal-scoped review and file-level safety are correct.

## Nice-to-haves

Lower-priority additions include draggable queue ordering, checkpoint markers on the prompt rail, configurable completion notifications, saved review-depth presets, one-click local-to-worktree promotion, cloud handoff when available, model-budget alerts, daily cost trends, and exportable usage data. They should remain optional and should not add persistent chrome to the default transcript.

## Model usage contract

Historical usage should be read from existing SQLite `step-finish` parts. Each billed step already records provider, model, settled cost, and token buckets. Aggregation must sum those step records directly so child-agent usage is counted once; it must not sum propagated parent message or session cost.

The API accepts a UTC rolling range of `24h`, `7d`, `30d`, or `all` and returns the query boundary, distinct sessions included, totals, and model rows sorted by cost. A zero cost is displayed as zero only when it is known to be free; otherwise the row is marked as cost unavailable. Deleted sessions are excluded because their persisted parts are deleted. The first implementation queries existing data without a second write path; daily rollups are introduced only if measured database size makes all-time queries too slow.

The tracker should be reachable from the task header's existing token and cost summary. Its default view ranks models by cost, while alternate sorting exposes total tokens and recent activity. The range selector must preserve the user's last choice and localize timestamps without changing the UTC query boundaries.

## Delivery order

The safest sequence is:

1. Correct goal-scoped review and ordered discard.
2. Surface real queue and safe-boundary semantics in the composer.
3. Add command and context discovery plus Status, Fork, and Worktree shortcuts.
4. Consolidate current-step, todo, and subagent progress.
5. Add the project usage endpoint and historical tracker.
6. Extend the preview harness and browser smoke coverage for every new state.
7. Run extension compile, focused runtime tests, SDK generation checks, marker checks, accessibility checks, and the named visual smoke runs.

This foundation is complete only when the controls operate against the real runtime, failure states are visible, rollback cannot silently clear its own evidence, historical totals match persisted step data, and the running VS Code extension demonstrates the flows without relying on hidden commands or tribal knowledge.
