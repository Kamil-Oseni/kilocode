# Raya Build — Goal Prompts (in order)

These are the `/goal` prompts to drive the Raya build in Cursor, one at a time, in
the order the plan recommends. Each maps to a section of `Building-Raya.md` and treats
that section's Definition of Done as the completion contract.

## Before you run these

- The build happens in your **forked kilocode repo**, already set up at
  `C:\Users\User\Desktop\raya` (origin = your fork, upstream = Kilo-Org/kilocode). Both
  `docs/Building-Raya.md` and `docs/Raya-Goal-Prompts.md` are already copied in, and
  `raya-provider-keys.local.json` sits at the fork root (gitignored). Just open that
  folder in Cursor — the prompts below reference `docs/Building-Raya.md`.
- Your agent fleet (deep-reasoner, designer, goal-runner, media-runner, primary-coder,
  web-researcher) and house rules are installed globally, so they're already available
  in the fork when you use Kilo/Raya there.
- Run **one goal at a time**, in the order below. Do not hand the agent a single
  goal for all of Raya — the plan itself says ship each milestone only when its DoD
  is proven.
- **Pin the model** (don't use Auto). Recommended driver: **GPT‑5.6 Sol** — it leads
  agentic-coding and long-horizon engineering benchmarks and has the large context a
  monorepo needs. Use **medium** effort for most milestones and **high/max** for the
  hardest (A goal runtime, F browser/CDP, H voice). Drop to **GPT‑5.3 Codex** only for
  cheap, mechanical passes where cost matters more than depth.
- `/goal` is still rolling out in Cursor; if you don't see it, start a fresh chat.
- Your DeepSeek, GLM, Kimi, and MiniMax keys are funded, so live tests run on those.
  Qwen stays unfunded — verify it only at the connection/model-list level, and for any
  test that would need a real Qwen response (vision or web-research), substitute a
  funded vision-capable model (MiniMax-M3, kimi-k3, or deepseek-v4-flash-vision-exp)
  or the mock/local endpoint.

---

## 0. Foundation — Phases 0–3

```text
/goal Stand up Raya per docs/Building-Raya.md. Complete Phase 0, Phase 1, Phase 2, and Phase 3, in that order. Treat each phase's Definition of Done as the completion contract: you are done only when every DoD item is proven against the running build with real evidence — actual command output, a packaged .vsix, the installed extension activating, and a committed docs/FORK-MAP.md — not when it looks plausible. Read the whole doc first and follow it exactly: build the fork unchanged before editing anything, mark every fork edit with // raya_change, keep the rebrand surgical, and treat Phase 3's FORK-MAP.md as a hard gate — do not begin any feature milestone. If a decision is genuinely mine (a fork-vs-upstream call, naming, anything destructive or irreversible), stop and ask me with options instead of guessing. Verify with commands and show the evidence; if you cannot make honest progress, tell me exactly what is blocking you rather than faking completion.
```

---

## 1. Milestone I — Settings and provider hub (provider + model sections)

```text
/goal Implement the Providers and Agents & models sections of Milestone I from docs/Building-Raya.md. Done when a user can add a BYOK provider, paste a key, click Test connection and see a green result driven by a free model-list call, and pick each agent's model from a searchable picker that persists. Read the doc and docs/FORK-MAP.md first, hook in at the mapped locations, mark all edits with // raya_change, store keys in secret storage, and add the tests the milestone lists. Run the affected package's tests and a clean extension package build before declaring done. Leave the Speech and Goals & routing panels for later (they land with Milestones H and B). Mark complete only after the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 2. Milestone A — Native goal mode

```text
/goal Implement Milestone A (native goal mode) from docs/Building-Raya.md. Done when every item in that milestone's Definition of Done is proven against the running build: /goal arms a persistent goal and does real work in the same turn, continuation fires automatically when idle and stops on complete or blocked, goal state survives a window reload, the completion audit only marks done after a requirement-by-requirement check passes on real evidence, and an honest block surfaces in the UI instead of spinning or faking success. Read the doc and docs/FORK-MAP.md first and hook in at the mapped runtime/tool/server locations. Mark all edits with // raya_change, regenerate the SDK if you touch server endpoints, and add the runtime and persistence tests the milestone specifies. Use command/test evidence; mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 3. Milestone D — Intelligent subagent calling

```text
/goal Implement Milestone D (intelligent subagent calling) from docs/Building-Raya.md. Subagent selection is auto by default — the Chief routes to the best-fit agent — with an explicit subagent name only as an override; auto is the primary path, not an optional mode. Done when a primary agent spawns a subagent via auto-selection into an isolated session and receives a synthesized result, auto-selection routes to the right specialist, the child's model resolves by the documented precedence, subagents appear as nested threads with live progress, two or more can run in parallel and join correctly, and a subagent cannot exceed its step cap or escape inherited permissions. Read the doc and docs/FORK-MAP.md first, hook in at the mapped task-tool location, mark all edits with // raya_change, and add the delegation (including auto-routing), parallel fan-out, and UI tests the milestone lists. Run the affected package's tests before declaring done. Mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 4. Milestone B — Intelligent auto-routing (the "Chief")

```text
/goal Implement Milestone B (intelligent auto-routing) from docs/Building-Raya.md. Done when selecting Auto routes coding, design, research, accounting, and hard-reasoning tasks to the right agent at or above the stated accuracy target on a committed labeled prompt set, the Chief runs on a cheap fast model with only small measured latency, low-confidence decisions raise an in-chat option prompt instead of guessing, and every decision is logged with agent, model, confidence, and reason. Read the doc and docs/FORK-MAP.md first, reuse the subagent mechanism from Milestone D, mark all edits with // raya_change, and add the labeled-fixture accuracy test, a latency assertion, and the low-confidence case. Mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 5. Milestone C — Ask mode with in-chat selectable options

```text
/goal Implement Milestone C (ask mode with in-chat selectable options) from docs/Building-Raya.md. Done when an agent can emit a question that renders as clickable option cards in chat, selecting one or several (with allow_multiple) returns the choice to the agent and the turn continues on it, an Other free-text choice is always available and flows back, and the tool is reused by low-confidence routing and destructive-action prompts. Read the doc and docs/FORK-MAP.md first, register the ask_options tool and route it over the webview message channel, mark all edits with // raya_change, and add the scripted-turn, click-resolves, and multi-select tests. Mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 6. Milestone F — Browser tool with an in-editor browser view

```text
/goal Implement Milestone F (browser tool with an in-editor browser view) from docs/Building-Raya.md. Done when the agent can drive a Playwright browser through its tools while the same session renders live inside a VS Code panel via CDP screencasting, panel input (typing, clicking) is forwarded to the real page, the browser uses a persistent context so a login survives across navigations, and no external browser window is needed for normal operation. Read the doc and docs/FORK-MAP.md first, build the shared browser session manager and the screencast webview, mark all edits with // raya_change, and add the drive-and-watch, input-forwarding, and login-persistence tests. Mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 7. Milestone G — Agent smoke and end-to-end testing

```text
/goal Implement Milestone G (agent smoke and end-to-end testing) from docs/Building-Raya.md. Done when the agent can run an authenticated walkthrough of a target app as the logged-in user and return a structured pass/fail report with per-step screenshots, assertions cover visible state plus at least one of network or console signals, a deliberately broken flow reports failure with the failing step identified, and a goal whose done-condition is "the smoke test passes" completes only when the test is actually green. Read the doc and docs/FORK-MAP.md first, build on Milestone F's shared browser and Playwright storageState, mark all edits with // raya_change, and wire results in as evidence the Milestone A completion audit can consume. Run the passing and broken-state suite before declaring done. Mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 8. Milestone E — Canvas mode

```text
/goal Implement Milestone E (canvas mode) from docs/Building-Raya.md. Done when the agent can create a React canvas artifact that renders live in a panel beside the chat, editing the file refreshes the panel without a manual reload, the canvas can receive data from the agent through the defined channel and display it, and a syntax or runtime error is shown clearly and is fixable on the next turn rather than crashing the panel. Read the doc and docs/FORK-MAP.md first, build the canvas webview and esbuild pipeline with a sandbox and typed data channel, add the create_canvas/update_canvas tools, mark all edits with // raya_change, and add the render-from-data, live-refresh, and error-reporting tests. Mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## 9. Milestone H — Voice (STT, TTS, voice mode) + finish Milestone I

```text
/goal Implement Milestone H (voice) from docs/Building-Raya.md, and add the Speech and Goals & routing panels to the Milestone I settings hub. Done when speaking into the mic produces an accurate transcript in the composer on both a Chinese and an English sample using the configured STT endpoint, the agent's response is spoken back through MiniMax TTS streaming with low latency on the turbo model, voice mode runs a full spoken round-trip in both push-to-talk and hands-free modes with barge-in, STT and TTS models are swappable from settings without code changes, and speech keys live in secret storage mirrored to the gitignored local config only for the CLI. Read the doc and docs/FORK-MAP.md first, mark all edits with // raya_change, and add the transcription-accuracy, TTS-latency, round-trip, and config-swap tests. Your MiniMax key is funded; use it for the live TTS checks. Mark complete only when the DoD verifiably passes; block with a clear reason if stuck.
```

---

## After each milestone

Follow the cross-cutting rules in `Building-Raya.md`: keep every fork edit inside a
`// raya_change` marker, ensure `bun test` passes in the affected package and the
extension packages cleanly, commit behind the marker, and open an upstream PR for
anything generic before moving on. You can build Milestone C before B if you want the
routing fallback UI ready first.
