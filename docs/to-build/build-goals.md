# Raya Build Goals — The Master Roadmap

This is the single, prioritized source of truth for what to build into Raya next. It consolidates the four planning docs in this folder — `grok-bot-ideas.md`, `easy.md`, `medium.md`, and `hard.md` — into one ordered list where every buildable feature is written as its own **goal**: a self-contained unit of work you can hand to Raya cold.

The order is deliberate. Features are ranked by what is most important to have first, weighing three things at once: how much it changes what Raya can do for you day to day, whether it makes an already-shipped feature actually reliable, and whether other features on the list depend on it. Reliability of things you already touch beats breadth of things you don't, and foundations that unlock several later goals are pulled forward even when they are less glamorous than the ambitious cloud work near the bottom.

## Completed (as of 6 September 2026)

Goals 1, 2, and 4 are in the product. They were built as one pass because the original ranking already said routines needed a glanceable blocked state and a structured plan you can hand to a background run. The work is on `main` and installed as a VS Code snapshot (`7.4.23-snapshot+1b4dc98813`). Goal 3 (canvas) was left untouched on purpose.

**Goal 1 — Routines.** You can assign a named standing job from the Routines panel: role or custom role, a sentence of work, a plain-English schedule, a Settings mode (so Model per Mode applies), a write folder for new files, and either edit-the-workspace or read-and-notify. Accountant and Inbox require an explicit money or messages consent. One-shots, cron, CI events, and Run now all open their own session, drive through the goal loop, and record history with cost. A paused routine does not fire; overlapping runs are skipped; three identical blocks auto-disable with a note. Restart recomputes next run from storage. The roster matches History: presence, multi-select remove, templates for Briefer, Reviewer, Accountant, and Inbox. Proven live: unattended one-shot, two-minute cadence with skip-while-busy, ask-options parking, and role isolation.

**Goal 2 — Presence.** Header, tabs, History, and Routines show working, waiting on you, done, and error without dumping the transcript. A permission wall or `ask_options` parks the run as waiting on you and resumes when you answer. Quiet-hours notify exists. Full collapse of a finished run into a one-line summary is still only partial (tool grouping, not a rewritten recap).

**Goal 4 — Structured plans.** Plan exit writes a sidecar with stable step ids. The plan card can run this plan in the current chat or in the background as a routine. That is the handoff Goal 1 was waiting on.

The next open item in the numbered order is Goal 3, then Goal 5.

## How to use this doc

Each entry follows the same shape so you never have to guess how to start one:

- **What it means** — the feature in plain terms, and why it earns its rank.
- **What "done" means** — concrete, verifiable acceptance criteria. This is the completion audit; a goal is only finished when every line here is true and proven against the real running product, not just the code.
- **What else it should have** — my added recommendations beyond the original plan: the details that make the feature feel finished rather than merely functional.
- **The prompt to run** — a ready-to-paste `/goal` block. It carries the objective plus the key files, constraints, and acceptance criteria the original plan captured, so the agent that picks it up has everything it needs without re-reading the source docs.

Run them **one at a time, top to bottom.** Each goal is scoped to stand alone, but the ordering also respects dependencies: where a later goal builds on an earlier one, the prompt says so. When a goal is done, verify it against its "done" criteria in the actual running extension before moving on — several of these fail only at runtime, not in unit tests.

### Conventions that apply to every goal

These are repeated inside the prompts where they matter, but they hold everywhere:

- Mark edits to shared upstream (opencode) files with `kilocode_change` / `raya_change`; files under `packages/kilo-vscode/` and `packages/opencode/src/kilocode/` need no markers.
- After changing any server endpoint, regenerate the SDK with `bun ./script/generate.ts` from the repo root.
- For a new storage-backed backend feature with an HTTP endpoint, follow the checkpoint template (namespace module → route contracts → handlers → register the group → regenerate SDK → optional model tool → optional bootstrap subscriber → tests). It is spelled out in full inside Goal 1.
- Backend changes ship in the `kilo` CLI binary; the extension spawns it. After backend work, rebuild the binary and reinstall the snapshot VSIX (`bun run snapshot:build` then `bun run snapshot:install` from `packages/kilo-vscode/`), and fully restart VS Code so the old backend process is replaced.

## Priority index

| # | Goal | Tier | Source |
|---|---|---|---|
| 1 | Assignable role-based agents + user-friendly routines (done) | Hard (flagship) | medium #2 + grok + medium #3 |
| 2 | Presence as state — a glanceable, non-overwhelming run view (done) | Medium | grok |
| 3 | Canvas repair — make the live React canvas reliable | Medium | medium #8 |
| 4 | Structured plan artifact — executable plans, not just prose (done) | Medium | medium #7 |
| 5 | Deterministic lifecycle hooks | Medium | medium #4 |
| 6 | True per-hunk (line-range) undo | Medium | medium #1 |
| 7 | In-editor inline edit (Cmd/Ctrl+I) | Easy | easy #1 |
| 8 | Per-hunk Keep/Undo affordances in the gutter | Easy | easy #2 |
| 9 | Generalize status / preview / takeover to terminal + canvas | Medium | grok |
| 10 | Design-system lock flag | Easy | easy #5 |
| 11 | Design-system-aware generation loop | Medium | medium #5 |
| 12 | Design Mode toggle in canvas | Easy | easy #3 |
| 13 | Run artifact capture (screenshot / recording) | Easy | easy #4 |
| 14 | Mobile / web companion | Medium | medium #6 |
| 15 | GitHub-native PR review | Hard | hard #4 |
| 16 | PR autofix | Hard | hard #5 |
| 17 | Issue → PR background agent | Hard | hard #6 |
| 18 | Agent SDK + CI runner | Hard | hard #8 |
| 19 | Cloud / background agents in isolated VMs | Hard | hard #1 |
| 20 | Cloud ↔ local session handoff | Hard | hard #2 |
| 21 | Parallel multi-agent orchestration surface | Hard | hard #3 |
| 22 | Design ↔ code round-trip | Hard | hard #7 |
| 23 | Verify UI without hand-driving the browser | Medium | calculator-session review |
| 24 | Convergence cap on verify/redesign cascades | Medium | calculator-session review |
| 25 | Distinguish user takeover from bad model input | Medium | calculator-session review |

A closing section, **The Disappearing Interface**, is not a goal but a discipline to apply to every one of them.

## Build order, dependencies, and shared prerequisites

The numbering is the recommended order, but a few goals genuinely depend on earlier ones, and two heavy prerequisites gate whole clusters. Read this before starting anything past Goal 3 so you don't build something that has to be reworked.

Two prerequisites unlock the back half of the list. The **auth gateway** — short-lived per-user tokens in front of `kilo serve`, replacing today's single HTTP Basic password (`packages/opencode/src/server/auth.ts`) — is a hard blocker for the mobile companion's multi-user mode (14), the issue→PR agent (17), and every cloud goal (19–21). The **cloud runner** (19) is itself the foundation for session handoff (20) and the parallel orchestration surface (21). Neither is needed for goals 1–16 or 18, which is a large part of why the cloud work sits at the bottom: most of the roadmap's value lands before you ever stand up infrastructure.

The dependency edges worth knowing:

- **Goal 1 (routines)** consumes Goal 4 (a structured plan is the cleanest thing to hand a background run) and Goal 2 (a background job that blocks is useless unless "waiting on you" reaches you). Build 1 first anyway — it degrades gracefully without them — but revisit it after 2 and 4 land to wire them in.
- **Goal 2 (presence)** is reused by Goal 21's roster; build it once, apply it in both places.
- **Goal 3 (canvas reliability)** gates Goals 12 and 13 (Design Mode and capture both assume the panel renders) and feeds Goal 9's canvas takeover.
- **Goal 6 (per-hunk undo)** is the backend that Goal 8's UI re-points at; ship 8 first as a safe visual step, then swap its action when 6 lands.
- **Goal 10 (design lock flag)** → **Goal 11 (generation loop)** → **Goal 22 (round-trip)** is one continuous thread; don't start 11 before 10, or 22 before 11.
- **Goal 15 (PR review)** produces the findings **Goal 16 (autofix)** consumes.
- **Goals 23–25** (verify visually, cascade cap, repairable-vs-handover) came out of a real calculator session and should be built before the next long HTML/UI goal; they do not depend on canvas repair.

If you want to parallelize, there are two independent tracks after the foundations: a **product/UX track** (2 → 7 → 8 → 12 → 13 → 9) that never touches the backend contract, and a **capability track** (1 → 4 → 5 → 6 → 11) that does. Keep one agent per track to avoid colliding on shared files.

---

## 1. Assignable role-based agents + user-friendly routines

*Tier: hard (flagship). Sources: `medium.md` #2 (scheduled agents), `grok-bot-ideas.md` (per-role memory + presence), `medium.md` #3 (richer subagent config). Full design context: `docs/Raya-Scheduled-Agents-Plan.md`.*

**What it means.** This is the feature that turns Raya from a tool you drive into a team you delegate to. Today Raya's specialists (coder, designer, generalist, accountant) are ephemeral roles that Chief/Auto routes to for a single turn, with no lasting identity and a shared, undifferentiated project memory. This goal makes them **persistent, assignable agents you can hand standing jobs to** in plain language — "you handle my accounting," "you own the nightly repo review," "check my email every morning and draft replies" — and have them wake on a schedule or an event, do the work in the background against a saved objective, record what they did, and go back to sleep without burning tokens while idle. It ranks first because you asked for it directly, and because it is the single change that most reframes what Raya *is*: the Grok Bot essay's whole thesis is that the interface should let you delegate to a coworker rather than operate a session, and this is that coworker.

It is built from three planned pieces fused into one coherent product: the **scheduled/recurring agents** runtime (`medium.md` #2) provides the wake-run-record-sleep loop; **per-role memory** (from `grok-bot-ideas.md`) gives each assigned agent a durable context scoped to its job, so the accountant remembers your books and the designer remembers your design decisions without bleeding into each other; and **richer subagent frontmatter** (`medium.md` #3) lets a role be configured declaratively — its tools, its permission posture, whether it runs in the background, whether it gets its own worktree. The user-facing promise is that assigning a job is as easy as naming an agent, describing the job in a sentence, and (optionally) saying when — no cron syntax, no config files.

**What "done" means.**

- **Assign a role in plain language.** From a Raya panel (or by asking Raya in chat) I can create a named agent, pick its role/specialty, describe its standing job in one or two sentences, and optionally say when it should run ("every weekday at 6pm", "every time CI fails on main", "just when I ask"). Plain-English schedules are translated to a concrete schedule for me; I never type cron.
- **It runs itself.** A one-shot time fires once at that time; a recurring schedule fires on cadence; an event trigger fires on its event. Each firing opens a background session, seeds it with the agent's saved objective exactly like `/goal` arming, drives it to complete-or-blocked through the existing goal continuation loop, records the outcome (with cited evidence and cost) into that agent's run history, and closes. No foreground window is stolen.
- **Roles are real and isolated.** Each assigned agent has its own persistent memory scoped to its job; the accountant's context and the designer's context do not mix. Capabilities (tools like web, files, email) are shared at the account level; memory and the standing job belong to the role. A role's tools and permission posture are configurable and enforced at runtime.
- **It is safe and legible.** Every agent has an owner-visible enabled toggle; each run inherits the goal system's step/continuation caps so it can never loop forever; two runs of the same agent never overlap; cost per run is visible; an agent that blocks for the same reason N times in a row auto-disables and tells me why. Reminder-style jobs resolve to a message rather than code edits.
- **Restart-resilient.** Killing and restarting the backend recomputes every next-run time from stored schedules rather than trusting an in-memory timer; nothing is lost or double-fired.
- **Discoverable UI.** A panel lists my agents with their role, standing job, next run time, enabled toggle, per-run history with cost, and a manual "Run now" button. Creating or editing an agent is a form, not a config file.

**What else it should have.**

- **A "waiting on you" state that actually reaches me** (ties into Goal 2). A background job that hits an `ask_options` question or a permission wall must surface as a distinct, unmissable "blocked — needs you" state, not sit silently looking busy. Pair this with the mobile companion (Goal 14) so an away-from-desk approval doesn't stall the job for hours.
- **Templates for the obvious roles.** Ship a few starter roles — Accountant ("reconcile receipts, flag anything missing, draft the monthly summary"), Reviewer ("review the repo for bugs/security on a schedule"), Inbox ("triage and draft replies"), Briefer ("morning summary of what changed"). A new user should be able to assign a useful agent in two clicks without inventing the objective.
- **A dry-run / preview.** Before enabling a recurring job, let me trigger one "Run now" and inspect the result so I trust it before it runs unattended.
- **Per-agent identity in the UI.** A name, an avatar, and a one-line status so the roster is scannable at a glance (again, Goal 2). This is what makes it feel like a team rather than a list of cron entries.
- **Guard the accounting/email-style jobs behind explicit scopes.** A role that touches money or messages should require the owner to opt its capabilities in, and every run should log what it did in a form I can audit.

**Data model (concrete, so you don't have to invent it).** Two stored shapes, both `Effect.Schema`, both under global keys so they outlive any session. A `RayaAgent` is the persistent identity: `{ id, name, avatar?, role, objective, capabilities: string[] (opted-in tool groups), memoryScope: "role" | "project" | "session", schedule, enabled, createdAt, updatedAt }`. A `RayaTaskRun` is one firing: `{ id, agentID, at, sessionID, status: "running" | "complete" | "blocked" | "error", outcome: { kind: "code" | "notify"; summary; evidence?: string[]; cost }, blockedReason? }`. The `schedule` is the union `{ kind: "once"; at: number } | { kind: "cron"; expr: string; tz?: string } | { kind: "event"; source: string; filter?: string } | { kind: "manual" }`. Store the agent roster under `["raya","agent"]` and each agent's bounded run history (cap ~50, drop oldest) under `["raya","agent-runs",agentID]`. The `blockedReason` string is what powers the auto-disable-after-N-same-reason guard: compare the last N runs' `blockedReason` and flip `enabled` to false with a recorded note when they match.

**How to verify (the world-class bar, not just "it compiles").** Prove each of these at runtime in the installed extension, not only in unit tests:

- **The happy path unattended.** Assign a Briefer with `{kind:"once"; at: now+90s}`; walk away; come back to a completed run in its history with a real summary and a non-zero cost, and no foreground window stolen. Then flip it to a 2-minute cron and confirm it fires twice on cadence and skips a tick if the prior run is still going.
- **Restart resilience.** Assign a one-shot 5 minutes out, hard-kill the backend at minute 2, restart, and confirm it still fires at the original time (next-run recomputed from storage, not a lost in-memory timer) and does not double-fire.
- **Blocked reaches you.** Give an agent an objective that will hit an `ask_options` question; confirm the run parks in `blocked`, surfaces "waiting on you" per Goal 2, and resumes correctly once answered. Then make it block for the same reason N times and confirm it auto-disables with a legible reason.
- **Isolation is real.** Run an Accountant and a Designer; confirm the accountant's memory never appears in the designer's context, and that a `disallowedTools` entry on a role actually denies that tool at runtime (not just in the schema).
- **Safety rails hold.** Confirm a money/message role refuses to act until its capability is opted in, that every run writes an auditable action log, and that a runaway objective is stopped by the inherited goal step/continuation cap rather than looping.

**The prompt to run.**

```
/goal Build "assignable role-based agents + user-friendly routines" for Raya, fusing three planned pieces into one product. Read docs/Raya-Scheduled-Agents-Plan.md and docs/to-build/medium.md (features 2 and 3) and docs/to-build/grok-bot-ideas.md first.

PART A — Agent/run store + runner (the riskiest integration; build and prove this first).
- Create packages/opencode/src/kilocode/task/index.ts following the checkpoint template (packages/opencode/src/kilocode/checkpoint/index.ts). Two Effect.Schema shapes, both global-keyed since they outlive sessions:
  RayaAgent (the persistent identity): { id, name, avatar?, role, objective, capabilities: string[] (opted-in tool groups), memoryScope: "role"|"project"|"session", schedule, enabled, createdAt, updatedAt }. Store the roster under ["raya","agent"].
  RayaTaskRun (one firing): { id, agentID, at, sessionID, status: "running"|"complete"|"blocked"|"error", outcome: { kind: "code"|"notify"; summary; evidence?: string[]; cost }, blockedReason? }. Store each agent's bounded run history (cap ~50, drop oldest) under ["raya","agent-runs",agentID].
  schedule = { kind:"once"; at } | { kind:"cron"; expr; tz? } | { kind:"event"; source; filter? } | { kind:"manual" }.
- Runner: turn a fired agent into work by reusing the goal machinery — Session.create (no foreground reveal), seed exactly like /goal arming (RayaGoal.create + a synthetic objective turn, mirroring continueGoal in packages/opencode/src/kilocode/goal/continuation.ts), let the existing continuation loop drive it to complete/blocked, then record a RayaTaskRun with cited evidence + cost and close. Add a "notify" outcome for reminder-style jobs that resolve to a message, not code.
- Prove PART A with a "Run now" that seeds a background goal run before any scheduler exists.

PART B — Scheduler.
- A single long-lived Effect fiber owned by the backend, started in packages/opencode/src/kilocode/bootstrap.ts. Tick every 60s: read enabled tasks, recompute nextRun from stored schedules (never trust in-memory timers; recompute on startup), hand due tasks to the runner, and SKIP any task whose prior run is still active (no overlap). One-shot times first, then a cron library for recurrence. Do plain-English -> cron translation in the create form, not the backend.

PART C — Per-role memory + declarative role config.
- Give each assigned agent persistent memory scoped to its job (session vs project vs role) so roles don't bleed into each other; capabilities stay account-level, memory + objective stay per-role. Reuse kilo-memory where possible; if absent for a scope, store a small storage-backed map keyed by role.
- Extend agent frontmatter (packages/core/src/v1/config/agent.ts AgentSchema) with optional disallowedTools, permissionMode, memory, background, isolation — normalized into the existing permission engine (fold disallowedTools into permission denies; map permissionMode onto existing planGuard/askGuard rather than a parallel system). Prioritize disallowedTools + permissionMode (fully enforceable); background/isolation/memory may ship validated-but-partially-enforced first.

PART D — HTTP + tools + UI.
- Add RayaTask endpoints (list/create/update/enable/runNow/history) to packages/opencode/src/kilocode/server/httpapi/groups+handlers/kilocode.ts; register the group; regenerate the SDK with bun ./script/generate.ts. Add a model-facing schedule_task tool in packages/opencode/src/kilocode/tool/ (+ tool/registry.ts) so Raya can create a job when I ask in chat.
- Build a user-friendly panel: list agents (name, role, standing job, next run, enabled toggle, per-run history + cost, Run now). Creating/editing an agent is a FORM with plain-English scheduling, not a config file. Ship starter role templates: Accountant, Reviewer, Inbox, Briefer.

GUARDRAILS (not optional): owner-visible enabled flag; per-run step/continuation caps from the goal system; no overlapping runs; visible cost per run; auto-disable after N consecutive same-reason blocks with a reason; money/message-touching roles require explicit capability opt-in and log every action.

DONE = I can assign a named agent a role and a one-sentence standing job with a plain-English schedule, it runs itself in the background to completion/blocked, records outcome+cost, surfaces "waiting on you" when blocked, survives a backend restart, and is fully managed from the panel. Mark shared-file edits with kilocode_change/raya_change; add tests under packages/opencode/test/kilocode/; rebuild the binary + reinstall the snapshot VSIX and verify at runtime.
```

---

## 2. Presence as state — a glanceable, non-overwhelming run view

*Tier: medium. Source: `grok-bot-ideas.md` ("Presence as state").*

**What it means.** The Grok Bot essay's core UI insight is that a good agent communicates *state*, not a wall of activity. Right now a Raya run — especially a goal or a background agent — is a scrolling transcript that is exhausting to watch and easy to lose the thread of. The important moments (it's working, it finished, it's *waiting on you*, it hit an error) are buried in the noise. This goal makes Raya's status a small number of clear, glanceable states with a calm surface, so at any moment you know what Raya is doing and, critically, whether it needs you. It ranks this high because it is near-term, it directly amplifies the routines feature (a background agent is useless if you can't tell it's blocked), and it fixes a felt pain: the ask-tool and permission prompts already exist, but a blocked run doesn't announce itself loudly enough.

Concretely: reduce every run to a few first-class states — **thinking / working**, **waiting on you** (a question or permission), **done**, **blocked/error** — each with an unmistakable visual treatment; collapse the step-by-step transcript by default into a summary you can expand; and make "waiting on you" impossible to miss (badge, distinct color, and a surfaced action) both in the active chat and across the session/agent roster.

**What "done" means.**

- Every active run resolves to one of a small set of named states with a distinct, consistent visual treatment across the chat header, the session tab strip, and the agent roster.
- The transcript is collapsed to a readable summary by default; the full step detail is one click away and never lost.
- A run that is **waiting on you** (an `ask_options`/`question` tool call or a permission request) is visually unmistakable — distinct color/badge plus the actionable control brought to the foreground — and the same signal appears wherever that session is listed, not only if you're looking at it.
- **Done** and **blocked/error** are equally distinct and persist until acknowledged, so you can look away and come back without re-reading the log to learn the outcome.
- The states are driven by real backend signals (turn open/close, goal status, permission asked/replied, tool state) — not guessed from text.

**What else it should have.**

- A single roster view (feeds Goal 1's panel) showing every session/agent as a row with its one-word state and last activity, so "who needs me" is answerable in one glance.
- Subtle motion that reinforces state rather than decorates it: a calm pulse while working, a firm stop on done, an attention treatment on blocked — restrained, not busy.
- An optional OS/editor notification when a run flips to "waiting on you" or "done" while the panel isn't focused (respecting a quiet-hours setting), so background work reaches you.
- Consistency with the disappearing-interface principle: default to the summary, reveal detail on demand.

**The prompt to run.**

```
/goal Implement "presence as state" for Raya so a run's status is glanceable, not a wall of text. Read docs/to-build/grok-bot-ideas.md ("Presence as state") first.
- Define a small set of first-class run states — thinking/working, waiting-on-you, done, blocked/error — derived from REAL backend signals: session turn open/close (packages/opencode/src/kilocode/session/event.ts), goal status (packages/opencode/src/kilocode/goal/index.ts), permission asked/replied, and ask_options/question tool calls. Do not infer state from transcript text.
- In the webview, give each state a distinct, consistent visual treatment across the chat header (TaskHeader.tsx), the session tab strip (SessionTabStrip.tsx), and the history/roster list (SessionList.tsx). Collapse the step transcript to a summary by default with expand-on-click; never drop detail.
- Make "waiting on you" unmissable: distinct color + badge + the actionable control (the ask card / permission prompt) surfaced to the foreground, and mirror the badge wherever the session is listed so a blocked background run announces itself even when unfocused.
- "done" and "blocked/error" persist until acknowledged. Add an optional VS Code notification when a run flips to waiting-on-you or done while its panel is unfocused, gated by a quiet-hours setting.
DONE = at a glance I can tell, for every active session, whether Raya is working, waiting on me, done, or errored, from any of the three surfaces; a blocked background run reaches me without my hunting for it; states come from backend events. Files under packages/kilo-vscode/ need no change markers. Verify at runtime with a goal run that hits an ask_options question.
```

---

## 3. Canvas repair — make the live React canvas reliable

*Tier: medium. Source: `medium.md` #8.*

**What it means.** `/canvas` (and Auto-invoked `create_canvas`) is supposed to open a panel that renders a live React artifact in a few seconds. In practice it intermittently reports `The canvas host did not respond (timeout)`, and the retry it suggests (`call update_canvas with the same name`) then fails with `update_canvas requires source, data, or both` — an impossible retry that leaves an empty panel and a two-minute stall. This goal is a dedicated, evidence-driven pass to find which hop in the SSE → bridge → panel → compiler → reply pipeline drops the reply in the packaged Electron host, and harden it. It ranks high because it is an already-shipped feature that doesn't work reliably — reliability of something you reach for beats new breadth — and because you've explicitly asked for it repeatedly. Note: the code and mechanism exist and several speculative fixes have already landed, so the rule here is **trace with evidence before changing anything.**

**What "done" means.**

- `/canvas "a counter app"` opens a panel that renders the live component within a few seconds.
- A transient timeout is genuinely recoverable via a name-only `update_canvas`, which re-renders the persisted source end-to-end (not just passes schema validation).
- The bridge answers the host **exactly once** on every path — success, compile error, and exception.
- The extension host log shows a clean `request-received → replied` for a successful build; no path hangs to the ~2-minute host timeout (add a short backend-side timeout that resolves with a repairable error instead).
- A runtime smoke check (extension integration test or scripted dev-host run) opens a trivial counter canvas and asserts a rendered frame, so this regression can't silently return.

**What else it should have.**

- A visible in-panel status while it works ("compiling…", "rendering…") so a slow build reads as progress, not a hang — and a clear, actionable error state with a one-click retry when it truly fails.
- Structured, timestamped bridge logs at each hop so the next diagnosis takes minutes, not an afternoon.
- A guard that keeps `initialize({ worker: false })` (never reintroduce the browser-only `wasmModule` option, which throws in Node/Electron).

**The prompt to run.**

```
/goal Fix Canvas end-to-end so /canvas reliably renders a live React artifact. Read docs/to-build/medium.md feature 8 first. TRACE WITH EVIDENCE BEFORE CHANGING CODE — the pipeline has already absorbed several speculative fixes.
1. Reproduce in the dev extension host and read the output channel for "[Kilo New] CanvasBridge:" lines. Establish IN ORDER: (a) does the create_canvas SSE request reach CanvasBridge (packages/kilo-vscode/src/services/canvas/canvas-bridge.ts) at all; (b) does the service resolve (panel shown + compile finished) within the 15s race; (c) does reply/reject complete back to the backend host (packages/opencode/src/kilocode/tool/canvas-host.ts) before its timeout. The 2-minute stall means execute() never returned within the compile guard — the hop that never completes is the target.
2. If the request never arrives: verify the canvas request event type is on the same SSE stream the bridge subscribes to, and metadata["raya.canvas.command"] is set so the tool is dispatchable (RayaChief.tools() in packages/opencode/src/kilocode/chief/index.ts).
3. If the reply never lands: harden the bridge so every path (success, compile error, exception) answers the host exactly once; confirm the endpoint the bridge posts to matches the one canvas-host.ts awaits; add a short backend-side timeout that resolves with a repairable error instead of hanging ~2 min.
4. If compile hangs: confirm ensureEsbuild() in canvas-compiler.ts runs initialize({ worker:false }) in the packaged bundle (grep dist/extension.js). Never reintroduce the browser-only wasmModule option. Ensure a stuck transform surfaces via the 15s race as a visible error, not an empty panel.
5. Make the retry truthful: a name-only update_canvas must re-render the persisted .raya/canvases source end-to-end.
6. Add a runtime smoke check that opens a counter canvas and asserts a rendered frame.
DONE = counter canvas renders within a few seconds; name-only update_canvas recovers a timeout; bridge answers exactly once on every path; host log shows request-received -> replied; nothing hangs to the 2-min timeout; smoke check guards it. Mark shared opencode edits with kilocode_change. Verify in the live host, not just unit tests.
```

---

## 4. Structured plan artifact — executable plans, not just prose

*Tier: medium. Source: `medium.md` #7.*

**What it means.** Plan mode today produces a prose markdown file. That's fine for a human to read, but it can't be handed to another agent or a background run to *execute*. This goal makes plan mode also emit a structured, machine-consumable plan object — a title, summary, and ordered steps with files and acceptance criteria — while keeping the human-readable `.md` as the source of truth. It ranks here because it is comparatively low-risk (an additive artifact on a well-defined existing flow) and because it is the connective tissue for the routines feature: a saved structured plan is exactly what a scheduled/background agent should be able to pick up and run unattended.

**What "done" means.**

- Exiting plan mode yields both the existing markdown plan and a structured plan object (`{ title, summary, steps: { id, description, files?, acceptance? }[], risks? }`), persisted alongside the plan file so `PlanFile.latest()` can return it.
- The structured plan can be handed to a builder agent that executes its steps (switch to the `code` agent with the steps as seeded context), and to a scheduled/background run (Goal 1).
- The webview plan UI shows the steps as a checklist that tracks progress as steps complete.
- Existing plan-file behavior is unchanged for users who never touch the structured path.

**What else it should have.**

- A stable step-ID scheme so progress and partial completion survive edits to the plan and can be reported back per step.
- A "run this plan" affordance in the plan UI that seeds a builder run directly, closing the loop from planning to execution in one click.
- Round-tripping: if the builder discovers a step is wrong mid-execution, let it annotate the structured plan so the record stays honest.

**The prompt to run.**

```
/goal Add a structured, executable plan artifact to plan mode. Read docs/to-build/medium.md feature 7 first.
- Define a structured plan schema in packages/opencode/src/kilocode/plan-file.ts (or a sibling): { title, summary, steps: { id, description, files?, acceptance? }[], risks? }. Keep the human .md as source of truth and derive the structured form, or have plan_exit emit both.
- Have the plan_exit tool capture/emit the structured object alongside the markdown, persisted with the plan file so PlanFile.latest() returns it.
- Add a consumer path in packages/opencode/src/kilocode/plan-followup.ts: hand the structured plan to a builder (switch to the code agent with the steps seeded) or to a scheduled/background run (the routines feature).
- Surface steps as a checklist in the webview plan UI, tracking completion. Add a "run this plan" affordance that seeds a builder run.
- Give steps stable IDs so progress survives plan edits; let the builder annotate the plan if a step proves wrong.
DONE = exiting plan mode yields both the markdown plan and a structured object; the structured plan can be executed by a builder agent and by a background run; the plan UI shows tracked steps; users who ignore the structured path see no change. Mark shared opencode edits with kilocode_change; add tests under packages/opencode/test/. 
```

---

## 5. Deterministic lifecycle hooks

*Tier: medium. Source: `medium.md` #4.*

**What it means.** Raya has a plugin hook interface, but it's shallow (`tool.execute.before/after`, and a `permission.ask` hook that's defined but never invoked). This goal productizes hooks as first-class, user-configurable lifecycle handlers — `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, a `Stop` completion-gate, and `PermissionRequest` — that can run shell commands or HTTP calls and influence execution (block a tool, modify a result, force a goal to keep going, auto-approve a permission). It ranks here because it is the automation substrate several later ideas lean on, and the `Stop` gate in particular is high-leverage: it maps directly onto the goal completion audit, letting you enforce "don't stop until X is true" declaratively.

**What "done" means.**

- A configured `PreToolUse` hook can block a tool call; `PostToolUse` receives the result.
- `SubagentStart`/`SubagentStop` fire with the correct `agent_id`/`agent_type`.
- A `Stop` hook can force a goal session to continue (behaving like a rejected completion audit).
- A `PermissionRequest` hook can auto-approve or deny (wiring the currently-dormant `permission.ask` hook).
- Hooks scope via a matcher (glob on tool/agent name). Hook errors are logged, never silently swallowed, and unless marked blocking do not crash the turn.

**What else it should have.**

- A documented, stable JSON payload per event (tool, sessionID, callID, args, agent id/type) so external scripts can be written once and trusted.
- Ship the highest-leverage two first — `PreToolUse`/`PostToolUse` (attachment points already exist) and the `Stop` gate — and layer the rest in, so value lands early.
- Keep config and enforcement in kilocode-owned files to minimize shared-file churn, and mirror any new config key into the cloud schema per AGENTS.md.

**The prompt to run.**

```
/goal Productize deterministic lifecycle hooks. Read docs/to-build/medium.md feature 4 first.
- Add a hooks config section (packages/opencode/src/config/config.ts, marked kilocode_change, mirrored in the cloud schema per AGENTS.md) mapping event names -> [{ command | url; matcher?; blocking? }]. Keep enforcement in packages/opencode/src/kilocode/ where possible.
- Add the events to packages/plugin/src/index.ts Hooks and dispatch via Plugin.trigger at these attachment points: PreToolUse + PostToolUse in packages/opencode/src/session/tools.ts (extend the existing tool.execute.before/after sites; PreToolUse can deny); SubagentStart after sessions.create in packages/opencode/src/tool/task.ts (or subscribe to session.created filtered by parentID); SubagentStop at KiloSession.publishTurnClose in session/prompt.ts; Stop (completion gate) at goal session turn close, mapped onto the completion audit in packages/opencode/src/kilocode/goal/index.ts so "keep going" re-continues; PermissionRequest by wiring the dormant permission.ask hook in packages/opencode/src/permission/index.ts ask().
- Implement a runner that executes shell/HTTP hooks with a documented JSON payload (tool, sessionID, callID, args, agent_id/agent_type) and applies block/modify/continue where supported. Add a glob matcher on tool/agent name. Log hook errors; only crash the turn if blocking.
- Ship PreToolUse/PostToolUse and the Stop gate first, then the rest.
DONE = a PreToolUse hook can block a tool; PostToolUse gets the result; SubagentStart/Stop fire with correct ids; a Stop hook forces a goal to continue; a PermissionRequest hook auto-approves; matchers scope hooks; errored hooks are logged and non-fatal unless blocking. Mark shared-file edits; add tests under packages/opencode/test/.
```

---

## 6. True per-hunk (line-range) undo

*Tier: medium. Source: `medium.md` #1.*

**What it means.** Today Undo works at file granularity — Undo all, or undo a whole file. This goal lets you undo only selected changed lines in a file while leaving that file's other hunks intact. It ranks high because it's core developer productivity and it directly extends the undo/keep-boundary work already landed. It is medium, not easy, because the snapshot system restores whole files from git blob hashes and has no concept of "revert lines 10–14 only" — a correct implementation must reconstruct "current file minus the selected hunks" without desyncing the snapshot bookkeeping that Keep all / Undo all and goal discard rely on.

**What "done" means.**

- Undoing one hunk reverts only those lines; other hunks in the same file remain.
- A subsequent Keep all / Undo all and goal discard behave correctly afterward — no orphaned or double-reverted state.
- Works in both a git and a non-git workspace (snapshots already run in a private git dir).
- The range revert goes through the same snapshot-coherent path `discardAll` uses; it does **not** apply inverse hunks in the extension host (that bypasses snapshot bookkeeping and desyncs Keep/Undo all).

**What else it should have.**

- Honor the kept-boundary model already built: a per-hunk undo must never rewind below a kept boundary for that file.
- A hard escalation rule: if keeping snapshot bookkeeping coherent for partial reverts proves intractable, escalate to hard tier rather than shipping a partial-file revert that can corrupt the snapshot chain — a corrupt chain is worse than no per-hunk undo.

**The prompt to run.**

```
/goal Implement true per-hunk (line-range) undo. Read docs/to-build/medium.md feature 1 first.
- Extend the protocol: add optional ranges?: { file; start; end }[] to DiscardSessionChangesRequest (packages/kilo-vscode/webview-ui/src/types/messages/webview-messages.ts) and thread through KiloProvider.handleCheckpointMessage -> handleDiscardSessionChanges.
- Add a backend range-revert in packages/opencode/src/kilocode/session/revert.ts: (a) read pre-edit content from the relevant snapshot/patch part, (b) compute merged file = current file with only the selected new-side ranges reverted to their pre-edit counterparts (reuse the unified-diff hunks stored in the patch part; do NOT re-diff), (c) write through the same path discardAll uses so snapshot state stays coherent. Respect the existing kept boundaries — never rewind below a kept boundary.
- Expose it via the discard_changes HTTP route (optional ranges field) or a dedicated kilocode endpoint; regenerate the SDK.
- Wire per-hunk CodeLens actions (raya.editReview.undoHunk) in packages/kilo-vscode/src/edit-review/InEditorReview.ts that post ranges; refresh via scheduleReview -> refresh().
DONE = undoing one hunk reverts only those lines; other hunks remain; Keep all/Undo all and goal discard still behave; works in git and non-git; nothing applies inverse hunks in the host. If snapshot coherence proves intractable, STOP and escalate to hard tier rather than risk corrupting the chain. Mark shared opencode edits with kilocode_change; add a test under packages/opencode/test/kilocode/session/revert.test.ts.
```

---

## 7. In-editor inline edit (Cmd/Ctrl+I)

*Tier: easy. Source: `easy.md` #1.*

**What it means.** Pressing `Cmd+I` / `Ctrl+I` in an editor opens a small prompt for the current selection (or cursor line), sends it to the active Raya session with that selection as context, and streams the edit back through the normal in-editor review flow. It's the Cursor/Copilot inline-edit ergonomic — the single highest-frequency way developers ask for a change — and it ranks above the other easy items because it's used constantly. The truly easy version routes through the existing sidebar composer via the `triggerTask` message, so no new streaming path is needed.

**What "done" means.**

- With a selection and cursor in a file, `Cmd+I` prompts for an instruction; the resulting message appears in the active session referencing the exact file + line range; the agent's edit streams back and shows up in the normal in-editor review flow.
- Falls back to the current line range when there's no selection.
- Works in light and dark themes; no keybinding conflicts (`cmd+i` is unused today).

**What else it should have.**

- Thread the selection range as structured context (extend the `editorContext` object) rather than only embedding it in prose, so the agent anchors edits precisely.
- A later upgrade path noted but deferred: a Cursor-style floating input anchored at the cursor (that's a medium UI effort — don't block the easy win on it).

**The prompt to run.**

```
/goal Add an in-editor inline edit trigger (Cmd+I / Ctrl+I). Read docs/to-build/easy.md feature 1 first.
- Add a raya.inlineEdit command to contributes.commands in packages/kilo-vscode/package.json, plus a cmd+i / ctrl+i keybinding with when: editorTextFocus, and an editor/context menu entry near the existing raya.editorContextMenu items.
- Register it (in register-code-actions.ts or a new inline-edit-commands.ts following the registerCheckpointCommands shape). Use getEditorContext() (editor-utils.ts); if no selection, fall back to the current line range.
- Prompt with vscode.window.showInputBox, compose a prompt including file path + line range + the selected text fenced in a code block, and send via the existing triggerTask message (no new streaming path). Optionally extend the editorContext object built in KiloProvider.gatherEditorContext with activeSelection: { file, startLine, endLine, text } and thread through session.promptAsync.
DONE = with a selection, Cmd+I prompts, the message references the exact file+lines, the edit streams back into the normal in-editor review flow; falls back to the cursor line with no selection; theme-aware; no keybinding conflict. Files under packages/kilo-vscode/ need no change markers.
```

---

## 8. Per-hunk Keep/Undo affordances in the gutter

*Tier: easy. Source: `easy.md` #2.*

**What it means.** A UI-only improvement that renders a Keep/Undo affordance next to *each* contiguous changed region in a reviewed file, instead of one cluster for the whole file. The actions still call today's file-level `keepFile` / `undoFile` (the backend is file-level until Goal 6 lands), so the labels stay honest ("Undo file"). It ranks just below the real per-hunk undo because it's the low-risk visual step that makes multi-hunk files reviewable now, and it pairs naturally with Goal 6 later.

**What "done" means.**

- Each changed region in a reviewed file shows its own Keep/Undo affordance in the gutter.
- Actions behave identically to today's per-file controls; labels remain accurate to the file-scoped action.
- Green highlights and CodeLenses refresh after Keep all / Undo all and after new edits (via `scheduleReview` → `refresh()`).

**What else it should have.**

- Write it so the per-region rendering can be re-pointed at the real range-revert action from Goal 6 with minimal change — same placement, swapped command.

**The prompt to run.**

```
/goal Render per-hunk Keep/Undo affordances in the editor gutter (UI only). Read docs/to-build/easy.md feature 2 first.
- In packages/kilo-vscode/src/edit-review/InEditorReview.ts, render one CodeLens cluster per contiguous changed region using the LineRange[] from addedRanges (patch-ranges.ts), each still calling the file-level raya.editReview.keepFile / raya.editReview.undoFile. Keep labels honest for a file-scoped action (e.g. "Undo file").
- Ensure highlights + CodeLenses refresh after Keep all / Undo all and after new edits via scheduleReview -> refresh().
- Structure it so the per-region cluster can later be re-pointed at the range-revert action from the per-hunk-undo goal with minimal change.
DONE = each changed region shows its own Keep/Undo affordance; actions match today's per-file behavior; refresh works after keep/undo and new edits. Files under packages/kilo-vscode/ need no change markers.
```

---

## 9. Generalize status / preview / takeover to terminal + canvas

*Tier: medium. Source: `grok-bot-ideas.md` ("their-computer-not-yours" model).*

**What it means.** The Grok Bot essay describes a clean three-level access model for watching an agent work on a resource: **status** (see what it's doing), **preview** (watch it live), **takeover** (grab the controls yourself). Raya's browser panel already implements exactly this with its manual-takeover handoff. This goal generalizes that same pattern to the other agent surfaces — the terminal and the canvas — so watching and intervening feels identical everywhere instead of being a bespoke interaction per surface. It ranks in the middle: it's a consistency and control win that makes long autonomous runs trustworthy, and it reuses a proven pattern rather than inventing one.

**What "done" means.**

- The terminal surface offers the same three levels: a status summary of what the agent is running, a live preview of the running command/output, and a takeover that lets the user type into the same shell the agent is using and hand it back.
- The canvas surface offers status/preview/takeover consistent with the browser panel's model (preview = the live render; takeover = direct interaction/Design Mode from Goal 12).
- The interaction (labels, controls, handoff semantics) matches the browser panel so there's one mental model, not three.

**What else it should have.**

- A single shared abstraction for the three-level control so future surfaces inherit it for free rather than re-implementing.
- Clear handoff semantics: taking over pauses the agent's control of that surface; handing back resumes it — never a silent fight over the same resource.

**The prompt to run.**

```
/goal Generalize the browser panel's status/preview/takeover access model to the terminal and canvas. Read docs/to-build/grok-bot-ideas.md ("their-computer-not-yours") first.
- Study the existing browser takeover handoff in packages/kilo-vscode/src/services/browser-automation/ (browser-panel.ts + browser-session.ts) and extract the three-level pattern (status, preview, takeover) into a shared abstraction.
- Apply it to the terminal surface: status = summary of the running command; preview = live output; takeover = the user types into the same shell and hands back. Pause/resume the agent's control cleanly on takeover/handback (no silent contention).
- Apply it to the canvas surface: preview = the live render; takeover = direct interaction / Design Mode (see the Design Mode goal). Keep labels + handoff semantics identical to the browser panel.
DONE = terminal and canvas both offer status/preview/takeover with the same interaction and handoff semantics as the browser; a shared abstraction backs all three; taking over pauses the agent and handing back resumes it. Files under packages/kilo-vscode/ need no change markers.
```

---

## 10. Design-system lock flag

*Tier: easy. Source: `easy.md` #5.*

**What it means.** A single owner setting that pins one approved design system so generated UI must build against it. It reuses the exact global owner-toggle pattern already proven by `raya.permissions.grantAllTools`. It ranks here as the small, safe first half of the design-system story: the setting plus its wiring is genuinely easy, and it's the flag the deeper generation loop (Goal 11) reads.

**What "done" means.**

- Toggling `raya.designSystem.lock` in Raya settings persists and, on activation and on change, pushes the state to the backend without error.
- When locked, design/UI generation prompts reference the approved system.
- Default off; safe for users who never flip it.

**What else it should have.**

- An optional `raya.designSystem.source` (repo path or token file) so the lock has something concrete to point at, feeding Goal 11's importer.
- Surface it in the settings search index so it's discoverable (the settings-search work already exists — make sure this key is indexed).

**The prompt to run.**

```
/goal Add an owner "lock a standard design system" flag. Read docs/to-build/easy.md feature 5 first.
- Declare raya.designSystem.lock (boolean, default false) and optional raya.designSystem.source (string) in packages/kilo-vscode/package.json contributes.configuration.properties with a clear markdownDescription. Ensure both are picked up by the settings search index.
- Create packages/kilo-vscode/src/kilo-provider/design-system-lock.ts mirroring grant-all-permissions.ts: KEY = "designSystem.lock", an enabled() reader, an apply() that pushes state to the backend, and registerDesignSystemLock(connection) returning the config-change disposable (guard on affectsConfiguration).
- Add a minimal backend surface (a RayaDesignSystem namespace under packages/opencode/src/kilocode/ + a kilocode HTTP endpoint following the checkpoint template) that the designer agent / DESIGN_GUIDANCE prompt consults so, when locked, generated UI is instructed to build against the named system. Regenerate the SDK.
- Register registerDesignSystemLock(connectionService) in extension.ts next to registerGrantAllPermissions.
DONE = toggling the setting persists and pushes to the backend without error; when locked, generation prompts reference the approved system; default off; the key is discoverable in settings search. Mark shared opencode edits with kilocode_change.
```

---

## 11. Design-system-aware generation loop

*Tier: medium. Source: `medium.md` #5.*

**What it means.** The deep half of the design story: import a design system (tokens/components) from a repo, design files, or raw uploads; make UI generation build against it; and self-correct output to match before showing you. It builds directly on the lock flag (Goal 10) and the Figma MCP bridge. It ranks after the flag because it's the enforcement engine — the part that actually keeps generated UI on-system rather than just asking it to.

**What "done" means.**

- A design system can be imported from a repo and persisted (tokens: colors, type, spacing, radii; a component inventory; provenance).
- UI generation references the stored system; with the lock on, the self-correction pass is mandatory.
- A self-correction pass flags and fixes obvious off-system output (off-palette colors, non-system spacing) as a follow-up turn before the result is shown.
- With the lock on, generation cannot silently drift off the approved system, and edits to the approved system are blocked.

**What else it should have.**

- Three import sources supported: a repo path (parse token/component files), design files / raw uploads (via the existing attachment pipeline, extracted by the `designer` agent), and Figma via the user's MCP (`search_design_system`) — routed through the MCP, not a native Figma client (that's Goal 22).
- Reuse the goal/continuation pattern for the corrective turn so the self-correction loop is consistent with how goals already re-drive work.

**The prompt to run.**

```
/goal Build the design-system-aware generation loop (deep enforcement half). Read docs/to-build/medium.md feature 5 first; it builds on the design-system lock flag.
- Create packages/opencode/src/kilocode/design-system/index.ts (checkpoint template) storing tokens (colors, type, spacing, radii), a component inventory, and provenance under ["raya","design-system"] with optional per-workspace scoping.
- Import from three sources: (a) a repo path/subdir (parse token files / component library); (b) design files / raw uploads via the existing attachment pipeline (useImageAttachments.ts, save-image.ts), extracted by the designer agent; (c) Figma via the user's MCP (search_design_system). Persist the normalized result. Route Figma through the MCP, not a native client.
- Inject the stored tokens/components into DESIGN_GUIDANCE/CANVAS_GUIDANCE when a system is present (mandatory when the lock flag is on).
- Add a self-correction pass: after UI is produced, compare against stored tokens (flag off-palette colors, non-system spacing) and feed discrepancies back as a synthetic corrective turn (reuse the goal/continuation pattern) before showing the user. With the lock on, this pass is mandatory and edits to the approved system are blocked.
DONE = a design system imports from a repo and persists; generation references it; the self-correction pass flags+fixes obvious off-system output before display; with the lock on, output cannot silently drift and the system can't be edited. Mark shared opencode edits with kilocode_change; add tests under packages/opencode/test/kilocode/.
```

---

## 12. Design Mode toggle in canvas

*Tier: easy. Source: `easy.md` #3.*

**What it means.** A lightweight visual-tweak mode layered on the live React canvas for quick style/layout adjustments without a full chat round-trip. The easy scope is deliberately small: inspect the hovered element and emit a change hint back to the agent, rather than a full WYSIWYG editor that writes source. It depends on the canvas being reliable (Goal 3) and pairs with the takeover model (Goal 9).

**What "done" means.**

- The canvas panel shows a Design Mode toggle; enabling it activates an overlay in the sandboxed iframe; disabling it returns to normal render.
- Toggling never breaks live rebuilds (`CanvasRefresh` on `.canvas.tsx` change).
- The overlay lets you inspect the hovered element and emit a change hint back to chat, which the agent can persist into the `.canvas.tsx` source under `.raya/canvases/`.
- Theme-aware.

**What else it should have.**

- Build the toolbar header once (modeled on the browser panel's header) so the Capture control (Goal 13) can share it.
- Keep the CSP constraint front of mind: the overlay runs inside the `sandbox="allow-scripts"` iframe and only posts data outward.

**The prompt to run.**

```
/goal Add a Design Mode toggle to the canvas. Read docs/to-build/easy.md feature 3 first; depends on canvas reliability.
- Add a toolbar header to the outer webview HTML in packages/kilo-vscode/src/services/canvas/canvas-panel.ts, modeled on browser-panel.ts's header, with a theme-styled "Design Mode" toggle. Build the header so a future Capture button can share it.
- Add messages on CanvasPanelMessage: outer -> extension { type: "designModeChanged"; enabled }, and extension/host -> inner { source: "raya-canvas-host"; type: "designMode"; enabled } relayed like the data message.
- In canvas-runtime.tsx, handle designMode: when enabled, render a lightweight overlay to inspect the hovered element and emit a change hint (do NOT build a full style editor). Emit selected tweaks back to chat via the existing prompt path so the agent can persist them into the .canvas.tsx source under .raya/canvases/.
DONE = the panel shows a Design Mode toggle; enabling activates the overlay in the sandboxed iframe; disabling returns to normal; toggling never breaks live rebuilds; inspecting emits a change hint the agent can persist; theme-aware. Respect the sandbox="allow-scripts" CSP. Files under packages/kilo-vscode/ need no change markers.
```

---

## 13. Run artifact capture (screenshot / short recording)

*Tier: easy. Source: `easy.md` #4.*

**What it means.** Capture a screenshot (optionally a short recording) of a finished canvas/preview run so a completed goal can be verified from an artifact — the same way cloud-agent demos attach a screenshot/video of the result. It reuses the existing image-attachment and save pipeline; the only new work is capturing inside the sandboxed webview and posting a data URL out. It ranks last among the easy items because it's a nice-to-have that becomes genuinely valuable once background/routine runs (Goal 1) need to prove what they did.

**What "done" means.**

- A "Capture" control on the canvas panel produces a PNG of the current render, saved to disk (e.g. `.raya/canvases/captures/`) and optionally attached to the active session so the goal's completion audit can cite it.
- The saved file opens in the existing image preview.
- Screenshot fidelity is acceptable for verification (not necessarily pixel-perfect).

**What else it should have.**

- Attach the capture to the session as a message part so a routine/background run can cite it as completion evidence automatically.
- Defer `MediaRecorder`-based recording to a later pass unless explicitly needed — the still image carries most of the verification value.

**The prompt to run.**

```
/goal Add run artifact capture (screenshot) to the canvas panel. Read docs/to-build/easy.md feature 4 first.
- In the canvas inner runtime (canvas-runtime.tsx) or the outer host script (canvas-panel.ts), add a capture routine: render the artifact to an offscreen canvas via a bundled html-to-image helper and toDataURL("image/png"), running inside the sandbox="allow-scripts" iframe and posting only a data URL out.
- Add a "Capture" button to the canvas toolbar (reuse the Design Mode toolbar) and a message outer -> extension { type: "capture"; data: dataURL }.
- In the extension, reuse parseImage() + save-image.ts to write the PNG to .raya/canvases/captures/, and attach it to the session as a message part so a goal's completion audit can cite it. The saved file must open in the existing image preview.
- Defer MediaRecorder recording unless explicitly requested.
DONE = a Capture control produces a PNG of the current render, saved to disk and attached to the session; the file opens in the image preview; fidelity is good enough for verification. Files under packages/kilo-vscode/ need no change markers.
```

---

## 14. Mobile / web companion

*Tier: medium. Source: `medium.md` #6. Full design: `docs/Raya-Mobile-Companion-Plan.md`.*

**What it means.** A thin client — a PWA first — to view sessions, stream the live transcript, send prompts, answer permission prompts, and review diffs/design from a phone or browser against your home `kilo serve`. It ranks here because it's the natural partner to the routines feature: scheduled runs happen while you're away, and a run that pauses for approval is exactly what a mobile permission surface resolves so an unattended goal doesn't hang for hours. `kilo serve` already exposes the full HTTP + SSE API every desktop client uses; the work is a thin client plus safe reachability.

**What "done" means.**

- From a phone on the same tailnet: list sessions, watch a run stream live, send a prompt, and answer a permission prompt so an unattended goal that hits an approval wall doesn't hang; review a diff; view a design preview.
- The client degrades gracefully when the PC sleeps (clear "backend unreachable" state, resumes SSE on reconnect).
- `kilo serve` is never exposed raw — reachability is via Tailscale by default, with any public tunnel only behind real auth.

**What else it should have.**

- Build the four surfaces in dependency order: session list → live transcript (same SSE stream) → composer (prompts, arm `/goal`, pause/resume, answer permissions) → diff/review.
- Confirm the API contract with `curl` against a local `kilo serve` (per `TESTING.md`) before writing any client code.
- Scope multi-user auth as its own sub-task (a gateway with short-lived identity-provider tokens, per-user session scoping, an audit log; Neon is a natural home) — today's single Basic password is fine for solo/tailnet use but must be upgraded before teammates.

**The prompt to run.**

```
/goal Build a mobile/web companion (thin PWA) for Raya. Read docs/Raya-Mobile-Companion-Plan.md and docs/to-build/medium.md feature 6 first.
1. Confirm the API contract with curl against a local kilo serve (see TESTING.md): create a session, subscribe to /event, post a prompt, fetch a diff. No client code yet.
2. Reachability: put the server on Tailscale by default so the phone reaches it over a private encrypted address; document a Cloudflare Tunnel/ngrok fallback as opt-in and only behind real auth. Never expose kilo serve raw.
3. Client: a thin PWA reusing the SDK (createKiloClient against the Tailscale address). Four surfaces in order: session list -> live transcript (subscribe to the same SSE stream) -> composer (send prompts, arm /goal, pause/resume, ANSWER PERMISSION PROMPTS) -> diff/review.
4. Design canvas on mobile: load a PC-served live preview or the canvas artifact in a webview over the same tunnel; pair with the screenshot capture goal for an instant still.
5. Multi-user auth (only when teammates come aboard): a gateway in front of kilo serve with short-lived identity-provider tokens (GitHub OAuth is pragmatic), per-user session scoping, and an audit log (Neon for user records/tokens/log). Scope this as its own sub-task — it upgrades beyond today's single Basic password.
DONE = from a phone on the tailnet I can list sessions, watch a run stream live, send a prompt, answer a permission prompt (so an unattended goal doesn't hang), review a diff, and view a design preview; the client resumes cleanly after the PC sleeps; kilo serve is never exposed raw. Files under packages/kilo-vscode/ and packages/opencode/src/kilocode/ need no markers.
```

---

## 15. GitHub-native PR review

*Tier: hard. Source: `hard.md` #4.*

**What it means.** Post inline review comments on a pull request — logic issues, security concerns, likely bugs — on request or automatically. Raya already has most of the primitives: a GitHub agent with Octokit, a `/review` command with PR scope, and a security-review helper. The work is turning review findings into diff-anchored comments and wiring the triggers. It leads the hard tier because it delivers concrete value with the least new infrastructure and reuses a lot of what exists.

**What "done" means.**

- Requesting a review on a PR produces inline comments anchored to the right lines, categorized by severity.
- Re-running updates the existing review rather than stacking duplicate comments.
- It runs headlessly in CI with a scoped token.

**What else it should have.**

- Two trigger paths: a GitHub Action workflow (adapt the disabled `pr-management.yml.disabled`; add any new workflow to `script/check-workflows.ts` per AGENTS.md) and an on-demand "Review this PR" action in the extension.
- A summary comment plus the inline comments, so a reviewer gets both the line-level detail and the overall read.

**The prompt to run.**

```
/goal Build GitHub-native PR review. Read docs/to-build/hard.md feature 4 first.
- Build a review runner that, given a PR, runs the existing /review pr command headlessly (kilo run --command review; scopes in packages/opencode/src/kilocode/review/command.ts) to produce structured findings (file, line, severity, message).
- Post findings as inline PR review comments via Octokit in packages/opencode/src/cli/cmd/github.handler.ts (it already has Octokit + Actions context): create a review with comments[] anchored to diff positions, not just a summary comment. Add a summary comment alongside.
- Trigger paths: (a) a GitHub Action workflow (adapt .github/workflows/disabled/pr-management.yml.disabled; add the new workflow to script/check-workflows.ts allowlist); (b) an on-demand "Review this PR" extension action.
- Dedupe: on re-runs, update the existing review rather than stacking duplicates.
DONE = requesting a review yields inline comments anchored to the right lines, categorized by severity, plus a summary; re-running updates rather than duplicates; runs headlessly in CI with a scoped token. Mark shared opencode edits with kilocode_change; coordinate with the workflow allowlist guard.
```

---

## 16. PR autofix

*Tier: hard. Source: `hard.md` #5. Depends on Goal 15 (review findings) and worktree/cloud isolation.*

**What it means.** When review finds an issue, spin up an agent that implements and tests a fix, and proposes it directly on the PR — but only when the fix is verified. It ranks after review because it consumes review's findings, and it's high-risk because it combines autonomous editing, test execution, and write access to a PR, so it must run isolated and behind explicit owner opt-in.

**What "done" means.**

- A review finding can be turned into a tested fix that is proposed on the PR **only when tests pass**.
- The fix is scoped to the finding; unverifiable fixes are not proposed.
- The run happens in isolation (a worktree at minimum, a cloud env ideally).

**What else it should have.**

- Reuse the `RayaGoal` completion audit as the gate: propose only when the run reaches verified-complete (tests green), not merely "done".
- Track outcome (proposed / merged) so you get a merge-rate signal over time.
- Prefer a GitHub "suggested change" on the specific lines when the fix is small; fall back to a linked fix branch/PR for larger changes.

**The prompt to run.**

```
/goal Build PR autofix. Read docs/to-build/hard.md feature 5 first; depends on GitHub-native PR review and worktree/cloud isolation. Gate behind explicit owner opt-in.
- For a selected review finding, check out the PR branch in a worktree (WorktreeManager.ts) or cloud env, seed a goal-style run with the finding as the objective (reuse RayaGoal so the completion audit verifies the fix), and let it implement + run the relevant tests.
- Gate on evidence: only propose the fix if the run reaches verified-complete (tests green) per the RayaGoal completion audit in packages/opencode/src/kilocode/goal/index.ts.
- Propose the fix: a GitHub "suggested change" on the specific lines via Octokit (github.handler.ts) for small fixes, or a linked fix branch/PR for larger ones.
- Track outcome (proposed/merged) for a merge-rate signal.
DONE = a finding becomes a tested fix proposed on the PR only when tests pass; the fix is scoped to the finding; unverifiable fixes are never proposed; the run is isolated; the feature is owner-opt-in. Mark shared opencode edits with kilocode_change.
```

---

## 17. Issue → PR background agent

*Tier: hard. Source: `hard.md` #6. Depends on worktree/cloud isolation and the auth gateway.*

**What it means.** Trigger from an `@raya` mention on a GitHub (later Slack/Linear) issue or PR: create a branch, implement the change, and open a PR linked back to the issue. The GitHub agent already handles webhook events and mention-style triggers; the work is the end-to-end pipeline from event to verified PR. High-risk — autonomous implementation with repo write access from external triggers — so it's owner-opt-in and isolated.

**What "done" means.**

- Mentioning `@raya` on an issue produces a branch, an implementation verified by the goal audit, and a linked PR, with a comment back on the issue.
- Slack/Linear triggers reach the same internal path.

**What else it should have.**

- A single internal "start a task with this objective in this repo" shape that all sources (GitHub/Slack/Linear adapters) translate into, so the pipeline is written once.
- Verified-completion gating via the goal audit before the PR is opened, same as autofix.

**The prompt to run.**

```
/goal Build the issue -> PR background agent. Read docs/to-build/hard.md feature 6 first; depends on isolation + the auth gateway. Owner-opt-in.
- Event ingestion: extend packages/opencode/src/cli/cmd/github.handler.ts to recognize @raya mentions on issues/PRs (it already parses GitHub event context via @actions/github). Add Slack/Linear adapters that translate their events into one internal "start a task with this objective in this repo" shape.
- Run: create a branch/worktree (or cloud env), seed a goal run with the issue body as the objective, drive to verified completion (goal audit).
- Output: commit, push the branch, open a PR via Octokit linking back to the originating issue; comment the PR link on the issue.
- Trigger workflow: a GitHub Action (adapt the disabled pr-management workflow; add to script/check-workflows.ts).
DONE = an @raya mention on an issue produces a branch, a goal-audit-verified implementation, and a linked PR, with a comment back on the issue; Slack/Linear triggers reach the same path. Mark shared opencode edits with kilocode_change.
```

---

## 18. Agent SDK + CI runner

*Tier: hard. Source: `hard.md` #8.*

**What it means.** A productized, documented way to run Raya headlessly inside CI (GitHub Actions) with scoped allow-tool permissions and cron triggers. All the building blocks exist — `kilo run` non-interactive mode, headless permissions, scoped permission rules, the generated SDK, the GitHub agent — what's missing is a clean external entrypoint and a reusable Action. It's lower-risk than the VM work (no new infra) but touches auth, permission scoping, and CI security, and its cron piece overlaps with the routines feature.

**What "done" means.**

- A CI job can run Raya headlessly with a scoped tool allowlist, stream/collect results, and be triggered on a schedule or event.
- The SDK entrypoint is documented.
- The reusable Action installs and runs without hand-rolled SSE glue.

**What else it should have.**

- A thin `@kilocode/sdk` helper for "start a run, stream events, get result", modeled on the `kilo run` loop, so scripts don't re-implement the SSE loop.
- Share the schedule model with the routines feature (Goal 1) rather than inventing a second cron.
- A `docs/` guide covering auth, tool scoping, and cron, in the style of the existing plan docs.

**The prompt to run.**

```
/goal Build the Agent SDK + CI runner. Read docs/to-build/hard.md feature 8 first.
- SDK surface: document and stabilize an external entrypoint. Add a thin @kilocode/sdk helper for "start a run, stream events, get result", modeled on the kilo run loop (packages/opencode/src/cli/cmd/run.ts), so CI/scripts don't hand-roll the SSE loop.
- Permission scoping for CI: expose an allow-tool allowlist flag on kilo run (map to Permission.fromConfig rules) so a job grants only the tools it needs; default to the headless deny posture otherwise.
- Reusable GitHub Action: package a Raya Action (adapt .github/workflows/disabled/pr-management.yml.disabled and the githubInstall flow) that installs the CLI, authenticates, and runs kilo run / a command on @raya mentions or a cron schedule. Add any new workflow to script/check-workflows.ts. Share the schedule model with the routines feature.
- Docs: a docs/ guide for embedding Raya in CI (auth, tool scoping, cron).
DONE = a CI job runs Raya headlessly with a scoped tool allowlist, streams/collects results, and triggers on a schedule or event; the SDK entrypoint is documented; the Action installs and runs without hand-rolled glue. Mark shared opencode edits with kilocode_change.
```

---

## 19. Cloud / background agents in isolated VMs

*Tier: hard (largest item). Source: `hard.md` #1. Prerequisite: the auth gateway.*

**What it means.** Run a Raya session in a provisioned cloud VM with a full dev environment — repo, dependencies, secrets, restricted egress — instead of on your local machine, launchable and observable remotely. This is the single largest item on the whole roadmap: real infrastructure, security, and cost surface, and it's the foundation the later cloud features build on. It ranks low not because it's unimportant but because it's the heaviest lift and everything above it delivers value sooner. Prototype with a local container runtime before any managed cloud.

**What "done" means.**

- A run launched to the cloud provisions an isolated environment, executes against the repo without a local machine involved, restricts egress to an allowlist, and streams events + artifacts back for review.
- Secrets never leak to logs.
- Stopping a run tears down the VM.

**What else it should have.**

- A `.raya/environment.json` (mirroring `.cursor/environment.json`): install/build/start commands, a Dockerfile reference, secret names, allowed outbound domains.
- The headless permission posture inside the VM (no human to approve), plus the owner-gated allow-everything primitive only when explicitly enabled.
- Environment snapshot/caching so runs start fast with dependencies pre-installed.
- A control-plane API modeled on the existing Agent Manager orchestration protocol so the surface stays consistent with Goal 21.

**The prompt to run.**

```
/goal Build cloud/background agents in isolated VMs. Read docs/to-build/hard.md feature 1 first. This is the largest item — the auth gateway prerequisite must land first, and prototype with a LOCAL container runtime before any managed cloud.
1. Environment definition: add .raya/environment.json (install/build/start commands, Dockerfile reference, secret names, allowed outbound domains). Parse it in a new module under packages/opencode/src/kilocode/cloud/.
2. Provisioner: a new backend service (not part of kilo serve) that provisions an isolated container/VM (start with Docker/Firecracker or a managed provider), clones the repo at a ref, installs deps from a cached snapshot, injects secrets, and applies egress restrictions.
3. Runner inside the VM: run kilo serve/run behind the auth gateway with the headless permission posture (packages/opencode/src/kilocode/permission/headless.ts) plus, only if the owner enables it, the allow-everything primitive. Surface artifacts (screenshots/diffs) for remote verification.
4. Control plane + API: endpoints to create/list/stop cloud runs and stream events back, modeled on packages/opencode/src/kilocode/agent-manager/protocol.ts for consistency. Regenerate the SDK.
5. Snapshot/caching: cache the built environment so runs start fast.
DONE = a cloud run provisions an isolated env, executes against the repo with no local machine, restricts egress to the allowlist, streams events+artifacts back; secrets never hit logs; stopping tears down the VM. Mark shared opencode edits with kilocode_change.
```

---

## 20. Cloud ↔ local session handoff

*Tier: hard. Source: `hard.md` #2. Depends on Goal 19.*

**What it means.** Move a running session between your local machine and the cloud in either direction — send it up to keep running while you're offline, pull it down to iterate locally. Sessions are already directory-scoped, persisted, and directory-routed, and `kilo run --attach` can connect to a running server; the hard part is reconciling workspace state across the round-trip, which should lean entirely on the snapshot system.

**What "done" means.**

- A session moved to the cloud continues from the same transcript and workspace state; moved back, the local working tree matches the cloud edits.
- No message/part loss across the round-trip.
- Only one side is "live" at a time.

**What else it should have.**

- A portable session bundle: session record + message/part history + a snapshot hash for workspace state; export/import under `packages/opencode/src/kilocode/cloud/`.
- UI actions ("Move to cloud" / "Bring local") mirroring the existing worktree `move` operation, so handoff feels like a first-class Agent Manager action.

**The prompt to run.**

```
/goal Build cloud <-> local session handoff. Read docs/to-build/hard.md feature 2 first; depends on the cloud runner. Lean entirely on the snapshot system for workspace reconciliation — no ad-hoc diffing.
1. Define a portable session bundle: session record + message/part history (SQLite) + a snapshot hash (packages/opencode/src/snapshot/). Add export/import under packages/opencode/src/kilocode/cloud/ that serializes and restores it.
2. Local -> cloud: export the bundle, provision a cloud env, import, resume via session.promptAsync on the cloud runner. Mark the local session "running in cloud".
3. Cloud -> local: pause the cloud run, export the bundle (including new edits as a snapshot), import locally, reattach the local client, reconcile the working tree via the snapshot.
4. UI: "Move to cloud" / "Bring local" actions mirroring the worktree move op in packages/kilo-vscode/src/agent-manager/orchestration-domain.ts.
DONE = a session moved to cloud continues from the same transcript+state; moved back, the local tree matches the cloud edits; no message/part loss; only one side is live at a time. Mark shared opencode edits with kilocode_change.
```

---

## 21. Parallel multi-agent orchestration surface

*Tier: hard. Source: `hard.md` #3. Depends on Goal 19 for the cloud runs it displays.*

**What it means.** A window that manages many agents across repos at once, showing cloud runs alongside local/worktree runs in one place — extending Raya's already-built Agent Manager to the cloud. This is the most-built-out hard feature; the extension side, webview, and backend orchestration protocol all exist. The work is mostly additive: teach the overview about cloud runs. It can even ship an "empty cloud section" before the cloud runner exists.

**What "done" means.**

- The Agent Manager surface shows local, worktree, and cloud runs together across repos.
- Each shows live status; actions (prompt, stop, move/handoff) work uniformly.
- The surface updates in real time from the shared event stream.

**What else it should have.**

- Cross-repo grouping that slots cloud runs into the same project/worktree ref model Agent Manager already uses.
- Reuse Goal 2's presence states here so the roster reads at a glance.

**The prompt to run.**

```
/goal Extend the Agent Manager into a parallel multi-agent orchestration surface that includes cloud runs. Read docs/to-build/hard.md feature 3 first; depends on the cloud runner (can ship an empty cloud section first).
1. Extend the orchestration Overview protocol (packages/opencode/src/kilocode/agent-manager/protocol.ts) to include cloud runs as a run kind alongside local/worktree, with status, location, repo, and branch.
2. Feed cloud-run state (from the cloud control plane) into the same overview stream the webview consumes (webview-ui/agent-manager/project/state.ts createProjectStateRouter) so cloud and local render in one list.
3. Add cross-repo grouping via the existing multi-project routing (project/route.ts) so cloud runs slot into the same project/worktree ref model.
4. Add controls for cloud runs (stop, bring local) to orchestration-domain.ts. Reuse the presence-as-state visual treatment for the roster.
DONE = the surface shows local, worktree, and cloud runs together across repos with live status; prompt/stop/move work uniformly; it updates in real time from the shared event stream. Files under packages/kilo-vscode/ and packages/opencode/src/kilocode/ need no markers.
```

---

## 22. Design ↔ code round-trip

*Tier: hard. Source: `hard.md` #7. Builds on Goal 11 (design-system-aware generation).*

**What it means.** A `/design-sync`-style flow: pull a design system in, hand a finished design off to a build agent, and sync changes back. Because Figma export is generally one-directional (read), a true round-trip must keep **code as the source of truth** and stay conservative on the sync-back. It ranks last because it depends on both the medium-tier design store and on MCP write capabilities that aren't guaranteed.

**What "done" means.**

- `/design-sync` pulls the design system into working context.
- A finished design produces code that matches the stored tokens.
- Code changes update the stored design system.
- The loop runs without re-importing from scratch each time.

**What else it should have.**

- Keep the sync-back conservative (code authoritative) until Figma write paths are proven — regenerate the canvas preview or push representative artifacts only where the MCP supports it.
- Wire it into the plan/follow-up flow so a design can flow design → build → verify without manual re-prompting.

**The prompt to run.**

```
/goal Build the design <-> code round-trip. Read docs/to-build/hard.md feature 7 first; builds on the design-system-aware generation loop. Keep CODE as the source of truth.
1. Add a /design-sync command (kilocode command, using packages/opencode/src/kilocode/review/command.ts as a template) that pulls the current design system (from the design-system store) into working context.
2. Design -> code handoff: take a finished design (canvas artifact or Figma node via MCP) and hand it to a build agent (coder/designer) that generates production code against the stored tokens, verified by the self-correction pass.
3. Code -> design sync-back: when code (components/tokens) changes, update the stored design system and, where the MCP supports it, push representative artifacts back (or regenerate the canvas preview). Keep code authoritative.
4. Wire it into the plan/follow-up flow so a design flows design -> build -> verify without manual re-prompting.
DONE = /design-sync pulls the system; a finished design yields code matching the tokens; code changes update the stored system; the loop runs without re-importing each time. Keep sync-back conservative until Figma write paths are proven. Mark shared opencode edits with kilocode_change.
```

---

## 23. Verify UI without hand-driving the browser

*Tier: medium. Source: the Gen Z calculator session (`ses_f96825d11ffetmnm1sF25e3v0M`) — 47 `browser_evaluate` calls, 13 subagents, max-steps.*

**What it means.** When the user asks for an HTML/UI artifact, the agent currently "proves" it works by authoring long JavaScript harnesses and running them through `browser_evaluate`. That is the single biggest step-burner in a design run. Those harnesses fail on wrapper bugs, `file://` origin-null, empty smoke assertions, and click timeouts — so the product never gets a clean verdict, and the parent keeps re-delegating. This goal makes visual/UI verification prefer `browser_screenshot` + `browser_snapshot` (and, when it exists, a structured smoke flow), and reserves `browser_evaluate` for one-line expressions such as reading a result text. It does **not** change canvas routing: if the user asked for HTML, HTML is correct.

**What "done" means.**

- Designer / coder / generalist prompts for UI work tell the model to verify with screenshot + accessibility snapshot first, and to use `browser_evaluate` only for a short expression (no multi-statement harnesses, no top-level `await` loops, no injected `console.error` spies).
- `browser_smoke_test` rejects or repairs empty `assertions: []` with a clear, one-turn-fixable error instead of burning three retries and handing over.
- A UI goal can complete on screenshot + snapshot evidence; it does not require a green `browser_evaluate` harness.
- Existing click/type/navigate flows are unchanged.

**What else it should have.**

- A hard cap in the tool description: "expression only — if you need more than one statement, take a screenshot instead."
- Chief routing / designer prompt language that says "verify visually" rather than "drive the page like a user wrote a test suite."

**The prompt to run.**

```
/goal Stop verifying generated UI by hand-driving the browser with long evaluate harnesses. Do not change canvas routing — HTML is valid when the user asked for HTML.
- Update designer / coder / generalist / researcher browser guidance (packages/opencode/src/kilocode/agent/index.ts CANVAS_GUIDANCE / DESIGN_GUIDANCE / walkthrough, and the browser tool descriptions in packages/opencode/src/kilocode/tool/) so UI verification prefers browser_screenshot + browser_snapshot. browser_evaluate is for a short expression only (read a value, check a class). Forbid multi-statement harnesses, top-level await loops, and console.error spies as the completion path.
- Make browser_smoke_test return a repairable error when assertions are empty, not a 3-strike takeover. See packages/kilo-vscode/src/services/browser-automation/browser-session.ts and the smoke tool schema.
- Teach the goal completion audit (packages/opencode/src/kilocode/goal/index.ts) that a screenshot + snapshot is sufficient visual evidence for an HTML/UI objective; do not require a green evaluate harness.
DONE = a "design an HTML calculator and verify it" run completes from screenshot/snapshot evidence; evaluate is used at most for short expressions; empty smoke assertions do not trigger manual takeover. Mark shared opencode edits with kilocode_change. Verify with a real HTML UI session, not only unit tests.
```

---

## 24. Convergence cap on verify/redesign cascades

*Tier: medium. Source: the same calculator session — 13 child sessions titled verify / finish / conformance / consolidate, each repeating the same failing browser dance until max steps.*

**What it means.** Auto/Chief re-delegates "verify it again" when a child returns without clean evidence. If the failure is *tooling* (evaluate syntax, smoke schema, timeout, origin-null) rather than a product defect, another child will fail the same way. This goal adds a same-reason stop: after N consecutive verification children fail for the same `blockedReason` (or the same tool-error fingerprint), the parent must stop, report the blocker, and ask — not spawn "complete conformance" again. Same idea as the routines auto-disable-after-N-same-reason guard (Goal 1), applied to in-session delegation.

**What "done" means.**

- Each delegated child records a short outcome fingerprint: `product-fail` vs `tool-fail` plus the tool name and a normalized error class (syntax, timeout, schema, origin, cancelled).
- If the last N (default 2) children on the same parent share a `tool-fail` fingerprint, the next `task` / `chief_route` to "verify / conformance / finish remaining" is blocked and the parent must call `ask_options` or `update_goal` to blocked — not spawn another child.
- Product-fail fingerprints (the UI is actually wrong) may still re-delegate once to fix, then must re-verify; they do not loop forever.
- The inherited goal step/continuation cap still applies as a backstop.

**What else it should have.**

- Surface the fingerprint on the goal banner / child card so you can see "stopped: browser_evaluate syntax failed twice."
- Do not count `Task cancelled` as a product-fail; cancelled children should not restart the cascade.

**The prompt to run.**

```
/goal Add a convergence cap so verify/redesign cascades stop after repeated same-reason tooling failures. Read the calculator session pattern: 13 children named verify/finish/conformance/consolidate, all failing the same browser tools.
- On each task child completion (packages/opencode/src/tool/task.ts / packages/opencode/src/kilocode/tool/task.ts), record an outcome fingerprint on the parent: product-fail vs tool-fail, tool name, and a normalized error class (syntax, timeout, schema, origin, cancelled). Persist it on session metadata (e.g. raya.cascade).
- Before spawning another child whose title/objective is verify/conformance/finish/consolidate (or whose chief_route target is the same specialist for verification), if the last N (default 2) children share a tool-fail fingerprint, refuse the spawn and require ask_options or update_goal blocked with the reason. Product-fail may re-delegate once to fix, then must re-verify; it cannot loop.
- Do not treat Task cancelled as product-fail. Keep the goal step/continuation cap as the backstop.
DONE = a parent that has already seen two children fail browser_evaluate with SyntaxError will not spawn a third verify child; it stops and reports the blocker. A genuine product bug can still get one fix pass. Add tests under packages/opencode/test/kilocode/. Mark shared opencode edits with kilocode_change.
```

---

## 25. Distinguish user takeover from bad model input

*Tier: medium. Source: calculator session — every `Unexpected token`, empty smoke assertion, and `#sciToggle` timeout became "Manual browser takeover required after three failed attempts."*

**What it means.** The 3-strikes handover exists so a human can solve captchas, auth walls, and "the selector is wrong because the page is a challenge." It is now also firing on *model-authored bad input*: invalid JS, empty assertions, a missing selector on a page the agent itself wrote. That flips the panel to manual, stalls the goal, and costs two more retries before the model even sees a repairable error. This goal splits the paths: auth/challenge/user-intent → handover; malformed tool input / page-owned selector miss → a single repairable tool error the model can fix next turn.

**What "done" means.**

- `browser_evaluate` syntax/runtime errors from the model's expression return once, as a tool error, with the real message. No 3-strike handover.
- `browser_smoke_test` schema violations (empty assertions, missing steps) return once as a tool error. No handover.
- Click/type timeout on a selector that exists in the agent's own snapshot/HTML is a repairable miss (return once), not a takeover.
- Click/type timeout or 403/429 on a third-party challenge/auth page still hands over after retries, with a reason a human can act on.
- A user clicking Take over still works and still cancels in-flight retries.

**What else it should have.**

- Classify once in `BrowserSession.attempt` (or the host tool): `repairable` vs `handover`. Repairable throws after 1 try; handover keeps the 3-strike path.
- Do not auto-resume from manual just because the next tool call arrived if the last handover was a real challenge — only resume on explicit Resume or a new navigate the user confirmed.

**The prompt to run.**

```
/goal Distinguish user/browser takeover from bad model input. Repairable mistakes must not flip the panel to manual.
- In packages/kilo-vscode/src/services/browser-automation/browser-session.ts attempt(), classify errors: repairable = evaluate SyntaxError/TypeError from the expression, smoke schema violations, selector timeout on a page the agent just wrote; handover = HTTP 403/429, captcha/login URL, user takeControl, repeated click miss on a third-party page.
- Repairable: fail once, return the real error to the tool, stay in agent control. Handover: keep the 3-strike path and the existing reason string.
- User Take over still cancels in-flight retries. Do not auto-resume a challenge handover just because the next tool call arrived — require Resume (or an explicit user-confirmed navigate).
- Thread the same classification through the browser host tool so the model sees "fix this expression" vs "page needs you."
DONE = a bad evaluate expression returns one repairable tool error and the panel stays in agent control; a captcha/403 still hands over; Take over still works. Extend packages/kilo-vscode/tests/unit/browser-session.test.ts. Files under packages/kilo-vscode/ need no change markers.
```

---

## Closing principle — The Disappearing Interface

This is not a goal; it is the discipline to apply to every goal above. The Grok Bot essay's quietest lesson is that the best agent interface removes knobs and caps scope rather than accumulating them. The settings search that already shipped makes things findable, but the deeper move is to ask, for each feature here, whether it helps you **delegate** or just gives you one more thing to **manage**.

Concretely, hold each of these builds to three tests before calling it done. Default to the summary and reveal detail on demand, so the presence-as-state view and every transcript stay calm rather than becoming a firehose. Prefer a sensible default over a new setting, and when a setting is genuinely needed, make sure it is discoverable through search rather than buried. And cap scope deliberately — a small number of assignable agents, a bounded run history, a short list of first-class states — because a constrained surface you trust to run unattended is worth more than an unlimited one you have to babysit. The routines feature is the clearest expression of this principle: its success is measured not by how many controls it exposes, but by how rarely you have to touch it once a job is assigned.

