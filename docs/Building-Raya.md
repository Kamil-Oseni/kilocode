# Building Raya — The Complete Build Plan

This is the detailed, step-by-step plan for building **Raya**, your own agentic IDE
on top of Kilo Code: a private fork you compile into your own VS Code extension and
CLI, carrying Eden's identity and logo, and
extended with the features Kilo lacks — native goal mode, intelligent auto-routing,
in-chat option prompts, canvas, intelligent subagents, an in-editor browser, agent
smoke and end-to-end testing, and voice. The plan is written to be executed by
goal/loop agents, so every milestone ends in a **Definition of Done (DoD)** that is
concrete and verifiable. Treat each DoD as the done-condition of a goal contract:
the work is finished only when every item can be proven against the running build,
not when it looks plausible.

## How to use this document

Each milestone has the same shape: **Why** (what it buys you), **Design** (the
approach and the trade-offs), **Build steps** (every concrete step), **Definition
of Done** (the verifiable finish line), and **Tests** (how the DoD is proven). When
you hand a milestone to a goal-runner, copy its DoD into `GOAL.md`, its build steps
into `PLAN.md` as checkpoints, and let the loop verify against the DoD.

Two rules make the whole effort sustainable. First, keep every fork edit small and
marked. Kilo already uses `// kilocode_change` markers around its own edits to
opencode; adopt your own marker (`// raya_change` … `// raya_change end`) so a
future rebase onto upstream is mechanical and your patches are greppable.
Second, sort every change into "generic" or "bespoke." Generic fixes (unlocking
Plan-mode markdown edits, a saner subagent default) go upstream as pull requests so
the project maintains them; only the bespoke features in this plan live permanently
in your fork.

A note on file paths: Kilo moves fast, so the paths below are accurate at time of
writing but will drift. Phase 3 makes "map the current code" an explicit deliverable
precisely so later milestones point at real locations in your fork.

---

## Phase 0 — Prerequisites and decisions

**Why.** Nothing builds until the toolchain and the fork exist. Locking this first
prevents every downstream milestone from tripping on environment issues.

**Design.** The decision is settled: fork `Kilo-Org/kilocode` (not opencode, not
from scratch), because you want the in-editor chat and voice, which live in Kilo's
extension layer, and you want the engine, providers, and UI for free. Kilo is open
source under a permissive license; keep its LICENSE and NOTICE intact in your fork.

**Build steps.**
1. Install the toolchain: Bun 1.3.14 or newer, Node.js (CI uses v24), Git, and VS
   Code (or VS Code Insiders); on Windows, install these for your user and confirm
   each is on `PATH`. Java 21 is *optional* for Raya — upstream requires it only for
   the JetBrains plugin and for the repo-level `bun turbo typecheck`, which includes
   that plugin. Since Raya ships only the VS Code extension and the CLI, either
   install Java 21 (SDKMAN's `sdk install java 21-tem` is the easy path) or skip it
   and run typechecks with `--filter=!@kilocode/kilo-jetbrains`.
2. Create a GitHub fork of `Kilo-Org/kilocode` under your account, then clone it
   locally and add the upstream remote: `git remote add upstream
   https://github.com/Kilo-Org/kilocode.git`.
3. From the repo root, run `bun install` and let it complete without errors.
4. Read the repo's `CONTRIBUTING.md`, `packages/kilo-vscode/AGENTS.md`, and the
   development-environment docs, since they define the canonical build commands.

**Definition of Done.**
- `bun --version` reports 1.3.14+; `git`, `node`, and `code` all resolve on `PATH`;
  and, if you chose to install it, `java -version` reports 21.
- The fork is cloned, `origin` points at your fork, `upstream` at `Kilo-Org/kilocode`.
- `bun install` completes cleanly from the repo root (exit code 0, no missing-dep
  errors).

**Tests.** Run each version command and `git remote -v`; capture the output. A
clean `bun install` is the gate.

---

## Phase 1 — Stand up the fork unchanged

**Why.** Before changing anything, prove you can build and run Kilo exactly as
upstream ships it. If your own build works before you touch it, every later problem
is your change, not your setup.

**Design.** Kilo is a Bun monorepo. The runtime, agent engine, local HTTP server,
session management, and TUI live in `packages/opencode`. The VS Code extension,
webview chat UI, and packaging live in `packages/kilo-vscode`. The extension bundles
its own `kilo` CLI binary rather than using a system install, so the extension build
compiles the CLI too. The generated TypeScript SDK for the local server API lives in
`packages/sdk/js`.

**Build steps.**
1. From `packages/opencode`, run `bun run typecheck` and `bun test` to confirm the
   runtime is healthy on your machine. Run tests from inside the package — the root
   `bun test` intentionally exits with failure by design, so never gate on it.
2. Build a standalone CLI binary: `./packages/opencode/script/build.ts --single`,
   and run the produced binary (`packages/opencode/dist/@kilocode/cli-<platform>/bin/kilo`)
   to confirm it launches. This path is current as of writing; once Phase 3's
   FORK-MAP exists, treat it as the source of truth if it has drifted.
3. From `packages/kilo-vscode`, run `bun run compile` (type-check, lint, build the
   extension and webview bundles).
4. From `packages/kilo-vscode`, run `bun run package` to produce a `.vsix`, or use
   `bun run snapshot:install` to build and install it straight into VS Code.
5. Launch VS Code, confirm the extension activates, add one provider (your existing
   BYOK config from the Chinese-models setup), and run a trivial chat turn.

**Definition of Done.**
- `bun run package` produces a `.vsix` with no build errors.
- Installing that `.vsix` yields a working extension: the sidebar chat opens, a
  provider connects, and a "read this file" prompt executes a tool call successfully.
- The bundled `bin/kilo` runs, and `kilo run --auto "print hello"` completes in a
  scratch repo.
- Your build's version string embeds your commit SHA (snapshot builds do this
  automatically), proving you are running your artifact, not the marketplace one.

**Tests.** A manual chat turn that reads a file (proves tool-calling end to end) and
a `kilo run --auto` smoke command (proves the CLI path). Save both outputs.

---

## Phase 2 — Rebrand to Raya (Eden's identity)

**Why.** So the build is unmistakably Raya, carries Eden's logo, can be installed
alongside the official Kilo without collision, and namespaces its own commands and
settings.

**Design.** VS Code identifies an extension by `publisher.name`. Changing that plus
the display name, icon, and command namespace makes a distinct extension. The icon
is Eden's logo, which lives in the Eden repo at `public/brand-book/`
(`eden-logo.svg`, `EdenLogoDark.svg`, `EdenLogoLight.svg`). VS Code extension icons
must be a square **PNG** (128×128 recommended), not SVG, so the one conversion step
is rasterizing the Eden logo to PNG at the sizes you need. Keep the change surgical
and marked, because `package.json` is a high-traffic file upstream.

**Build steps.**
1. Copy the Eden logo into the fork (for example `packages/kilo-vscode/assets/`) and
   rasterize it to a 128×128 (and 256×256) PNG for the extension icon; keep a
   light/dark pair from `EdenLogoLight.svg`/`EdenLogoDark.svg` for in-UI use.
2. In `packages/kilo-vscode/package.json`, set `publisher`, `name` (`raya`),
   `displayName` (`Raya`), `description`, and `icon` (the PNG). Mark the block with
   `// raya_change`.
3. Give commands, views, and configuration keys a distinct `raya.*` prefix so they
   do not clash with `kilocode.*` when both are installed. Replace the visible
   "Kilo" product name in the webview chrome with "Raya", using the light/dark logo.
4. Rebuild (`bun run compile` then `bun run package`) and install alongside the
   official Kilo.

**Definition of Done.**
- The Extensions panel shows the extension as **Raya** with Eden's logo as its icon,
  installable at the same time as the official Kilo Code without conflict.
- Raya's commands appear under the `raya.*` prefix in the Command Palette; the
  official Kilo commands still appear under theirs.
- The webview shows the Raya name and the Eden logo (correct light/dark variant for
  the theme), with no leftover "Kilo Code" branding in the primary chrome.
- The rebrand is confined to `// raya_change`-marked edits, verifiable by grep.

**Tests.** Install both extensions in one VS Code; confirm no command/setting
collisions, that Raya activates independently, and that the icon and in-UI logo
render correctly in both light and dark themes.

---

## Phase 3 — Map the codebase (orientation deliverable)

**Why.** Every feature milestone needs to know exactly where to hook in. Producing a
map now turns "somewhere in the engine" into named files, and it is cheap insurance
against the paths having drifted since this plan was written. This is not optional and
not a "later" task: it is a hard gate. No feature milestone (A–I) begins until
`docs/FORK-MAP.md` exists and is current, and the map is refreshed after any upstream
rebase that moves these seams. The specific paths quoted elsewhere in this plan
(the CLI binary location, build scripts, prompt files) are accurate as of writing but
the FORK-MAP is their source of truth the moment it exists.

**Design.** You are locating the seams the features plug into: the tool registry,
the session/turn runtime, the agent definitions and mode prompts, the server
endpoints, the webview chat UI, and the SDK generation step.

**Build steps.** Explore the fork and record, in a new `docs/FORK-MAP.md`, the
current location of each of the following:
1. The **tool registry** — where tools (read, edit, bash, browser, task) are defined
   and dispatched, and how a new tool is registered and surfaced to the model.
2. The **session/turn runtime** in `packages/opencode` — where a turn starts and
   ends, where it goes idle, and where continuation could be injected.
3. The **agent definitions** (`packages/opencode/src/agent/…`) and the **mode
   prompts** (`packages/opencode/src/session/prompt/…`, including `plan.txt`).
4. The **subagent/task tool** — how it spawns a child session, and how permission
   and model resolution work (agent override → global subagent default → inherited).
5. The **local server endpoints** (`packages/opencode/src/server/…`) and the SDK
   regeneration step (`./script/generate.ts`).
6. The **webview chat UI** (`packages/kilo-vscode/webview-ui/…`, React) and how it
   exchanges messages with the extension host and renders tool calls.

**Definition of Done.**
- `docs/FORK-MAP.md` exists and names the real file(s) for all six subsystems, each
  with a one-line note on how to extend it.
- For at least the tool registry and the webview message channel, the map includes
  the exact function or file where a new entry is added.
- The map is treated as a prerequisite: no Milestone A–I is started until it is
  complete, and it carries a "last verified against commit `<SHA>`" line so a later
  rebase knows when to refresh it.

**Tests.** A reviewer (or the next goal pass) can open each referenced path and find
what the map claims is there.

---

## Milestone A — Native goal mode (Codex / Cursor style)

**Why.** This is the feature that justifies the fork: start `/goal <objective>` from
chat and have the agent work to a verified finish across turns, with no CLI loop.

**Design.** A goal is a durable, thread-scoped completion contract plus continuation
logic, exactly the shape Codex uses (persisted goal state, model-facing goal tools,
runtime continuation at turn boundaries) and the behavior in the Cursor `/goal`
command: parse the objective, arm the goal once, do real work immediately, keep the
full objective intact across turns, and refuse to declare completion without a
requirement-by-requirement audit against real evidence. Per your preference there is
no time or token budget; a goal runs until complete, blocked, or cleared. You already
designed this behavior in the file-based `goal-runner`; here you port it into the
runtime so it is native and chat-driven.

The completion audit is deliberately evidence-source-agnostic. Command output, unit
and integration tests, and build results are first-class evidence and are sufficient
to complete a goal, so goal mode is fully usable before the browser or e2e milestones
exist — which is exactly the evidence most of *this* plan's own DoDs produce.
Authenticated browser walkthroughs (Milestone G) are a stronger, additional evidence
source the audit picks up once available; they are never a prerequisite for it. This
is the resolution to the A-before-G ordering question: A ships and works on
command/test evidence, and G later lets a goal additionally require "the app actually
works."

**Build steps.**
1. Define a `GoalState` type (objective, status of `active|paused|complete|blocked`,
   created-at, and usage accounting) and persist it per session in the session store.
2. Add server endpoints to create, get, update, and clear a goal; regenerate the SDK
   with `./script/generate.ts`.
3. Add model-facing tools `create_goal`, `get_goal`, `update_goal` with bounded
   authority: the model may create when none exists and may mark complete only with
   evidence; pause, resume, and clear are user- or runtime-controlled.
4. Implement continuation in the turn runtime: when a turn ends, the thread is idle,
   and a goal is active, enqueue a continuation turn; suppress the next automatic
   continuation if a turn made no tool calls, so it can never spin. When the goal is
   `blocked` or `complete`, stop continuation entirely.
5. Implement the completion audit: before any `update_goal(status=complete)`, the
   agent must derive the objective's concrete requirements, verify each against real
   evidence (files, command output, tests, rendered UI), and treat uncertain or
   missing evidence as not done. When it cannot make honest progress — a missing
   decision, an external dependency, or a check it cannot pass without violating a
   constraint — it sets the goal `blocked` with a plain reason instead of faking
   completion or thrashing the same file.
6. Wire the `/goal` chat command in the webview: parse `/goal <objective>` (empty →
   show usage; a leading time limit like `30m` → say time limits are unsupported and
   proceed without one), arm the goal, and begin the first unit of real work in the
   same turn rather than stopping after planning.
7. Surface goal state in the chat UI (an active-goal banner with pause/resume/clear)
   and a compact progress log per continuation.

**Definition of Done.**
- Typing `/goal <objective>` in chat arms a persistent goal and the agent does real
  work in the same turn (it does not stop after planning).
- After a turn ends with the goal active and the thread idle, the runtime starts a
  continuation turn automatically, with no user prompt; a turn that makes no tool
  calls does not trigger another automatic continuation.
- Goal state survives a VS Code window reload (persisted, not in-memory only).
- `/goal` with no objective prints `Usage: /goal <objective>`; a leading `30m`/`2h`
  is rejected with a plain message and the goal is created without it.
- The agent marks the goal complete only after a requirement-by-requirement audit
  passes; a deliberately unmet requirement keeps the goal active instead of completing.
- When the agent cannot progress honestly it sets the goal `blocked` with a reason,
  continuation stops, and the block surfaces in the UI — rather than the loop spinning
  or a false completion.
- Pause, resume, and clear each work from the UI and are reflected in `get_goal`.

**Tests.** An automated runtime test that arms a goal, drives idle turns, and asserts
continuation fires and then stops on completion; a scripted objective whose success
is a passing command, verifying the audit only completes when the command is green;
a manual reload test for persistence.

---

## Milestone B — Intelligent auto-routing (the "Chief")

**Why.** Kilo's auto mode is weak. You want Cursor-grade routing: given a prompt, the
system picks the best-suited agent and model automatically, so you rarely choose
manually.

**Design.** Add an `Auto` primary agent backed by a fast, cheap "Chief" router. On
each new request the Chief classifies intent and selects a target agent and model
from the registry, using each agent's `description` as its capability card plus a
routing policy, and returns a structured decision (target agent, model, whether to
plan first, confidence, and a one-line reason). High-confidence decisions hand off
silently; low-confidence decisions fall back to an in-chat option prompt (Milestone
C) so you disambiguate rather than the router guessing. Keep the Chief a separate,
inexpensive model so routing latency and cost stay negligible.

**Build steps.**
1. Build an agent registry accessor that exposes each agent's id, description, model,
   and permissions to the router.
2. Write the Chief routing prompt: input is the user request plus the registry and
   policy; output is a strict JSON decision (`agent`, `model`, `needs_plan`,
   `confidence`, `reason`).
3. Bind the Chief to a fast model (a `-flash`/`-turbo`-class variant) and enforce
   structured output with validation and a safe default on parse failure.
4. Implement the `Auto` agent: call the Chief, then delegate to the chosen agent via
   the subagent/task mechanism (Milestone D), passing the crafted brief.
5. Add a confidence threshold: below it, raise an option prompt (Milestone C) with
   the top candidates instead of committing.
6. Log every routing decision (request, chosen agent/model, confidence, reason) for
   evaluation and tuning.

**Definition of Done.**
- Selecting `Auto` and sending a coding task routes to the coder; a design task to
  the designer; a research task to the researcher; an accounting task to the
  accountant; a hard-reasoning/architecture task to the reasoner — verified on a
  labeled prompt set with a stated accuracy target (for example ≥ 90% on the set).
- Routing adds only a small, measured latency (the Chief call) and uses the cheap
  model, confirmed in the decision log.
- Below the confidence threshold, the system asks via an in-chat option prompt rather
  than guessing.
- Every decision is logged with agent, model, confidence, and reason.

**Tests.** A committed fixture of labeled prompts → expected agent, run through the
router, asserting accuracy ≥ target; a latency assertion on the Chief call; a
low-confidence case that triggers the option prompt.

---

## Milestone C — Ask mode with in-chat selectable options

**Why.** You want Cursor's ask experience: when a decision is genuinely yours, the
agent presents selectable options in the chat and you click, instead of typing free
text or the agent guessing.

**Design.** Add an `ask_options` tool the model calls when blocked on a user
decision. Its schema carries one or more questions, each with a prompt and 2+ options
and an `allow_multiple` flag, plus an implicit "Other" free-text choice. The webview
renders option cards; the selection returns to the model as the tool result and the
turn continues. This is also the fallback target for low-confidence routing (B) and
for destructive-action confirmations.

**Build steps.**
1. Define the `ask_options` tool schema (questions[], each with `prompt`,
   `options[]{id,label}`, `allow_multiple`) and register it in the tool registry.
2. Route the tool call over the webview message channel; render selectable option
   cards (single- or multi-select), always including an "Other" free-text input.
3. Capture the selection, return it as the tool result, and resume the turn.
4. Add a guideline in the agents' prompts to prefer `ask_options` over free-text
   questions when the choice is discrete and the user's to make.

**Definition of Done.**
- An agent can emit a question that renders as clickable options in chat; selecting
  one (or several, when `allow_multiple`) returns the choice to the agent and the
  turn continues using it.
- "Other" free-text is always available and flows back correctly.
- The tool is reused by low-confidence routing and by destructive-action prompts.

**Tests.** A scripted turn that calls `ask_options`, a UI test that a click resolves
the tool and the agent proceeds on the choice, and a multi-select case.

---

## Milestone D — Intelligent subagent calling

**Why.** You want main→subagent delegation as strong as Cursor's (the main agent
opens a fresh sub-thread and briefs the subagent) or better, with isolation, parallel
fan-out, and visible progress.

**Design.** Kilo already has a `task` tool that spawns a child session and resolves
the subagent's model (agent override → global subagent default → inherited) and
inherits the parent's permissions. Enhance it so the parent (a) selects the subagent
by default via the Chief router (auto), treating an explicit subagent name as an
override rather than the norm, (b) composes a structured hand-off brief (objective, context,
constraints, expected return), (c) runs it in an isolated session surfaced as a
nested, collapsible thread with live progress, (d) can fan out several subagents in
parallel, and (e) receives a synthesized result rather than raw transcript.

**Build steps.**
1. Extend the `task` tool so subagent selection defaults to `auto` — the Chief routes
   to the best-fit agent — with an optional explicit subagent name as an override, plus
   a structured brief. Auto is the primary path, not an alternate mode.
2. Ensure each subagent runs in an isolated child session with its own context,
   inheriting permissions, resolving its model by the documented precedence.
3. Surface subagents in the webview as nested threads with streaming progress and a
   final summarized result the parent consumes.
4. Support parallel spawns with a join step, and a per-subagent step cap to bound
   runaway children.
5. Return a synthesized result (and artifacts/paths), not the full child transcript,
   to keep the parent context clean.

**Definition of Done.**
- A primary agent spawns a subagent through `auto`-selection by default — the Chief
  picks the best-fit agent — and can still target one by explicit name when asked; each
  runs in an isolated session and returns a synthesized result, and the child's model
  resolves by the documented precedence (specialist pins win over the subagent default).
- Subagents appear as nested threads in the UI with live progress.
- Two or more subagents can run in parallel and their results join correctly.
- A subagent cannot exceed its step cap or escape inherited permissions.

**Tests.** A delegation test asserting that auto-selection routes to the right
specialist and that model resolution and permission inheritance hold; a parallel
fan-out test asserting both results return and join; a UI test showing the nested
thread and final summary.

---

## Milestone E — Canvas mode

**Why.** You want Cursor's canvas: a live, interactive React artifact rendered beside
the chat for analyses, tools, dashboards, and data-heavy output.

**Design.** Add a canvas panel (a webview) that renders a React artifact the agent
authors (a `.canvas.tsx`-style file). The extension bundles the artifact with esbuild
and renders it in the panel, refreshing on edit, in a sandbox with a defined data
channel. The agent has tools to create and update the canvas, and can read its
current source to iterate.

**Build steps.**
1. Define the canvas artifact format and a project location for canvas files.
2. Build a canvas webview panel that hosts a React runtime.
3. Build an esbuild pipeline that compiles the artifact to a bundle the panel loads,
   with a sandbox and a typed data channel between extension and canvas.
4. Add `create_canvas`/`update_canvas` tools and live refresh on file change.
5. Handle build/runtime errors gracefully, surfacing them to the agent to fix.

**Definition of Done.**
- The agent can create a canvas artifact that renders live in a panel beside the
  chat, and updating the file refreshes the panel without a manual reload.
- A canvas can receive data from the agent through the defined channel and display it.
- A syntax or runtime error in the artifact is shown clearly and is fixable by the
  agent on the next turn rather than crashing the panel.

**Tests.** Create a canvas that renders a chart/table from passed data; edit it and
assert live refresh; introduce an error and assert graceful reporting.

---

## Milestone F — Browser tool with an in-editor browser view

**Why.** You want a real browser the agent can drive, viewable inside VS Code like
Cursor, not popped out — which also underpins authenticated smoke and e2e testing.

**Design.** Two layers. The **automation** layer is a Playwright-driven browser with
a persistent context (so logins persist) exposing navigate, snapshot, click, type,
select, scroll, screenshot, and evaluate. The **view** layer renders that same
browser inside a webview panel using CDP screencasting: launch Chromium with a remote
debugging port, connect over CDP, call `Page.startScreencast` to stream frames into
the panel, and forward the panel's mouse and keyboard events back through the CDP
Input domain. This is the proven approach behind VS Code's screencast browsers, and
it bypasses the iframe restrictions a plain embed would hit. Agent tools and the
visible panel share one browser instance, so you watch the agent act in real time.

**Build steps.**
1. Build a browser session manager on Playwright with a persistent `userDataDir`
   context and a single shared instance.
2. Expose agent tools that operate that shared instance (navigate, snapshot, click,
   type, select, scroll, screenshot, evaluate).
3. Launch the browser with `--remote-debugging-port`; open a CDP connection.
4. Build a webview panel that receives `Page.startScreencast` frames and renders
   them, with a toolbar (URL bar, back, forward, reload).
5. Forward mouse and keyboard input from the panel to the browser via CDP Input.
6. Add an element picker that sends a selected element's selector into the agent
   context (optional but high-value).

**Definition of Done.**
- The agent can drive a browser through its tools and the same session renders live
  inside a VS Code panel; you can watch navigation and clicks happen in real time.
- Input in the panel (typing, clicking) is forwarded to the real page.
- The browser uses a persistent context, so a login performed once survives across
  navigations and tool calls.
- No external browser window is required for normal operation.

**Tests.** Drive a navigation and a click via tools while watching the panel update;
type into the panel and assert the page received it; confirm a cookie/login persists
across a fresh navigation.

---

## Milestone G — Agent smoke and end-to-end testing (authenticated walkthroughs)

**Why.** You want agents to test like a real user: log in and walk through flows,
asserting the app actually works, and feed that evidence into goal-mode completion.

**Design.** Build on Milestone F's shared, persistent browser. Capture an
authenticated session once (log in, save Playwright `storageState`) so the agent
runs as the real, logged-in user. Provide a testing capability that runs either a
scripted flow or an agent-driven exploratory walkthrough, asserting on visible state,
network responses, and console errors, capturing screenshots at each step, and
returning a structured pass/fail report. Wire a green e2e run in as valid evidence
for goal-mode's completion audit, so "done" can require the app to actually work.

**Build steps.**
1. Add an auth-capture flow that logs in once and saves `storageState`, reused by
   subsequent runs.
2. Build a smoke-test tool that runs a named flow and returns a structured result
   (steps, assertions, screenshots, console/network findings, pass/fail).
3. Add an agent-driven exploratory mode: the agent navigates like a user, asserts
   expected outcomes, and reports.
4. Expose results as evidence the completion audit (Milestone A) can consume.
5. Store screenshots and a report artifact per run for inspection.

**Definition of Done.**
- The agent can run an authenticated walkthrough of a target app as the logged-in
  user and return a structured pass/fail report with per-step screenshots.
- Assertions cover visible state and at least one of network or console signals; a
  deliberately broken flow reports failure with the failing step identified.
- A goal whose done-condition is "the smoke test passes" completes only when the
  test is actually green.

**Tests.** Run the smoke suite against a sample app in both a passing and a
deliberately broken state; assert correct pass/fail and that goal-mode respects it.

---

## Milestone H — Voice: speech-to-text, text-to-speech, and voice mode

**Why.** You want to speak to Raya and hear it, using your own Chinese speech
models via your API keys.

**Design and model choice.** Two directions, both provider-pluggable so you can swap
models by config.
- **Text-to-speech:** MiniMax speech models are the standout for Chinese quality and
  expressiveness and you already have MiniMax wired. Use **speech-2.6-turbo** for
  interactive voice (agent-grade latency under ~250 ms) and **speech-2.8-hd** when you
  want maximum quality for longer spoken output. MiniMax exposes a streaming
  WebSocket T2A endpoint, which is what makes real-time speech feel live. Keep
  CosyVoice 2 in mind as an open-weights, self-hostable fallback if you ever want to
  remove the API dependency.
- **Speech-to-text:** the FunASR family (Alibaba) leads Chinese ASR. Use
  **SenseVoice-Small** as the default (fast, CPU-viable, multilingual, ~7.8% Chinese
  CER), **Paraformer-zh-streaming** when you want real-time partial transcripts, and
  **Fun-ASR-Nano** or **Qwen3-ASR** when you have a GPU and want maximum accuracy on
  hard, proper-noun-heavy audio. FunASR can serve an OpenAI-compatible
  `/v1/audio/transcriptions` endpoint, so you hook it exactly like any other
  provider; a hosted Alibaba DashScope Paraformer endpoint is the zero-ops
  alternative.
- **Voice mode** ties them together: capture the mic in the webview, stream audio to
  the STT endpoint, place the transcript in the composer, run the agent, then send the
  response text to the TTS endpoint and play it. Support both push-to-talk and a
  hands-free VAD loop.

**Build steps.**
1. Add a speech provider configuration (STT and TTS endpoints, models, API keys),
   reusing the settings-hub pattern: store keys in secret storage, mirrored to the
   gitignored local config only when the CLI needs them.
2. STT: capture microphone audio in the webview, chunk or stream it to the configured
   STT endpoint (OpenAI-compatible), and insert the returned transcript into the chat
   composer; support streaming partials with Paraformer-streaming.
3. TTS: send response text to MiniMax's streaming T2A WebSocket, receive audio, and
   play it in the webview with barge-in (stop on new user speech).
4. Voice mode: a controller that runs mic → STT → agent → TTS, with push-to-talk and
   a VAD hands-free loop, and clear on/off state in the UI.
5. Make model and voice selectable in settings (turbo vs HD for TTS; SenseVoice vs
   Paraformer vs Nano for STT).

**Definition of Done.**
- Speaking into the mic produces an accurate transcript in the composer (verified on
  a Chinese and an English sample), using your configured STT endpoint and key.
- The agent's response is spoken back through MiniMax TTS, streaming with low latency
  on the turbo model.
- Voice mode runs a full spoken round-trip (speak → agent acts → spoken reply) in
  both push-to-talk and hands-free modes, with barge-in stopping playback.
- STT and TTS models are swappable from settings without code changes; keys live in
  secret storage (mirrored to the gitignored local config only for the CLI), never
  committed.

**Tests.** A transcription accuracy check on known Chinese and English clips; a TTS
latency check on turbo; a full voice-mode round-trip; a config-swap test proving
model changes take effect.

---

## Milestone I — Settings and provider hub (redesigned UX)

**Why.** Kilo's settings work but are cramped and easy to misconfigure. Raya's edge
should start here: one clear place to add a provider, paste a key, choose which model
each agent uses, and set up speech — guided enough that a first-time user cannot get
lost, and safe enough that keys never leak. Its one-click "Test connection" confirms
a provider is wired using only a free model-list call, so setup never depends on a
paid request.

**Design.** A dedicated settings webview, not a wall of raw `settings.json`. Organize
it into sections: **Providers** (add a BYOK provider by name, base URL, and key, each
with a one-click "Test connection"), **Agents & models** (map every agent/role to a
model through a searchable picker populated from the connected providers), **Speech**
(STT and TTS endpoints, models, and voice selection), and **Goals & routing** (the
Chief's model, confidence threshold, and continuation defaults). Keys live in VS
Code's encrypted secret storage, shown masked and mirrored to the gitignored local
file only when the CLI needs them. The "Test connection" button calls the provider's
model-list endpoint, which is free and needs no inference, so a provider can be proven
wired without a paid request. Support import/export of the non-secret
config so a new machine is a paste away. Build the **Providers** and **Agents &
models** sections first — they are what unlock keyless provider testing, which is why
this milestone is sequenced early — and add the **Speech** and **Goals & routing**
sections as Milestones H and B land, so the hub grows with the features it configures
rather than shipping dead panels.

**Build steps.**
1. Build a settings webview with the four sections and a persistent left-nav.
2. Providers: add/edit/remove a BYOK provider (name, base URL, key), store the key in
   secret storage, and add a "Test connection" that hits the model-list endpoint and
   shows a green/red result with the returned model count.
3. Agents & models: render each agent with a searchable model picker populated from
   the connected providers, writing the per-agent `model` pin.
4. Speech: fields for STT and TTS endpoints, model, and voice, validated the same way.
5. Goals & routing: expose the Chief model, the confidence threshold, and the
   continuation defaults.
6. Add import/export of the non-secret config (providers minus keys, the agent-model
   map, routing settings) as a single file.

**Definition of Done.**
- A user can add a provider, paste a key, click "Test connection", and see a green
  result driven by a real model-list call, which needs no inference spend.
- Every agent's model is selectable from a searchable picker, and the choice persists
  and takes effect on the next run.
- Keys are stored in secret storage (never shown in plaintext, never written to a
  committed file) and only mirrored to the gitignored local config for the CLI.
- Speech and routing settings are editable here and consumed by Milestones H and B.
- Exported config re-imports on a fresh install and reconstitutes everything except
  the secret keys.

**Tests.** A "Test connection" against a reachable base URL returns green using only
the free model-list call; a key round-trips through secret storage without appearing
in any file; an agent-model change is reflected in the next run; an export/import
cycle restores the non-secret config.

---

## Cross-cutting: configuration, testing, and release

**Model and provider configuration.** The Chief router, the speech endpoints, and
every agent's model all resolve through Kilo's provider config and the per-agent
`model` pins you already use. Keys live in three gitignored places, never in a
committed file: provider keys in VS Code's encrypted secret storage (surfaced by the
settings hub, Milestone I), MCP-server keys in `.kilocode/mcp.json`, and the build's
test harness in `raya-provider-keys.local.json`. **DoD:** a fresh clone plus a
filled-in local config brings up routing, voice, and agents with no code edits.

**Testing and CI.** Each milestone ships unit tests for its logic, an integration
test through the server/SDK where it crosses that boundary, and (for browser, e2e,
and voice) a live check against a sample app or clip. **DoD:** `bun test` in both
`packages/opencode` and `packages/kilo-vscode` passes, and the extension packages
cleanly, before any milestone is called done.

**Testing against live providers.** Your keys are funded — DeepSeek, GLM, Kimi, and
MiniMax — so tests can hit the real endpoints directly, inference included. Hand Raya
the keys in the gitignored `raya-provider-keys.local.json`, whose provider IDs, base
URLs, and model IDs already mirror Parts 4 and 5 of the setup guide, so you only paste
the keys. Still keep a **mock provider** (scripted responses and tool calls) as the
default for the structural tests — goal continuation firing and then stopping, the
router returning valid JSON, `ask_options` resolving, subagent isolation and model
precedence, canvas refresh, browser input forwarding — because those care about the
plumbing, not the model, so a mock keeps them deterministic and free in CI. Use the
live keys for the checks that genuinely need a real model: end-to-end tool-calling and
the provider-specific numbers like MiniMax TTS latency, a Chinese-CER transcription
figure, and routing accuracy. A **free local OpenAI-compatible endpoint** (Ollama or
llama.cpp) stays a handy third option when you want a real model in CI with no spend.
Qwen, once treated as unfunded, is now live too: a direct completion call against its
endpoint returned normally (verified 2026-08-27), so its vision and web-research paths
can run against the real model like the others rather than being mocked. Keep a funded
vision-capable substitute (`MiniMax-M3`, `kimi-k3`, or `deepseek-v4-flash-vision-exp`)
in mind only if you want to avoid Qwen spend on a given run. And throughout, the agents
*building* Raya run on your Cursor models, independent of all of this.

**Upstream sync discipline.** Mark every fork edit with your marker, keep patches
small and localized, and rebase onto `upstream/main` on a regular cadence, resolving
conflicts against your marked hunks. Send generic fixes upstream as PRs so you stop
carrying them. **DoD:** a scripted `git fetch upstream && git rebase upstream/main`
completes with conflicts only in marked regions, and a rebuild after rebase still
passes Phase 1's DoD.

**Release and install routine.** Script the loop "pull upstream → rebuild CLI and
extension → reinstall VSIX" into one command so updating Raya is a single step.
**DoD:** one command produces a fresh `.vsix` and installs it, and the installed
build reports the new commit SHA.

---

## Recommended build sequence

The dependency order that minimizes rework: Phase 0 → Phase 1 → Phase 2 → Phase 3
(a hard gate — no milestone starts until the FORK-MAP is complete),
then Milestone I's provider and model sections (whose "Test connection" confirms
providers with a free model-list call; its speech and routing panels land
later with H and B), then Milestone A (goal mode) and Milestone D (subagents) as the
engine core, then
Milestone B (routing, which uses D) and Milestone C (ask options, which B leans on),
then Milestone F (browser view) followed by Milestone G (e2e, which builds on F),
then Milestone E (canvas), and finally Milestone H (voice). Build C before B if you
want the routing fallback UI ready first. Ship each milestone only when its DoD is
proven against the running build, commit behind your fork marker, and open an upstream
PR for anything generic before moving on.

## Risks and scope discipline

The item that most rewards care is goal mode's runtime continuation and a trustworthy
completion audit; a goal that declares victory on weak evidence is worse than none,
so spend your attention there. The browser view's input-forwarding fidelity and the
voice loop's latency are the other spots that reward care. The standing cost is the
rebase tax,
which your marker discipline and upstream PRs keep small. The largest risk is scope:
hold this as "Kilo plus these features," not a new platform. If it becomes a product
you intend to sell, that is a deliberate, separate decision — decide it on its own
terms rather than drifting into it.
