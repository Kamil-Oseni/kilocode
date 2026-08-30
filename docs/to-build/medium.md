# To Build — Medium

New backend surface, but built on top of the existing goal runtime, subagent/task system, plugin hooks, and canvas. More moving parts than the easy tier, but no cloud infrastructure.

Each plan is written so any agent can pick it up cold. File paths are relative to the repo root. Mark edits to shared opencode files with `kilocode_change` / `raya_change`; files under `packages/kilo-vscode/` and `packages/opencode/src/kilocode/` need no markers. When adding a storage-backed feature with an HTTP endpoint, follow the checkpoint template (see the checklist at the end of the "Scheduled agents" plan) and regenerate the SDK with `./script/generate.ts` from the repo root.

---

## 1. True per-hunk (line-range) undo

**Goal.** Let the user undo only selected changed lines in a file while leaving the file's other hunks in place. Moved here from `easy.md` feature 2 because it requires a new backend capability, not just UI. Source: Copilot/Cursor per-chunk accept-reject.

**What already exists.** Display-side hunk parsing is done: `packages/kilo-vscode/src/edit-review/patch-ranges.ts` (`addedRanges(patch): LineRange[]`) and the CodeLens/decoration layer in `packages/kilo-vscode/src/edit-review/InEditorReview.ts`. The webview message is `discardSessionChanges` (`packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts`, `DiscardSessionChangesRequest` with `files?: string[]`), routed through `KiloProvider.handleCheckpointMessage` (~line 1717) to `handleDiscardSessionChanges` (~line 4436), which calls `client.session.discardChanges({ sessionID, directory, files })`. On the backend, `SessionRevert.discardChanges` (`packages/opencode/src/session/revert.ts`, ~line 165) and `KiloSessionRevert.discardAll(snap, messages, only?)` (`packages/opencode/src/kilocode/session/revert.ts`) both operate at **file** granularity by matching patch parts by path; `Snapshot.revert` restores whole files from patch hashes (`packages/opencode/src/snapshot/index.ts`).

**Why it's medium, not easy.** The snapshot system restores whole files from git blob hashes; it has no concept of "revert lines 10–14 only." A correct implementation must reconstruct the file as "current content minus the selected hunks" without desyncing the session's snapshot bookkeeping (which later Keep all / Undo all and goal discard rely on).

**Implementation steps.**
1. Extend the protocol: add an optional `ranges?: { file: string; start: number; end: number }[]` to `DiscardSessionChangesRequest` and thread it through `KiloProvider.handleCheckpointMessage` → `handleDiscardSessionChanges`.
2. Add a backend range-revert path. Preferred approach that stays consistent with snapshots: in `packages/opencode/src/kilocode/session/revert.ts`, add a `discardRanges` that (a) reads the pre-edit content for the file from the relevant snapshot/patch part, (b) computes a merged file = current file with only the selected new-side ranges reverted to their pre-edit counterparts (reuse the unified-diff hunks already stored in the `patch` part rather than re-diffing), and (c) writes the merged file through the same path `discardAll` uses so snapshot state stays coherent. Do **not** apply inverse hunks purely in the extension host — that path bypasses snapshot bookkeeping and will desync Keep/Undo all.
3. Expose it: either add an optional `ranges` field to the existing `discard_changes` HTTP route (`packages/opencode/src/server/routes/instance/httpapi/`), or add a dedicated kilocode endpoint following the checkpoint template. Regenerate the SDK.
4. Wire the UI: in `InEditorReview.ts`, add per-hunk CodeLens actions (`raya.editReview.undoHunk`) that post `discardSessionChanges` with the specific `ranges`. Refresh via the existing `scheduleReview` → `inEditorReview.refresh()` path.

**Acceptance criteria.** Undoing one hunk reverts only those lines; other hunks in the same file remain; a subsequent Keep all / Undo all and goal discard behave correctly (no orphaned or double-reverted state); works in a git and a non-git workspace (snapshots already run in a private git dir per the earlier non-git fix).

**Risk / escalation.** If keeping snapshot bookkeeping coherent for partial reverts proves intractable, escalate this to `hard.md` and reconsider — a partial-file revert that corrupts the snapshot chain is worse than no per-hunk undo.

---

## 2. Scheduled / recurring agents

**Goal.** A standing assignment ("remind me every day to do X", "review the repo every weekend") that wakes on a schedule, spawns a background run against a saved objective, records the outcome, and sleeps again — without idle token burn between wakeups. Full design already written in `docs/Raya-Scheduled-Agents-Plan.md`; this is the code-level plan. Source: Cursor Automations, Claude Code cron.

**What already exists.** The goal runtime is the reusable core: `packages/opencode/src/kilocode/goal/index.ts` (`RayaGoal.make` → durable state under Storage key `["raya", "goal", sessionID]`, completion audit, blocked/paused states) and `packages/opencode/src/kilocode/goal/continuation.ts` (`RayaGoalContinuation.subscribe` + `continueGoal`, which calls `SessionPrompt.prompt` with a synthetic turn and `goalObjective`). Sessions are created via `Session.create` (`packages/opencode/src/session/session.ts`), and a run can be driven headlessly through `session.promptAsync` (see `packages/opencode/src/cli/cmd/run.ts` for the non-interactive loop that exits on idle). Durable state uses `Storage.Interface` (`packages/opencode/src/storage/storage.ts`). Event-driven behavior is wired in `packages/opencode/src/kilocode/bootstrap.ts` (where goal continuation subscribes to `KiloSession.Event.TurnClose`). There is a background-jobs concept already: `GET /kilocode/background-jobs` and cancel endpoints in `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts`.

**Implementation steps.**
1. **Task store** (namespace module) — create `packages/opencode/src/kilocode/task/index.ts` following the checkpoint template (`packages/opencode/src/kilocode/checkpoint/index.ts`). Define a `RayaTask` schema: `id`, `objective`, `schedule` (union of `{ kind: "once"; at: number }` | `{ kind: "cron"; expr: string }` | `{ kind: "event"; source: string }`), `agent`, `enabled`, `lastRun?`, `nextRun?`, and a bounded `runs` history (`{ at, sessionID, outcome, cost }`). Store under a global key `["raya", "task"]` (not per-session — tasks outlive sessions).
2. **Scheduler loop** — a single long-lived Effect fiber owned by the backend, subscribed/started in `packages/opencode/src/kilocode/bootstrap.ts`. Tick coarse (every 60s). On each tick: read all enabled tasks, recompute `nextRun` from stored schedules (never trust an in-memory timer — recompute on startup for restart resilience), and hand due tasks to the runner. Skip any task whose previous run is still active (no overlap). Use a well-known cron library for `cron` schedules; do the plain-English → cron translation client-side in the create form.
3. **Runner** — turn a fired task into work by reusing the goal machinery: open a session (`Session.create`, no foreground reveal), seed it exactly like `/goal` arming (`RayaGoal.create` + a synthetic objective turn, mirroring `continueGoal` in `goal/continuation.ts`), let the existing continuation loop drive it to complete/blocked, then record the outcome + cited evidence back onto the task's `runs` and close. Add a lightweight "notify" outcome for reminder-style tasks that resolve to a message rather than code work.
4. **HTTP + tools** — add `RayaTask` endpoints (list/create/update/enable/runNow/history) to `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts` + `handlers/kilocode.ts`; regenerate the SDK. Optionally add a model-facing `schedule_task` tool in `packages/opencode/src/kilocode/tool/` (registered in `tool/registry.ts`) so agents can create tasks.
5. **UI** — a Raya settings/panel surface listing tasks with next-run times, a create/edit form, enable/disable toggle, per-task run history with cost, and a manual "Run now" button.

**Guardrails (from the plan doc — not optional).** Owner-visible enabled flag; each run inherits the goal system's step/continuation caps so it can't loop forever; forbid overlapping runs of the same task; surface cost per run; auto-disable a task after N consecutive same-reason blocks and report why.

**Recommended build order (from the plan doc).** (1) Task store + "Run now" with no scheduler, to prove a stored definition can seed a background goal run — this is the riskiest integration. (2) Scheduler with one-shot times only. (3) Cron recurrence + plain-English translation. (4) Reminder/notify outcome. (5) Event triggers last.

**Acceptance criteria.** A task defined with a one-shot time fires once at that time, runs a goal to completion/blocked in a background session, and records the outcome; a cron task fires on schedule; disabling a task stops it; overlapping runs are skipped; restart recomputes next-run correctly; costs are visible per run.

**Checklist — adding a storage-backed kilocode feature + HTTP endpoint (reusable for all medium features below).**
1. Namespace module under `packages/opencode/src/kilocode/<feature>/index.ts`: Effect `Schema` types, `make(deps)` returning Effect functions, stable storage key, handle `Storage.NotFoundError` on first read.
2. Route contracts in `packages/opencode/src/kilocode/server/httpapi/groups/kilocode.ts` (paths + `HttpApiEndpoint` entries with `identifier: "kilocode.<feature>.<action>"`).
3. Handlers in `packages/opencode/src/kilocode/server/httpapi/handlers/kilocode.ts` (`make({ storage, ... })`, map domain errors to `HttpApiError.*`, `.handle(...)`).
4. Ensure the group is registered (`packages/opencode/src/server/routes/instance/httpapi/api.ts` + `packages/opencode/src/kilocode/server/httpapi/server.ts`).
5. Regenerate the SDK: `./script/generate.ts` from repo root.
6. Optional model tool in `packages/opencode/src/kilocode/tool/` + `tool/registry.ts`.
7. Optional bootstrap subscriber in `packages/opencode/src/kilocode/bootstrap.ts`.
8. Tests in `packages/opencode/test/kilocode/`.

---

## 3. Richer subagent frontmatter

**Goal.** Let agent markdown files (like `docs/designer.md`) declare `disallowedTools`, `permissionMode`, `memory`, `background`, and `isolation`, so specialists are configured declaratively rather than only through the current `permission` map. Source: Claude Code subagents.

**What already exists.** Agent `.md` files are globbed and parsed in `packages/opencode/src/config/agent.ts` (`ConfigAgent.load` / `loadMode`), with frontmatter parsed by `gray-matter` in `packages/opencode/src/config/markdown.ts`. The frontmatter schema is `ConfigAgentV1.Info` in `packages/core/src/v1/config/agent.ts` — currently supporting `description`, `mode`, `model`, `variant`, `temperature`, `top_p`, `prompt`, `permission`, `tools` (deprecated → normalized into `permission`), `steps`/`maxSteps`, `disable`, `hidden`, `color`, `displayName`, `source`, `options`. Runtime merge into live agents happens in `packages/opencode/src/agent/agent.ts` (~lines 351–388). Subagent tool/permission scoping is in `packages/opencode/src/kilocode/tool/task.ts` (`KiloTask.inherited`, `KiloTask.permissions`) and `packages/opencode/src/agent/subagent-permissions.ts` (`deriveSubagentSessionPermission`). Note there is **no `permissionMode` enum today** — `plan`/`ask`/`architect` are agent *names* hardened by `planGuard`/`askGuard`/`hardenPlan` in `packages/opencode/src/kilocode/agent/index.ts`; and `guarded` (same file) lists mutation tools read-only modes can never regain.

**Implementation steps.**
1. Extend the schema in `packages/core/src/v1/config/agent.ts` (`AgentSchema`): add optional `disallowedTools` (record or string[] → normalized to `permission` denies, mirroring the existing `tools` normalization loop at ~lines 87–100), `permissionMode` (literal enum, see step 3), `memory` (e.g. `"none" | "session" | "project"`), `background` (boolean), `isolation` (e.g. `"none" | "worktree"`). Keep them optional so existing agents are unaffected.
2. Thread new fields through `Agent.Info` in `packages/opencode/src/agent/agent.ts` and the merge loop; for `disallowedTools`, fold into `item.permission` via `Permission.merge` at load time so enforcement reuses the existing permission engine.
3. Map `permissionMode` to existing guards rather than inventing a parallel system: `"plan"` → apply `planGuard`; `"acceptEdits"` → allow `edit`/`write`; `"bypass"` → `Permission.allowEverything`-equivalent for that agent; `"default"` → no change. Do this in the merge loop next to the existing `hardenPlan`/`hardenExplore` calls.
4. Honor `background` in the `task` tool (`packages/opencode/src/tool/task.ts` / `packages/opencode/src/kilocode/tool/task.ts`): route background subagents to the existing background-jobs path instead of blocking the parent turn. Honor `isolation: "worktree"` by creating the child session bound to a fresh worktree (reuse the Agent Manager worktree creation described in `hard.md`); if worktree infra isn't wired for backend-initiated runs yet, treat `worktree` as a no-op with a logged warning and defer.
5. Honor `memory` by scoping any persisted subagent memory store to session vs project (a small storage-backed map keyed accordingly); if no memory store exists, this field is a forward-declaration — validate and store it but no-op until a memory feature lands.

**Acceptance criteria.** An agent `.md` with the new fields loads without frontmatter errors; `disallowedTools` actually denies those tools at runtime; `permissionMode: "plan"` produces the same restrictions as the built-in plan agent; unknown/omitted fields keep current behavior; `docs/designer.md` still loads. Add tests under `packages/opencode/test/` covering normalization.

**Notes.** `background`, `isolation`, and `memory` can ship as validated-but-partially-enforced first (schema + storage) and be fully wired incrementally; `disallowedTools` and `permissionMode` are the high-value, fully-enforceable wins to prioritize.

---

## 4. Deterministic lifecycle hooks

**Goal.** Productize hooks as first-class, user-configurable lifecycle handlers — `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, a `Stop` completion-gate, and `PermissionRequest` — that can run shell commands / HTTP calls and influence execution (block, modify, force-continue). Source: Claude Code hooks.

**What already exists.** There is a plugin hook interface in `packages/plugin/src/index.ts` with `tool.execute.before` / `tool.execute.after` (and `permission.ask`, which is **defined but not invoked at runtime**). Dispatch is `Plugin.trigger(name, input, output)` in `packages/opencode/src/plugin/index.ts` (sequential, mutates `output` in place). The strongest runtime attachment points: `tool.execute.before`/`after` already fire in `packages/opencode/src/session/tools.ts` (~lines 168–192) around every tool call, and again in `packages/opencode/src/session/prompt.ts` (~lines 409–413) for the task tool. Session/subagent lifecycle events exist but there are **no dedicated subagent-start/stop hooks**: `session.created` (`packages/opencode/src/session/session.ts` ~line 663), `session.turn.open`/`session.turn.close` (`packages/opencode/src/kilocode/session/event.ts`, published from `session/prompt.ts`), and `permission.asked`/`permission.replied` via the permission service. Config uses a `plugin` array (`packages/opencode/src/config/config.ts`), not a `hooks` block.

**Implementation steps.**
1. Define the hook config surface. Add a `hooks` section to config (`packages/opencode/src/config/config.ts`, marked `kilocode_change`, and mirror the schema in the cloud repo per AGENTS.md) mapping event names → an array of `{ command | url; matcher?; blocking?: boolean }`. Prefer keeping enforcement logic in `packages/opencode/src/kilocode/` to minimize shared-file churn.
2. Add the new hook events to `packages/plugin/src/index.ts` `Hooks` and dispatch them via `Plugin.trigger` at the mapped attachment points:
   - `PreToolUse` → in `session/tools.ts` before `SandboxPolicy.executeTool` (reuse/extend the existing `tool.execute.before` site). Support a blocking result that can deny the tool.
   - `PostToolUse` → the existing `tool.execute.after` site.
   - `SubagentStart` → after `sessions.create` in `packages/opencode/src/tool/task.ts` (~line 265), or subscribe to `session.created` filtered by `parentID`.
   - `SubagentStop` → at `KiloSession.publishTurnClose` in `session/prompt.ts` (~line 1969) / child completion in `TaskTool`.
   - `Stop` (completion gate) → at session turn close for goal sessions; this maps directly onto the goal completion audit in `packages/opencode/src/kilocode/goal/index.ts` — a `Stop` hook that returns "keep going" should behave like a rejected audit and re-continue.
   - `PermissionRequest` → wire the currently-dormant `permission.ask` hook in `packages/opencode/src/permission/index.ts` `ask` (~line 187) so a hook can auto-approve/deny.
3. Implement a runner that executes configured shell/HTTP hooks for each event, passing a documented JSON payload (tool, sessionID, callID, args, agent_id/agent_type for subagents), and applies the result (block/modify/continue) where the event supports it.
4. Add a matcher (glob on tool name / agent name) so hooks can scope to specific tools or subagents.

**Acceptance criteria.** A configured `PreToolUse` hook can block a tool call; `PostToolUse` receives the result; `SubagentStart`/`SubagentStop` fire with the correct `agent_id`/`agent_type`; a `Stop` hook can force a goal session to continue; a `PermissionRequest` hook can auto-approve. Hooks that error are logged (never silently swallowed) and, unless `blocking`, do not crash the turn.

**Notes.** Start with `PreToolUse`/`PostToolUse` (attachment points already exist) and the `Stop` gate (highest leverage, reuses goal audit). `SubagentStart/Stop` and `PermissionRequest` need small new dispatch sites. Keep the config/enforcement in kilocode-owned files where possible.

---

## 5. Design-system-aware generation loop

**Goal.** Import a design system (tokens/components) from a repo, design files, or raw uploads; make UI generation build against it; and self-correct output to match before showing the user. Complements the existing Figma MCP bridge and the easy-tier "design system lock" flag. Source: Claude Design design-system import.

**What already exists.** Design integration today is agent-level only: the `designer` subagent and `DESIGN_GUIDANCE`/`CANVAS_GUIDANCE` prompts in `packages/opencode/src/kilocode/agent/index.ts`, Chief routing keyword `figma` in `packages/opencode/src/kilocode/chief/index.ts`, and optional user-configured Figma MCP (`get_design_context`, `search_design_system`, etc.). The canvas renders live React (`packages/kilo-vscode/src/services/canvas/`). There is **no stored design-system state** in the backend. The easy-tier plan (`easy.md` feature 5) adds a `raya.designSystem.lock` setting and a minimal backend flag; this feature builds the actual enforcement loop on top of it.

**Implementation steps.**
1. **Design-system store** — create `packages/opencode/src/kilocode/design-system/index.ts` (checkpoint template). Store an imported system: tokens (colors, type, spacing, radii), component inventory, and provenance (repo path / uploaded files). Global key `["raya", "design-system"]` with optional per-workspace scoping.
2. **Import** — support three sources: (a) a repo path or subdirectory — parse token files / component library; (b) design files / raw uploads — accept via the existing image/file attachment pipeline (`packages/kilo-vscode/webview-ui/src/hooks/useImageAttachments.ts`, `save-image.ts`) and let the `designer` agent extract tokens; (c) Figma via the user's MCP (`search_design_system`). Persist the normalized result.
3. **Inject into generation** — when a design system is present (and especially when the easy-tier lock flag is on), inject its tokens/components into `DESIGN_GUIDANCE`/`CANVAS_GUIDANCE` so generated UI is instructed to build against it.
4. **Self-correction pass** — after the agent produces UI (a canvas artifact or code), run a check step that compares the output against the stored tokens (e.g. flag off-palette colors, non-system spacing) and feeds discrepancies back as a follow-up turn before the result is shown. Reuse the goal/continuation pattern of a synthetic corrective turn.
5. **Admin lock** — honor the `raya.designSystem.lock` setting from `easy.md` feature 5: when locked, the self-correction pass is mandatory and edits to the approved system are blocked.

**Acceptance criteria.** A design system can be imported from a repo and persisted; UI generation references it; the self-correction pass flags and fixes obvious off-system output before display; with the lock on, generation cannot silently drift off the approved system.

**Notes.** This is the "deep enforcement" half that `easy.md` feature 5 explicitly deferred. Keep Figma import routed through the user's MCP rather than building a native Figma API client (that round-trip is `hard.md`).

---

## 6. Mobile / web companion

**Goal.** A thin client to view sessions, stream the live transcript, send prompts, answer permission prompts, and review diffs/design from a phone or browser against the user's home `kilo serve`. Full design in `docs/Raya-Mobile-Companion-Plan.md`; this is the code-level anchoring. Source: Cursor Web/iOS, Claude Code on web.

**What already exists.** `kilo serve` exposes the full HTTP + SSE API every desktop client already consumes: entry `packages/opencode/src/cli/cmd/serve.ts` → `Server.listen` (`packages/opencode/src/server/server.ts`); SSE stream at `GET /event` (`packages/opencode/src/server/routes/instance/httpapi/groups/event.ts` + `handlers/event.ts`); session create/prompt/diff routes under `packages/opencode/src/server/routes/instance/httpapi/`. The SDK client is `createKiloClient` (`packages/sdk/js/src/v2/client.ts`), which injects `x-kilo-directory` and supports auth. **Auth today is HTTP Basic** (`packages/opencode/src/server/auth.ts`, username `kilo` + `KILO_SERVER_PASSWORD`), not per-user bearer tokens. The extension's SSE consumer pattern is `SdkSSEAdapter` (`packages/kilo-vscode/src/services/cli-backend/connection-service.ts`).

**Implementation steps (mirrors the plan doc's build order).**
1. **Confirm the API contract with `curl`** against a local `kilo serve` (per [TESTING.md](../../TESTING.md)): create a session, subscribe to `/event`, post a prompt, fetch a diff. No client code yet.
2. **Reachability** — put the server on Tailscale (default) so the phone reaches it over a private encrypted address; document the reverse-tunnel fallback (Cloudflare Tunnel/ngrok) as opt-in and only behind real auth. `kilo serve` must never be exposed raw.
3. **Client** — build a thin PWA first (fastest to a phone), reusing the SDK (`createKiloClient` against the Tailscale address). Four surfaces in order: session list → live transcript (subscribe to the same SSE stream) → composer (send prompts, arm `/goal`, pause/resume, and answer permission prompts) → diff/review surface.
4. **Design canvas on mobile** — load a PC-served live preview or the canvas artifact in a webview over the same tunnel; pair with the screenshots from `easy.md` feature 4 for an instant still.
5. **Multi-user auth (only when teammates come aboard)** — add a gateway in front of `kilo serve`: short-lived tokens from an identity provider (GitHub OAuth is pragmatic), per-user session scoping, and an audit log. This is a middleware/gateway concern, not an agent-core change. Neon (available in this workspace) is a natural home for user records, tokens, and the activity log. Note this upgrades auth beyond today's single Basic password — scope it as its own sub-task.

**Acceptance criteria.** From a phone on the same tailnet: list sessions, watch a run stream live, send a prompt, and answer a permission prompt so an unattended goal that hits an approval wall does not hang; review a diff; view a design preview. Client degrades gracefully when the PC sleeps (clear "backend unreachable" state, resumes SSE on reconnect).

**Notes.** Pairs naturally with feature 2 (scheduled agents): scheduled runs happen while you're away, and a run that pauses for approval is exactly what the mobile permission surface resolves. The agent self-pause capability already in Raya (goal `paused` status) supports this.

---

## 7. Structured plan artifact

**Goal.** Turn plan mode's output into a structured, machine-consumable plan object that another agent — or a scheduled/background run — can execute, rather than only a prose `.md`. Source: Copilot Plan agent.

**What already exists.** Plan mode is the built-in `plan` agent, hardened by `planGuard` in `packages/opencode/src/kilocode/agent/index.ts` (deny-all except read-only tools + editing plan-file globs). Plan output today is a markdown file: prompt injection via `insertPlanReminder` in `packages/opencode/src/kilocode/session/prompt.ts`, plan-file resolution in `packages/opencode/src/kilocode/plan-file.ts` (`PlanFile.latest()` reads `plan_exit` tool metadata; `PlanFile.locate()` finds the on-disk `.md`), and the post-plan follow-up (implement vs refine) in `packages/opencode/src/kilocode/plan-followup.ts`. Plans live under `.kilo/plans/*.md` (and other globs).

**Implementation steps.**
1. Define a structured plan schema — `packages/opencode/src/kilocode/plan-file.ts` (or a sibling) — e.g. `{ title, summary, steps: { id, description, files?, acceptance? }[], risks? }`. Keep the human `.md` as the source of truth and derive the structured form, or have `plan_exit` emit both.
2. Have the `plan_exit` tool (find its definition in the kilocode tool set) capture/emit the structured object alongside the markdown, persisted with the plan file so `PlanFile.latest()` can return it.
3. Add a consumer path: let the post-plan follow-up (`plan-followup.ts`) hand the structured plan to a builder agent (switch to `code` agent with the plan steps as seeded context) or to a scheduled/background run (feature 2) so a plan can be executed unattended.
4. Surface the structured plan in the webview plan UI (steps as a checklist) so progress can be tracked as steps complete.

**Acceptance criteria.** Exiting plan mode yields both the existing markdown plan and a structured plan object; the structured plan can be handed to a builder agent that executes its steps; the plan UI shows steps; existing plan-file behavior is unchanged for users who don't use the structured path.

**Notes.** Lower-risk than the others — it's an additive artifact on an existing, well-defined flow. Good candidate to pair with feature 2 (a scheduled run that executes a saved structured plan).
