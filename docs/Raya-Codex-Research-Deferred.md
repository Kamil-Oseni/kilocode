# Codex research for Raya: deferred implementation backlog

> Historical research snapshot. The owner subsequently authorized implementation of the future roadmap. Use [Raya-Implementation-Progress.md](Raya-Implementation-Progress.md) for current priorities and verification status; the original deferral statements below record the scope at the time of research.

Research date: 2026-09-10. **Research and documentation only. No feature in this document is approved for immediate implementation.**

## Priority and handoff rule

The next agent's job is to finish the work already started in [the implementation handoff](Raya-Remaining-Implementation-Handoff.md), including GPT-Live 1, and the existing 39 requirements in [the comprehensive audit](Raya-Comprehensive-Audit.md). New Codex-derived additions come afterward, in a separately resumed phase. This document does not add completion conditions to the current 39-item goal or justify postponing Live voice.

The existing unfinished permission-policy patch is an exception only in the sense that it is already in the working tree: repair and verify it, or safely isolate it before shipping another feature. Do not expand it into a new Codex framework. New compaction architecture, native desktop automation, external-browser integration and other additions below remain deferred.

Before implementing any deferred item, recheck Raya after the 39 requirements are complete. An apparent gap today may already have been addressed. Merge overlapping items into the existing architecture rather than build competing runtimes.

## What the earlier architecture warning means

The sentence “Do not infer private Codex desktop or hosted architecture from public CLI sources” was an evidence rule, not a restriction against learning from Codex.

- We can inspect published code and explain how that code works.
- We can study documented product behavior, screenshots and workflows and design a similar Raya experience.
- We cannot conclude that an entire desktop UI, cloud scheduler, browser controller or computer-use backend is published merely because the CLI is open source.
- A bundled local skill or executable is evidence of its exposed interface, not automatically a license to redistribute it or proof that its implementation is public.

OpenAI's current source inventory lists CLI, SDK, app server, skills and plugins as public components; it explicitly lists the IDE extension and Codex cloud as not open source. The public app server can support richer clients without publishing every client's UI or hosted infrastructure. [Official source inventory](https://learn.chatgpt.com/docs/open-source).

For example, we can reuse or independently adapt a published approval-state pattern. If we like the desktop browser's visual comments, we can implement that interaction in Raya; we should not claim we found or copied its desktop frontend source unless we actually did.

## Evidence and scope

Public Codex core review is pinned to `openai/codex@9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a`. Current product documentation is dated by this research, not pinned to that code revision. Some older developers.openai.com/codex/app links now redirect to ChatGPT Learn and describe capabilities shared with ChatGPT Work; this report preserves that distinction.

| Evidence class | What it supports | What it does not establish |
|---|---|---|
| Pinned public source | Actual state machines, schemas, tests and implementation at that commit | Current private frontend behavior or hosted deployment topology |
| Official product documentation | Described capability, interaction and stated limitation | Source availability or correctness under every race |
| Public skill text | Agent instructions and declared tool workflow | A complete browser/native runtime or permission enforcement |
| Locally bundled skill documentation | The installed package's exposed workflow | Public redistribution rights or universal availability |
| Raya source inspection | An existing implementation or a specific missing path in inspected areas | Full runtime acceptance or proof of global absence |
| Proposed adaptation | Our recommended design and future tests | A claim that Codex implements our proposed solution |

This is a targeted architecture/product comparison, not an exhaustive line-by-line audit of Codex or a live usability test of its desktop application. “Not found” below means not found in the inspected Raya source paths, not proven absent from every package or unmerged branch.

## How skills, tools and execution relate

A skill tells an agent when and how to use a capability. A tool schema tells it what operations are available. The runtime executes those operations, and the permission boundary decides whether they may run. A browser skill alone cannot create a browser, grant account access, make a missing tool callable or ensure that a submitted form was saved.

Raya already follows much of this structure: [built-in discovery](../packages/opencode/src/kilocode/skills/builtin.ts) compiles browser guidance into the CLI, [browser tools](../packages/opencode/src/kilocode/tool/browser-host.ts) expose a bounded interface, the [protocol](../packages/opencode/src/kilocode/browser/protocol.ts) defines requests/results, and the [extension host](../packages/kilo-vscode/src/services/browser-automation/browser-session.ts) operates the browser. Preserve those boundaries.

The public [Playwright skill](https://github.com/openai/skills/blob/main/skills/.curated/playwright/SKILL.md) uses a fresh snapshot, grounded element references, action, renewed observation and artifacts. The separate [interactive Playwright skill](https://github.com/openai/skills/blob/main/skills/.curated/playwright-interactive/SKILL.md) emphasizes persistent browser handles, a requirements-to-QA inventory, and distinct functional and visual checks. They are useful instruction patterns; neither is evidence that the desktop built-in browser uses that exact implementation. Pin their repository revision and inspect per-skill licensing before copying anything. Do not import a skill's temporary sandbox-disabling advice into Raya's product policy.

## Deferred browser and computer-use opportunities

### CDX-B01: Native desktop-app control

**Evidence:** official desktop documentation describes computer use through an installed plugin with operating-system access and per-application permissions. Windows use operates on the active desktop; OS access and application approval are separate. Dedicated integrations are preferred when they fit the task. [Computer use](https://learn.chatgpt.com/docs/computer-use).

The locally installed Windows computer-use skill, version `26.901.51231`, describes a persistent JavaScript interface backed by `@oai/sky`, Windows UI Automation, input delivery and screen capture. Its guidance requires selecting an actual returned application/window rather than inventing handles. These are locally observed interfaces; no public source/license for that exact native runtime was established in this pass. Do not copy bundled binaries into Raya.

**Raya now:** browser automation is substantial. A general native desktop observation/action tool was not found in the inspected CLI tool and extension service areas. Existing process launch, screenshots of web pages and file tools are not equivalent to native application control.

**Future implementation recipe:**

1. Define a Kilo-owned native-host capability contract distinct from BrowserTools: discover apps/windows, inspect accessible elements, capture a window, act on an observed target, and report post-action state. Include capability/version negotiation; do not advertise unsupported OS operations.
2. Bind actions to an observed app/process/window generation and permission scope. Reused OS handles, process restarts, window switches or closed windows must invalidate old references. Do not accept a caller-supplied display name as executable identity.
3. Build a Windows provider using appropriate documented OS APIs or an independently licensed integration. Keep accessibility selection first and screenshot coordinates as an explicit fallback. Record coordinate space, DPI, capture bounds and observation identity.
4. Add a clear UI showing which app is controlled, whether pointer/keyboard takeover is active, and a reliable Stop/Take over action. Persist explicit app decisions with inspect/revoke controls; permission changes must invalidate queued actions.
5. Integrate through normal Raya task ownership, budget, receipts and cancellation. Keep app access separate from permission for a particular external mutation. Never interpret tool instructions inside a screenshot or document as user authorization.

**Acceptance:** real isolated Windows-app fixtures for stale windows, process replacement, multiple monitors/DPI, modal dialogs, denied/revoked permission, user takeover, locked/disconnected sessions and uncertain mutations. Verify original user state is preserved. This is a new product capability, deferred beyond the current browser audit work.

### CDX-B02: Existing-browser tabs and explicit tab mentions

**Evidence:** the documented browser extension connects existing signed-in browser profiles and supports explicit browser/tab context. It is separate from the built-in browser's own profile. [Browser extension](https://learn.chatgpt.com/docs/chrome-extension).

**Raya now:** workspace-owned browser profiles, authentication capture/restore, stable tabs and frames already exist. An extension attached to the user's ordinary Chrome/Edge profile was not found in the inspected browser implementation. Do not replace workspace isolation with automatic personal-profile access.

**Future recipe:** add an optional browser-extension transport behind the existing broker; pair it explicitly to one Raya host; bind every operation to extension installation, browser/profile, observed tab/document and task identity. Add tab mentions containing opaque identity plus observed title/URL. Show the chosen profile/account scope before action and expose disconnect/revoke. Reuse durable transfer and uncertain-action receipts where possible; reconcile host restart rather than replay.

**Acceptance:** two profiles with the same URL, closed/reopened tab, navigated document, revoked pairing, stale mention, worktree switch and sensitive operation under the wrong account. No access simply because an extension has broad browser permissions. Ordinary browsing history access should remain a separate capability, not implicit context collection.

### CDX-B03: Visual browser comments tied to a verifiable page state

**Evidence:** current built-in browser documentation describes a shared preview with element/area comments and styling feedback. It also documents a separate browser profile; the built-in browser is not a CLI/IDE-extension capability. The inspected page states automated built-in uploads are unavailable, whereas Raya already has an authorized upload implementation. Do not assume Codex is ahead in every browser capability. [Browser behavior](https://learn.chatgpt.com/docs/browser?surface=app).

**Raya now:** [browser-panel.ts](../packages/kilo-vscode/src/services/browser-automation/browser-panel.ts) supports displayed-page input, profile controls and resizing. [browser-smoke.ts](../packages/kilo-vscode/src/services/browser-automation/browser-smoke.ts) captures test artifacts. A persistent visual comment-to-task feedback flow was not found in those inspected paths.

**Future recipe:** attach each comment to page/document identity, URL, viewport/DPI, screenshot hash, observed element or region and user text. Store it as task evidence; after navigation mark its anchor stale rather than guessing a new element. Offer region fallback if DOM identity fails. Have the agent explicitly address comments, capture the same state afterward, and leave accept/reopen to the user. Previewed CSS changes must remain proposals until applied through the ordinary edit/review path.

**Acceptance:** responsive reflow, changed DOM, stale screenshot, iframe, zoom, multiple similar elements, deleted targets and keyboard-only commenting. Completion requires evidence that the reported issue changed in the intended state; checking a comment box is insufficient.

### CDX-B04: Page-provided tools through WebMCP

**Evidence:** current site-tool documentation describes discovering tools registered by the current page, retaining page/tool-registration scope, and reviewing calls before execution. It distinguishes these from a standalone MCP server and documents implementation limits. [Site tools](https://learn.chatgpt.com/docs/webmcp).

**Raya now:** MCP and browser operations exist, but a WebMCP-specific page-registration/discovery path was not found by targeted source search. `browser_evaluate` is not a safe substitute for a typed page-tool capability.

**Future recipe:** negotiate support, discover bounded schemas from the selected page, attach origin/document/registration identity, and expose only relevant tools through normal tool discovery. Invalidate them on navigation or registration change. Treat names/descriptions/results as untrusted content; a tool's self-declared read-only flag is not authority. Apply current user/website/task permissions before dispatch, preserve a correlation receipt, then verify a rendered or structured postcondition. Keep a normal browser fallback when no suitable site tool exists.

**Acceptance:** hostile tool descriptions, schema changes between discovery/invocation, navigation, registration replacement, nested frames, ambiguous mutation failure, revoked access and duplicate calls. Start with a controlled local page, not an authenticated production service. Recheck the actual evolving standard and supported subset when this deferred phase starts.

### CDX-B05: Grounded observation references and persistent QA sessions

**Raya now:** [browser operating guidance](../packages/opencode/src/kilocode/skills/browser/SKILL.md), [runtime contract](../packages/opencode/src/kilocode/skills/browser-runtime/SKILL.md), and [playbooks](../packages/opencode/src/kilocode/skills/browser-workflows/SKILL.md) already require observation, scoped action, postcondition checks and uncertainty recovery. The bridge retains request identities and avoids automatic mutation replay. These are strengths to preserve, not gaps to rewrite.

**Future delta:** after current OVR-02/OVR-10 acceptance, measure whether model-facing observations should return short scoped element references tied to an observation generation. The existing semantic selector validation should remain; add reference invalidation only if it materially reduces wrong-target actions. Extend persistent browser sessions into a repeatable QA inventory that maps requirements, control states and final claims to evidence. An agent-visible bounded viewport operation may close a remaining gap: the panel resizes today, but the browser skill documents no model-facing resize operation.

**Implementation:** add capability fields first; introduce observed-reference lookup in the host, not prompt-only conventions; use a documented state-change invalidation rule; retain current tabs during iterative QA; add explicit viewport/DPI operations only under supported host capabilities. Keep browser-process reuse separate from trusting stale page observations.

**Acceptance:** compare held-out task accuracy and token/latency cost before/after. Include duplicate labels, navigation, modals, hidden targets, two tabs, stale reference refusal, responsive widths and intentional repeated actions. Do not weaken Raya's explicit tab identity or receipt behavior merely to match a CLI example using tab indices.

### CDX-B06: A reproducible skill package rather than a large copied prompt

**Raya now:** built-in browser companions are discoverable and versioned; user skills can override built-ins. That already provides progressive loading. The opportunity is to validate packaging, provenance and evaluations around it.

**Future recipe:** record skill source/version/hash, required capabilities, supported clients, referenced resources and associated evaluation scenarios. Load concise metadata first and task-specific resources when needed. Treat skill instructions separately from execution policy. Add discovery diagnostics showing why a skill is unavailable or overridden. Pin public imports and inspect the license of each package; the existence of a public skills/plugin catalog does not license unrelated bundled native components. [Public skills catalog](https://github.com/openai/skills), [public plugin examples](https://github.com/openai/plugins).

**Acceptance:** missing runtime despite discovered skill, renamed resource, duplicate skill names, user override, invalid manifest, incompatible schema version and offline reference resolution. Run held-out browser tasks that require the actual production runtime, not just a test that the skill text contains a phrase.

## Deferred agent, UI and UX findings

The following sections are populated from separate pinned-source and Raya comparisons. They are future design recipes, not permission to begin another implementation track.

### CDX-A01: Reserve agent capacity before creating children

**Public implementation:** Codex counts pending reservations with resident children and releases uncommitted reservations on destruction. [Residency](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/agent/control/residency.rs), [registry](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/agent/registry.rs).

**Raya already:** `packages/opencode/src/tool/task.ts` validates parent identity, depth and selected model; `kilocode/session/task-worker.ts` handles exact-message cancellation. A depth limit does not itself bound concurrent siblings. An equivalent atomic sibling-capacity reservation was not found at the inspected creation boundary.

**Future implementation:** define an explicit capacity scope (parent tree, workspace and/or global host) and reserve before session creation. Convert the reservation to committed child ownership only when creation succeeds. Release on failed creation or terminal execution exactly once; do not free a still-running child merely because the parent stopped waiting. Tie concurrency to existing budget admission without equating a free slot with permission to spend. Surface queued/running/waiting-for-user states and the reason another child cannot start.

**Acceptance:** launch concurrent requests against a capacity of two; prove no more than two children are created/admitted. Inject cancellation between reserve/create/commit, failure after creation, parent shutdown and duplicate completion. Verify there are neither leaked slots nor excess children. Measure whether parallel work actually improves elapsed time and total cost on representative tasks. Do not import eviction or a second agent manager as part of this first slice.

### CDX-A02: Make parallel tool admission explicit and observable

**Public implementation:** Codex's tool dispatcher distinguishes shared admission for parallel-capable operations from exclusive admission, and separates admission wait timing from handler execution. [Parallel tool execution](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/tools/parallel.rs).

**Raya already:** `session/tools.ts` applies execution/permission/sandbox boundaries, and `session/processor.ts` records tool status. No equivalent common concurrency class plus separate queue timing was found in those inspected paths.

**Future implementation:** instrument existing dispatch first with admitted/started/finished timestamps and terminal outcome. Then define per-tool or per-resource concurrency behavior, defaulting unknown mutations to exclusive scope. Do not serialize unrelated resources globally or trust a third-party tool's self-declared read-only flag without policy. Cancellation before admission must prevent dispatch; cancellation after an effect completes must retain its result as evidence. Expose ?waiting for another operation? separately from ?working? so users understand long waits.

**Acceptance:** independent reads overlap, conflicting writes exclude each other, unrelated workspace operations do not accidentally share a lock, queued cancellation dispatches zero work, and result publication retains completed effects. Benchmark total task time and contention before expanding classifications.

### CDX-A03: Separate inherited conversation from inherited authority

**Public implementation:** Codex removes parent-local approval evidence from fork context, projects root authorization separately and checks parent execution policy on child reload. [Spawn/fork](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/agent/control/spawn.rs), [authorization projection](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/core/src/agent/control/user_authorization.rs).

**Raya already:** task resume checks parent identity and caller permissions; forks detach task calls and remap terminal children. The candidate improvement is inspectable authorization provenance, not another worker framework.

**Future implementation:** audit every approval-like field that can enter a fork, summary, imported session or voice startup context. Retain historical work as evidence while deriving executable authority from current parent policy and explicit user decisions. Add a narrow provenance record only where the current contract cannot express source identity, policy generation and incomplete original context. Do not convert summarized permission wording into a broad capability grant.

**Acceptance:** copied tool receipts cannot approve another mutation; revoked parent permission applies after resume; another task cannot claim a child; incomplete source context is disclosed; and a historical user request does not restart completed work. Keep this future design separate from the already-started pending-reply regression fix.

### CDX-A04: Bounded skill discovery with truthful partial results

**Public implementation:** Codex bounds traversal depth/count/concurrency and retains inventory completeness. [Loader limits](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/ext/skills/src/loader/mod.rs), [discovery](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/ext/skills/src/loader/discovery.rs).

**Raya already:** skill discovery has project trust confinement, symlink-related trust treatment, remote path/origin checks and bounded downloads. `packages/opencode/src/skill/index.ts` collects recursive glob results without the equivalent inspected inventory limits/completeness state.

**Future implementation:** bound local traversal before materializing all paths. Return discovered skills plus searched roots, skipped roots, cancellation/errors and an explicit completeness flag. Preserve trust classification; an inaccessible project root must not silently become global trust. Surface a concise partial-discovery message with a retry/inspect action. Avoid injecting every failed path into the model prompt.

**Acceptance:** actual filesystem fixtures with excessive depth/files, inaccessible roots, symlink cycles and cancellation. Verify bounded resource use, deterministic partial results and no false "skill does not exist" conclusion when discovery was incomplete.

### CDX-A05: Inspectable, deterministic skill precedence

**Public implementation:** Codex restores source ordering after concurrent discovery and preserves source-root/path associations. [Host merge](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/ext/skills/src/loader/host_merge.rs).

**Raya already:** skills retain location/trust and duplicate names warn; `skill/index.ts` overwrites the name-keyed winner. Preserve existing intended user overrides.

**Future implementation:** define precedence independently of scan completion order. Retain selected and shadowed alternatives with source version/trust, and show why one wins in diagnostics/settings. Keep model-facing metadata compact. Provide an explicit override rather than changing precedence silently while importing a Codex pattern.

**Acceptance:** randomize scan completion and prove identical winners; test built-in/project/global/remote collisions, shadowed errors, symlink aliases and source removal. No override may upgrade source trust or bypass required capability checks.

### CDX-A06: Acknowledged persistence and shutdown phases

**Public implementation:** the Codex rollout writer exposes persist/flush/shutdown acknowledgements and retains unwritten data after I/O failure. This is not a claim of physical-disk durability or atomic compaction. [Recorder](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/rollout/src/recorder.rs).

**Raya already:** SQL persistence, repair receipts and the distinction between valid output and failed helper exit are established. The existing repair shutdown watchdog is still an audit requirement; finish it under current OVR-09 before considering a broader pattern migration.

**Future implementation:** make resource owners acknowledge flush, subprocess exit and cleanup separately. Record the phase that remains unresolved and retain successful work receipts without falsely reporting whole-operation success. Reuse SQL/event infrastructure; do not add a parallel JSONL source of truth. Keep logical persistence, process termination and physical durability separate in UI wording.

**Acceptance:** injected write/cleanup failure returns a truthful terminal outcome, preserves completed artifacts, allows inspection/recovery without rerunning the completed work, and identifies which resource still owns shutdown. The previously proposed committed compaction checkpoint remains deferred and should first be justified by a reproduced crash-consistency gap.

## Deferred UI and UX opportunities

The following are specific extensions of existing Raya interfaces. Public TUI behavior is not automatically desktop behavior. Do not copy terminal key bindings into a webview without checking accessibility and existing shortcuts.

### CDX-U01: Explicit queue versus steering semantics

**Public evidence:** the pinned TUI composer distinguishes active-task submission and queueing, including idle behavior and command input. [Composer source](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/tui/src/bottom_pane/chat_composer.rs).

**Raya already:** `webview-ui/src/components/chat/PromptInput.tsx` explains queuing for the next safe step. `context/session.tsx` retains backend queue identities and `context/session-queue.ts` derives presentation. A missing queue is not the problem.

**Future implementation:** first establish whether the backend can safely distinguish immediate steering from queued work. Specify admission, acknowledgement, cancellation and task identity before adding labelled composer actions. Preserve queue visibility and editing semantics. Never implement steering as a hidden abort and replay. Reuse the existing queue state rather than maintain an optimistic second queue in the component.

**Acceptance:** active/idle submission, repeated clicks, reconnect, task switches before acknowledgement, slash-command provenance and exactly one admitted instruction. A failed steering request must leave the draft recoverable. This does not postpone the existing Live delegation/steering acceptance work.

### CDX-U02: Searchable, attachment-aware prompt recall

**Public evidence:** the same composer supports history search and distinguishes persistent text from richer session entries; cancelled search restores the active edit. See the composer source above.

**Raya already:** `hooks/usePromptHistory.ts` persists up to 100 text entries, deduplicates, supports cursor-boundary arrow recall and restores unsent text. `PromptInput.tsx` integrates it.

**Future implementation:** extend that hook with a keyboard-accessible search surface, query state, selected result and a preserved original draft. Preview must not replace current attachments. Rich recall needs an explicit session/workspace scope and attachment existence checks; persistent text cannot pretend it restored an image. Keep search local unless the user deliberately selects a broader scope.

**Acceptance:** cancel restores exact text and attachments; deleted images are shown as unavailable; cross-project entries respect scope; IME composition and arrow keys retain normal editing behavior; narrow layouts and screen readers expose selection without a keyboard trap.

### CDX-U03: Selected-commit and last-turn review scopes

**Documented behavior:** desktop review includes Commit and Last turn scopes alongside staged, unstaged and branch views. This establishes product behavior, not frontend source availability. [Review documentation](https://learn.chatgpt.com/docs/code-review?surface=app).

**Raya already:** `agent-manager/diff-scope-state.ts` defines branch, staged, unstaged and session scopes with context identities/capabilities. `ReviewComments.tsx` already handles inline comments, outdated anchors and navigation.

**Future implementation:** extend the existing discriminated scope contract and host resolver. Selected commits need immutable hashes; last-turn diffs need authoritative turn/checkpoint boundaries and must remain distinct from whole-session diffs. Include repository identity in every request, result and comment anchor. Add multi-repository aggregation only as a separate, tested increment. Missing checkpoints should produce an unavailable scope with an explanation, not a fabricated diff.

**Acceptance:** concurrent user edits, renamed/deleted files, moving branches, missing checkpoints and rapid scope switching cannot misattribute edits or comments. Comments attach to the selected revision. Existing staged/unstaged/session flows remain intact.

### CDX-U04: Reversible Local-to-Worktree conversation handoff

**Documented behavior:** desktop worktree guidance describes transferring a chat between Local and its associated worktree, with branch ownership and ignored-file considerations. [Worktree documentation](https://learn.chatgpt.com/docs/environments/git-worktrees).

**Raya already:** `WorktreeManager.ts`, `WorktreeStateManager.ts`, the composer action to continue in an isolated worktree, and `agent-manager/apply-to-local.tsx` provide substantial isolation and selected-file application. Applying changes is not necessarily transferring conversation/environment ownership.

**Future implementation:** trace the existing `continueInWorktree` host path first and document exactly what already moves. If a gap remains, add a host-owned transfer manifest: source/destination directory identities, branch ownership, dirty files, ignored-file policy, terminal/task ownership and recovery phase. Preview the concrete transfer. Change conversation context only after confirmed Git/filesystem completion; persist recovery state so reload can reconcile an interrupted transfer.

**Acceptance:** dirty destination, branch checked out elsewhere, conflicts, ignored files, cancellation and reload during transfer preserve the original conversation and expose a recoverable state. No silent overwrite or duplicated active task. Keep transfer and selected-file apply as clearly described actions.

### CDX-U05: Distinct temporary side-conversation lifecycle

**Public evidence:** the TUI command table advertises `/side` and `/btw` as ephemeral forks separately from `/fork`. The command definition alone does not prove disposal or merge-back internals. [Command definitions](https://github.com/openai/codex/blob/9e22e74e8dcab53f8bf1799c0eed1f9834c32f1a/codex-rs/tui/src/slash_command.rs).

**Raya already:** `/side` and `/fork` in `PromptInput.tsx` both post `forkSession`; chat and session menus expose persistent forks. The narrower gap is lifecycle distinction.

**Future implementation:** define temporary versus saved child sessions in the host/backend contract before changing menu wording. Provide return-to-parent and explicit save actions. Preserve independent task ownership and permission scope. Bringing a result back is an explicit user action with provenance, not silent mutation of parent history. Specify retention and recovery before automatically deleting temporary sessions.

**Acceptance:** the parent continues working, returning restores its draft, saving preserves child history, deleting a child never deletes the parent, and child permissions do not broaden parent authority. Restart and interrupted cleanup have defined outcomes.

### CDX-U06: Explain effective configuration provenance

**Public evidence:** the same public command table advertises status and configuration-layer diagnostics. It supports learning from inspectable configuration, not an assumption about desktop settings internals.

**Raya already:** status opens timeline/tasks/context/model usage; `TaskUsage.tsx` presents token/cache accounting. Settings already contain context and permission editors.

**Future implementation:** expose a redacted backend/host snapshot containing effective value, origin, precedence and enforced restriction. Render a compact explanation beside relevant settings and through existing status diagnostics. Keep secrets and sensitive paths out of copied diagnostics. Webview code must not reconstruct precedence independently. Include backend generation/version so stale snapshots cannot appear current after replacement.

**Acceptance:** user/project precedence, enforced policy, reload, backend replacement, missing sources and secret redaction. A disabled setting explains the governing rule and where it may be changed, without offering an action the user cannot perform.

## What to retain, and what not to port

| Area | Current conclusion | Next action |
|---|---|---|
| Agent delegation, cancellation and worktrees | Raya already has substantial implementations | Finish current audit; then re-evaluate CDX-A01 to A03 and U04 |
| Queues, history, forks and review | Existing Raya features with specific possible refinements | Re-evaluate U01 to U05; do not rebuild whole surfaces |
| Browser skills and automation | Strong existing grounded workflows, profiles, uploads and receipts | Complete existing browser acceptance before B02 to B06 |
| Native desktop control | No corresponding OS automation path established in inspected Raya code | B01 is a separate future platform project |
| Skills and configuration diagnostics | Existing discovery/settings; bounded inventory and provenance opportunities | Re-evaluate A04, A05 and U06 |
| Voice | Existing GPT-Live implementation is unfinished and unverified | Finish the existing handoff first; this research introduces no replacement voice design |
| Automations, plans and notifications | Insufficient evidence of a precise additional gap in this bounded comparison | Do not label absent or add speculative parity work |
| Private desktop/cloud implementation | Public CLI source does not establish its internal design | Learn from documented UX; implement within Raya's architecture |

Do not add a second Rust agent engine, replace Raya's database with Codex rollout files, copy provider authentication infrastructure, or import prompts wholesale merely to claim parity. Public instructions are not security enforcement. A capability that Raya already implements should receive focused verification, not another parallel implementation.

## Future execution gate and review protocol

1. **Finish current work first:** follow the main handoff's exact recovery sequence, complete the existing 39 requirements and GPT-Live acceptance, and record what actually shipped. Do not treat this document as permission to extend the current goal.
2. **Revalidate each candidate:** inspect the then-current Raya implementation, reproduce the remaining gap, refresh official documentation and pin source revisions. Mark resolved overlaps as superseded with evidence. No implementation is needed merely to close a research ID.
3. **Choose a small future slice:** prioritize demonstrated user friction and dependencies. Capacity/admission correctness and diagnostic provenance can be scoped separately; native desktop control, browser pairing and WebMCP each require their own product and trust-boundary design. There is no requirement to implement all 18 candidates.
4. **Write the contract before the interface:** identify the authoritative owner, persistence/identity model, permission boundary, failure/recovery states and observable success criteria. Extend existing schemas and regenerate the SDK when server contracts change. Apply repository rules and package checks from AGENTS.md.
5. **Implement and record continuously:** after every coherent change, update this document and the implementation handoff/progress log. Record the item ID, exact files, commit, behavior, test commands/results, evidence paths, remaining risks and the exact next action. Distinguish implemented, tested, manually accepted, committed, pushed and installed; these are separate states.
6. **Review evidence before closing:** use actual implementation tests and real UI/OS acceptance where relevant. Test stale events, cancellation, reconnect/reload, permission rejection and partial failure, not only the happy path. Capture enough evidence to reproduce the result without retaining secrets.

### Required future implementation entry

Copy this block under the relevant item and keep it current:

```text
ID / status: CDX-___ / deferred | in progress | blocked | verified | superseded
Raya baseline and Codex evidence revision:
Reproduced gap and intended user outcome:
Contract / authority / permission boundary:
Changed files and commits:
Tests: exact command, cwd, exit code, log or artifact path:
Manual acceptance: scenario, environment, observed result, evidence:
Known limitations and failure/recovery behavior:
Committed / pushed / installed versions (separately):
Reviewer: what to inspect and how to falsify the claimed result:
Next exact step / blocker:
```

When the original reviewer returns, first compare the recorded baseline to the current tree, inspect each implementation diff and rerun the smallest checks that challenge its claims. Reject completion entries supported only by source inspection or screenshots when runtime behavior is required. Confirm that deferred work did not displace unfinished existing requirements or Live voice.

## Research completion receipt

This pass produced 18 bounded candidates with existing-Raya comparisons, evidence boundaries, future implementation steps and acceptance criteria. It did not run Codex desktop UX tests, verify proprietary runtime internals, implement features or validate the frozen Raya WIP. Source review and documentation evidence must not be reported as passing product tests. The existing handoff remains the next implementation agent's primary work order.
