# Raya Features

> Historical feature catalog. The owner subsequently authorized work on the future roadmap. Use [Raya-Implementation-Progress.md](Raya-Implementation-Progress.md) for current requirement scope and verification status; deferral statements below reflect the catalog's original date.

This catalog has two parts. **Current** means the code, UI, or runtime path exists in this fork. **Future** means the idea is documented but not a shipped product capability: audit leftovers, deferred Codex research, to-build plans, UX foundation, mobile/cloud plans, and owner product-direction notes. Experimental flags that already have a working surface stay under Current and are marked experimental.

Current does not mean the 39-requirement audit is complete, that every client has parity, or that live packaged acceptance has passed. Future does not authorize starting that work while the existing audit and GPT-Live leftovers remain open.

Raya is the `eden.raya` VS Code extension plus the bundled `@kilocode/cli` backend (`kilo serve`). Clients talk to that backend over HTTP and SSE.

# Current

## Products and clients

| Feature | Description |
|---|---|
| VS Code extension (`eden.raya`) | Primary Raya client: sidebar chat, editor tabs, Agent Manager, routines, settings, and host-owned browser, canvas, voice, and review. |
| Bundled CLI backend | The extension starts `kilo serve` on a loopback port with a generated password and reuses one process across sidebar, tabs, and Agent Manager. |
| CLI / TUI | Interactive terminal UI over the same agent runtime, with `kilo` / `kilocode` command names. |
| Headless `kilo run` | Non-interactive agent runs for scripting, without a network socket. |
| `kilo serve` HTTP API | Hono REST plus SSE for sessions, tools, events, and generated SDK clients. |
| Local web console | Secondary browser UI compiled into the CLI; not certified at VS Code feature parity. |
| JetBrains plugin | Inherited Kilo plugin that can talk to the CLI; Raya-branded distribution and parity are not claimed. |
| ACP / Zed manifest | Inherited editor-protocol targets; not a tested Raya install channel. |
| Generated TypeScript SDK | Auto-generated `@kilocode/sdk` client for the server API. |
| Snapshot VSIX install | `snapshot:install` builds a uniquely versioned VSIX and replaces the installed extension. |
| Private GitHub updates | Optional updater using `raya.update.repo` and a SecretStorage token, distinct from model credentials. |

## Chat and sessions

| Feature | Description |
|---|---|
| Sidebar chat | Activity-bar conversation with composer, transcript, permissions, and task controls. |
| Open in tab | Same conversation opened as a full editor panel that keeps context when hidden. |
| Session history | Browse, reopen, rename, and filter saved conversations (routine executions stay out of the default chat list). |
| Session search | In-chat search over the current transcript. |
| Session fork | Duplicate a conversation into a new session without replaying work as new work. |
| Session export / import | Export and import session records for backup or another machine. |
| Cloud history preview | Read-only cloud session preview; sending imports a local copy bound to the host destination. |
| Queued follow-ups | Messages sent while a run is active wait for a safe boundary; Stop remains available. |
| Prompt attachments | Files, images, and editor context can be attached to a prompt. |
| File and session mentions | `@` mentions insert files, folders, or other sessions into context. |
| Slash / command discovery | Composer entry points for commands and existing actions (review, fork, worktree, model, memory, settings). |
| Agent modes | Built-in modes including Auto, Code, Ask, Debug, Designer, Orchestrator, Voice, plus specialist personas. |
| Mode cycling | Keyboard commands cycle agent modes forward and back. |
| Model picker | Per-session model and variant selection across configured providers. |
| Reasoning / thinking selector | Separate control for model reasoning effort where the provider supports it. |
| Custom providers | OpenAI-compatible and other custom provider endpoints, including local Ollama / LM Studio / vLLM. |
| Kilo Gateway auth | Device-flow Kilo account, OpenRouter routing, profile, balance, and team integration. |
| Balance chip | Shows remaining Kilo credit/balance in the chat chrome. |
| Welcome / first-task composer | Outcome-focused start surface with real mode, model, and reasoning selectors. |
| Draft retention | Unsent composer text and files survive failed send, navigation, and some reconnect cases. |
| Internationalization | UI strings for many languages via `@kilocode/kilo-i18n` (on the order of 16 locales). |
| Theme-aware UI | Host light/dark theming through kilo-ui and VS Code theme tokens. |

## UI and UX

| Feature | Description |
|---|---|
| kilo-ui design system | Shared SolidJS components (buttons, dialogs, tabs, toasts, markdown) used by the webview. |
| Eden / Raya visual language | Host-themed chat, welcome, settings, and routines styling rather than a separate design app. |
| Outcome-led Welcome | Default start surface hides routing internals and uses the real mode, model, and reasoning selectors. |
| Composer as primary action | Prompt, attachments, Stop, queue copy, and mode/model controls live together in the chat composer. |
| Progress as current work | Paused, blocked, waiting-on-you, and next decision are shown separately from activity counts. |
| Presence states | Header, tabs, History, and Routines show working, waiting on you, done, and error without dumping the transcript. |
| Review language | Keep file / Undo file labels and scope tooltips so a click matches file-level action, not line-only scope. |
| Destructive-action semantics | Shared confirm/Cancel/Escape behavior on destructive dialogs. |
| Routines messenger UX | Two-pane inbox: worker list plus conversation, not a job table that dumps you into ordinary history. |
| Goal control plane | Goal banner, criteria, evidence, plan, and pause/continue as one durable-work surface. |
| Visual preview harness | Chromium preview stories for memory, routines, and other production components (light/dark, widths). |
| Settings hub | Tabbed settings (providers through experimental) instead of scattering every control in chat. |
| Keyboard reach | Sidebar, Agent Manager, routines Back/Escape, and composer shortcuts for common actions. |
| Reduced-motion / contrast gaps | Some surfaces honor host theming; full assistive-technology, high-contrast, and zoom gates remain open (see Future). |
| Remaining redesign | Navigation, AskCard, thinking, history, memory, providers, browser/canvas/voice/repair still need the full surface redesign (see Future). |

## Subagents and routing

| Feature | Description |
|---|---|
| Task / subagent spawn | The `task` tool creates a child session with a specialist (or named agent), inherited or restricted tools, and a parent task identity. |
| Automatic specialist selection | Delegation is inferred from the work; the user does not have to name a specialist. An explicit agent name is only an override. |
| Parallel fan-out | Independent investigations can run as sibling children; the parent synthesizes their evidence. |
| Chief / Auto routing | Auto mode (`chief_route`) picks model/variant and specialist from intent, capabilities, and authority, with same-provider fallback. |
| Refusal before unauthorized mutation | Routing will not start a child or mutate a session when the selected path is not permitted. |
| Model and variant retention | Task invocations keep the configured model/variant source rather than silently substituting another. |
| Orchestrator mode | Primary mode that coordinates specialists in parallel (native, marked deprecated in favor of Auto). |
| Voice mode isolation | Voice mode handles the request itself and denies `task` / `chief_route` so a call does not spawn a Chief tree. |
| Subagent tabs | Agent Manager shows delegated children as inspectable threads. |
| Depth and parent identity | Child creation checks parent identity and depth; sibling capacity reservation is not shipped (see Future CDX-A01). |
| Permission inheritance | Children inherit a permission ruleset; they must not silently widen parent authority. |
| Task cancellation | Exact-message cancellation and previous-owner refusal on the task-worker path. |
| Agent Manager spawn | Separate `agent_manager` tool can open additional manager sessions from the agent. |

## Agent skills and prompt sources

These are the global/native skill and prompt files the runtime loads. User/project skills in `.kilo/` and `~/.config/kilo/` override built-ins of the same name.

| Agent or skill | Role | Source |
|---|---|---|
| Soul / default engineer | Default Raya personality and working style | [`packages/opencode/src/kilocode/soul.txt`](../packages/opencode/src/kilocode/soul.txt) |
| Designer | UI/UX, design system, Figma↔code specialist (primary and subagent) | [`packages/opencode/src/kilocode/agent/designer.txt`](../packages/opencode/src/kilocode/agent/designer.txt) plus `DESIGN_GUIDANCE` in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Scout | Read-only external library/docs research subagent | [`packages/opencode/src/kilocode/agent/scout.txt`](../packages/opencode/src/kilocode/agent/scout.txt) |
| Explore | Read-only codebase exploration subagent | [`packages/opencode/src/agent/prompt/explore.txt`](../packages/opencode/src/agent/prompt/explore.txt) |
| Ask | Answers without mutating the workspace | [`packages/opencode/src/agent/prompt/ask.txt`](../packages/opencode/src/agent/prompt/ask.txt) |
| Debug | Systematic diagnosis and fix | [`packages/opencode/src/agent/prompt/debug.txt`](../packages/opencode/src/agent/prompt/debug.txt) |
| Orchestrator | Parallel specialist coordination (deprecated native mode) | [`packages/opencode/src/agent/prompt/orchestrator.txt`](../packages/opencode/src/agent/prompt/orchestrator.txt) |
| Code | Primary implementation mode (renamed from build) | Upstream build prompt plus Raya `choices()` guidance in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Voice | Hands-free spoken replies; no Chief/delegation | Inline prompt in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) plus designer guidance |
| Generalist | Fast small-file subagent for Auto | Inline `walkthrough()` in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Coder | Software implementation subagent | Inline `walkthrough()` in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Engineer | Hard implementation (concurrency, protocols) selectable + delegable | Inline `walkthrough()` in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Accountant | Ledgers, invoices, financial analysis subagent | Inline prompt in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Reasoner | Architecture, proofs, trade-offs subagent | Inline prompt in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Researcher | Investigation/docs subagent with browser tools | Explore prompt plus `walkthrough()` in [`agent/index.ts`](../packages/opencode/src/kilocode/agent/index.ts) |
| Plan | Plan-only edits | [`packages/opencode/src/session/prompt/plan-mode.txt`](../packages/opencode/src/session/prompt/plan-mode.txt) and related plan prompts |
| `/review` | Advisory code review command | [`packages/opencode/src/kilocode/review/review.txt`](../packages/opencode/src/kilocode/review/review.txt) |
| Compaction / summary / title | Session compaction, titles, summaries | [`packages/opencode/src/agent/prompt/compaction.txt`](../packages/opencode/src/agent/prompt/compaction.txt), [`summary.txt`](../packages/opencode/src/agent/prompt/summary.txt), [`title.txt`](../packages/opencode/src/agent/prompt/title.txt) |
| Model-family session prompts | Provider-specific default system text (GPT, Anthropic, Codex, Gemini, Kimi, Copilot, Trinity, Beast, Ling) | [`packages/opencode/src/session/prompt/`](../packages/opencode/src/session/prompt/) |
| Skill: browser | Operate the shared in-editor browser | [`packages/opencode/src/kilocode/skills/browser/SKILL.md`](../packages/opencode/src/kilocode/skills/browser/SKILL.md) |
| Skill: browser-workflows | Research, forms, auth, transfers, smoke, inspection playbooks | [`packages/opencode/src/kilocode/skills/browser-workflows/SKILL.md`](../packages/opencode/src/kilocode/skills/browser-workflows/SKILL.md) |
| Skill: browser-recovery | Stale targets, login, untrusted page recovery | [`packages/opencode/src/kilocode/skills/browser-recovery/SKILL.md`](../packages/opencode/src/kilocode/skills/browser-recovery/SKILL.md) |
| Skill: browser-runtime | Versioned browser tool contract | [`packages/opencode/src/kilocode/skills/browser-runtime/SKILL.md`](../packages/opencode/src/kilocode/skills/browser-runtime/SKILL.md) |
| Skill: kilo-config | Config paths, agents, skills, Agent Manager scripts | [`packages/opencode/src/kilocode/skills/kilo-config.md`](../packages/opencode/src/kilocode/skills/kilo-config.md) |
| Skill registration | Built-ins compiled into the CLI | [`packages/opencode/src/kilocode/skills/builtin.ts`](../packages/opencode/src/kilocode/skills/builtin.ts) |

## Goals

| Feature | Description |
|---|---|
| Durable goals | A goal is a persisted objective that continues across turns until complete, blocked, or stopped. |
| Goal create / get / update tools | Model-facing tools that create, inspect, and revise the durable goal without a second store. |
| Goal plan | Structured plan attached to a goal, distinct from one-off chat todos. |
| Goal criteria editor | User-editable completion criteria shown separately from evidence. |
| Goal evidence | Inspectable artifacts, checks, and unverified aspects for a completed or running goal. |
| Goal audit / inspection / report | Views for what was requested, what ran, and what remains unverified. |
| Goal steering | Revising the durable objective for the next continuation, distinct from a queued chat follow-up. |
| Goal pause / continue | User control to pause automatic continuation and resume later. |
| Command-bound checks | Optional required checks that need an exact command, directory, and eligible evidence. |

## Routines

| Feature | Description |
|---|---|
| Routine roster / inbox | Messenger-style inbox of persistent workers with name, role, last message, time, unread, and run state. |
| Worker conversations | Reports, follow-ups, user messages, delegation cards, and artifacts in one ordered timeline. |
| Structured scheduling | Phrase, timezone, recurrence, and version persisted together with backend occurrence preview before activation. |
| One-shot and recurring runs | Timer, interval, and “just when I ask” schedules; Monday/Friday and DST-aware evaluation. |
| Run now | Start a routine session immediately without waiting for the next occurrence. |
| Pause / enable | Pause future wakeups; a paused worker stays paused and new asks can be denied until enabled. |
| Brief vs full access | New routines default to read-and-report; full access is an explicit broader permission ceiling. |
| Persona templates | Briefer, Reviewer, Accountant, Inbox, and custom roles; persona does not by itself grant extra tools. |
| Accountant / inbox consents | Explicit money-record or messaging consent at assign time, still not a license to send payments or mail. |
| Follow-up in place | Questions about a report stay in that worker conversation with run context, without rewriting the standing schedule. |
| Drafts and unread | Per-conversation drafts and read position survive leaving the thread. |
| Back / Escape | Leave a conversation and restore focus to the same worker without stealing another thread. |
| Report arrival | Other-worker reports do not steal the open conversation, overwrite a draft, or jump scroll when the reader is not at the bottom. |
| Session-list exclusion | Routine-owned execution sessions are hidden from default regular history and remain inspectable through the routine. |
| Worker-to-worker delegation | Authorized request with sender/recipient, scope, deadline, queue, and inspectable chain. |
| Delegation states | Queued, started, denied (paused recipient), timeout, stop, and settled child-run error are recorded and shown. |
| Cost attribution | Delegated work attributes cost to the child and parent without treating unarrived replies as consensus. |
| Archive and rename | Historical reports stay on the same worker after rename and remain readable after archive; live delegated work can block removal. |
| Schedule edit during a run | Editing a schedule keeps the active run and applies the new schedule after it settles. |
| Occurrence store | Durable occurrence IDs, overlap exclusion, and startup claims so duplicate triggers do not silently double-run. |
| Event filters | Routines can require matching events rather than firing on every bus event. |
| Timezone-less hold | Legacy calendars without a timezone wait for review instead of guessing a zone. |
| Archive browser | Removed routines and retained runs remain browseable. |
| Inbox pagination | Conversation pages return at most 50 persisted messages. |

## Agent Manager

| Feature | Description |
|---|---|
| Multi-session editor tab | Full-panel orchestration of several independent sessions (`raya.agentManagerOpen`). |
| Worktree isolation | Sessions can run in their own git worktree/branch instead of the workspace root. |
| Quick / advanced worktree | Create, open, close, and configure worktrees, including up to several parallel copies of the same prompt. |
| Setup scripts | `.kilo/setup-script` can run when a worktree is prepared. |
| Per-session terminals | Dedicated VS Code terminals, side terminals, and terminal tabs per Agent Manager session. |
| Diff / Changes inspector | Worktree diffs, review comments, and apply-to-local flows in the manager panel. |
| PR import / open | Read-only `gh` integration to inspect or open pull requests from Agent Manager. |
| Subagent tabs | Inspect delegated child sessions as separate threads. |
| Multi-project (experimental) | Flag-gated project registry, sidebar, and per-project session routing. |
| Session / tab / terminal shortcuts | Keyboard jumps, search, and shortcut overlay for manager chrome. |

## File review and changes

| Feature | Description |
|---|---|
| In-editor Keep / Undo | File-scoped accept or undo of agent edits with acknowledgement before dismissal. |
| Chat review labels | Keep file / Undo file copy and scope tooltips, including addition/deletion counts. |
| Revision fingerprints | Review identity is content/patch based, not raw line numbers. |
| Review comments | Sidebar and diff-viewer comments on changed files. |
| Changes viewer | Dedicated Changes panel for the current session or worktree diffs. |
| Checkpoints | Save and jump to workspace snapshots (`raya.checkpoint.save` / `jump`). |
| Snapshot / revert | Tracked snapshots can restore files without erasing conversation history. |
| Discard / rollback | Discard sequences workspace rollback before clearing goal state when snapshots exist. |
| Permission diffs | Visible permission-rule changes when the agent or user updates policy. |
| Unsaved-buffer preflight | Review/apply paths consider dirty editor buffers. |
| Document panel | Worktree-scoped file/image inspector with review annotations beside Agent Manager. |
| Diff viewer / virtual diffs | Hunk-bounded patch rendering for large files. |

## Browser automation

| Feature | Description |
|---|---|
| Host-owned browser session | Extension-managed Chromium/Playwright session bound to the current task, not the user’s everyday profile. |
| Navigate / snapshot / screenshot | Open URLs, observe the page, and capture screenshots. |
| Click / type / select / scroll | Act on observed elements through stable targeting. |
| Evaluate | Run bounded page-side evaluation through the browser bridge. |
| Tabs and frames | Stable tab and frame identity, including nested documents. |
| Dialogs | Accept, dismiss, or prompt native dialogs. |
| Downloads | Durable download copies with task-bound receipts. |
| Authorized uploads | Stage verified local files onto an observed file input; selection is not server acceptance. |
| Workspace profiles | Capture, restore, delete, and expire browser identity/auth with a seven-day expiry. |
| Profile identity guard | Windows recased paths of the same folder are the same profile; redirected junctions are refused. |
| Auth capture / restore | Persist authentication provenance and refuse reuse after delete or expiry. |
| Browser panel | User-visible browser host for manual/agent handoff. |
| Smoke test tool | Built-in browser smoke workflow for host health. |
| Browser skills | Bundled skills for runtime, recovery, and workflow playbooks. |

## Canvas

| Feature | Description |
|---|---|
| Live React canvas | Create a named in-panel React TSX artifact for dashboards, tables, and interactive views. |
| Update canvas | Repair or replace source/data without treating a failed candidate as the committed revision. |
| Compile and recover | Last working canvas survives failed compiles, late errors, and extension restart. |
| Failed-candidate inspection | Broken candidates remain inspectable without becoming the saved version. |

## Voice

| Feature | Description |
|---|---|
| GPT-Live 1 (default new setups) | OpenAI Live API speech-to-speech in the current conversation (`openai-live` / `gpt-live-1`). |
| OpenAI Realtime compatibility | Explicit `openai-realtime` path for saved Realtime setups; not a silent substitute for Live. |
| Qwen realtime | Experimental Qwen realtime engine for saved selections. |
| Cascade STT → TTS | Configured speech-to-text, Raya, then MiniMax (or similar) cascade when selected. |
| Dictation vs call | Speech-to-text draft entry is separate from a live call. |
| Mute / stop speaking / end call | Distinct controls; ending voice releases audio while admitted work can continue until Stop. |
| Image sharing on a call | Staging selected images for later delegated vision work; staging is not itself a task. |
| Live captions | Independent input/output caption streams. |
| Saved-task context | Acknowledged context from the current task, with explicit same-task restart. |
| Duration receipts | Live usage seconds posted separately from delegated model/tool costs. |
| Append bounds | Commentary/thinking/instruction appends split at a 500-token bound. |
| Busy-queue steering | Later delegation while a call is busy is acknowledged without a second POST; later speech may require clarification. |
| Engine-switch serialization | Changing the saved engine waits until the active call is released; host disposal refuses later starts. |
| Speech settings | Engine, keys, endpoints, and voices stored through Speech settings and SecretStorage. |

## Self-heal and recovery

| Feature | Description |
|---|---|
| Self-heal tools | Isolated diagnosis and repair of Raya itself, distinct from ordinary coding goals. |
| Captured-source verification | Repair artifacts carry archive/CLI hashes and source-check lineage. |
| Classification refine | Repair agent can reconcile its own item classification. |
| Database recovery archive | Destructive session migrations capture a recovery archive in the same transaction. |
| Session migration wizard | UI to migrate older session state with progress and interruption handling. |
| Auto-recovery | Restart/reconnect paths for interrupted routine starts, missing queue links, and uncertain session creation. |
| Diagnostics export | Allowlisted local diagnostic summary with minimized snapshot identity. |
| HTTP recorder | Loopback capture/replay with secret redaction, including binary body inspection. |

## Routing, models, and cost

| Feature | Description |
|---|---|
| Auto routing | Auto mode selects models/variants and specialists; details are under Subagents and routing. |
| Chief route tool | Model-facing `chief_route` that separates intent, capabilities, and execution authority. |
| Model per mode | Assign a default model to each agent mode. |
| Local models | Any OpenAI-compatible local runtime (Ollama, LM Studio, llama.cpp, vLLM) as a custom provider. |
| Project usage | Persisted step-finish tokens and cost grouped by provider/model over 24h, 7d, 30d, or all. |
| Session cost details | Input, output, reasoning, cache read/write kept separate; unknown price is not shown as free. |
| TUI / CLI stats | Terminal family summary, run footer, and `kilo` statistics commands. |
| Native voice usage | Immutable token/duration receipts for native voice, distinct from model-step accounting. |
| Cost alert | Composer/header warning when usage crosses configured attention. |

## Memory, indexing, and context

| Feature | Description |
|---|---|
| Project memory | Durable markdown-backed memory with save, recall, capture, and redaction. |
| Memory provenance | Transcript can show recorded startup/recall receipts, sources, and known-unrecorded legacy fields. |
| Semantic search | Index-backed code search when indexing is enabled. |
| Codebase indexing | Optional embedding index with consent and status in settings. |
| LSP tool | Language-server diagnostics and navigation through the agent. |
| Context tab | Controls what editor, workspace, and instruction context is sent. |
| Rules / instructions | Project and global instruction files injected into agent context. |
| Skills | Loadable agent skills, including bundled browser skills and user/project skills. |
| Discover capabilities | Read-only catalog of local file, document, spreadsheet, repo, and chart tools for the current turn. |

## Agent tools (workspace)

| Feature | Description |
|---|---|
| Read / write / edit | Read files, write files, and apply edits or patches. |
| Glob / grep | Find paths and search file contents (ripgrep). |
| Shell | Run commands through the configured shell (`bash` compatibility name). |
| Apply patch | Apply unified patches as a first-class tool. |
| Todo write | Conversation task list distinct from durable goal plans. |
| Task / subagent | Spawn a child agent/session; see Subagents and routing. |
| Plan exit | Structured plan-mode completion. |
| Question / ask options | Ask the user a question or present selectable options. |
| Suggest | Show one or two in-chat suggestion chips the user can accept or dismiss. |
| Web fetch / web search | Fetch URLs and search the web (including Kilo/Exa search where configured). |
| Repo overview / clone | Summarize a repository or clone a remote. |
| Notebooks | Read, edit, and execute notebooks when the host notebook service is present. |
| Interactive terminal | Long-lived interactive terminal sessions. |
| Background process | Start/inspect background jobs and ports. |
| Notify user | Host notification from the agent. |
| Send file | Send a file through the host/session channel. |
| Chart | Render a Chart.js chart in-session. |
| Generate image | Generate images through the configured image model. |
| XLSX / ODS extract | Extract labelled spreadsheet values without claiming formula recalculation. |
| DOCX extract | Extract Word document text. |
| Semantic search tool | Index-backed search when indexing is on. |
| Agent Manager tools | Orchestrate extra manager sessions and list their models from the agent. |
| Schedule task | Create or inspect scheduled routine work from the agent. |
| Code mode | Constrained code-generation mode tool. |
| Plugins / MCP | Third-party MCP servers and plugin tools with catalog and timeout settings. |
| Skill tool | Invoke a skill package. |

## Permissions, sandbox, and safety

| Feature | Description |
|---|---|
| Permission prompts | Ask / allow / deny for shell, edits, browser, and other categories. |
| Auto-approve | User-configured always-allow rules with canonical comparison so saved allows survive config reorder. |
| Policy snapshots | Pending approvals refuse after an unrelated restrictive policy change. |
| Sandbox | Optional OS sandbox (seatbelt / bubblewrap where supported); Windows OS confinement is disclosed as unsupported. |
| External directory guard | Tools refuse or special-case paths outside the project. |
| Network profile | Sandbox/network environment for tool processes. |
| Secret redaction | Recorder and diagnostic paths strip known secrets; telemetry logs stay secret-free. |
| Telemetry opt-out | PostHog/OTel client with opt-out at the calling boundary; receiving-side consent order is still an open gap. |
| Local-service topology | Managed backend binds loopback, ephemeral port, disabled discovery, and HTTP size/idle caps. |
| Redirect refusal | Broker, media, and telemetry refuse credential/context redirects. |

## Editor assistance

| Feature | Description |
|---|---|
| Inline autocomplete | Ghost-text completions from the backend. |
| Next-edit | Jump/accept or dismiss predicted next edits. |
| Explain / fix / improve code | Editor commands that send the selection to chat with a support prompt. |
| Inline edit | In-place edit command on selected code. |
| Add to chat / context | Selection, files, or terminal output added to the composer. |
| Terminal explain / fix | Explain or repair the last terminal command. |
| Generate terminal command | Produce a shell command from a prompt. |
| Generate commit message | SCM-view commit message generation. |
| Code actions | Lightbulb/support prompts registered in the editor. |

## Settings and profile

| Feature | Description |
|---|---|
| Providers | Connect and manage model providers and keys. |
| Models | Browse, pin, and inspect models. |
| Agent behaviour | Mode, workflow, and agent-behaviour settings. |
| Auto-approve | Per-category approval defaults. |
| Checkpoints | Snapshot tracking preferences. |
| Sandboxing | Sandbox and network policy UI. |
| Browser settings | Browser automation and profile controls. |
| Speech | Voice engine and keys. |
| Goals / routing | Goal orchestration and Auto routing preferences. |
| Indexing | Enable/status for codebase embeddings. |
| Autocomplete | Completions and next-edit options. |
| Context | What context is included in prompts. |
| Display | Visual density and display options. |
| Notifications | Completion and notification preferences. |
| Language | UI language. |
| Commit messages | Commit-message generation options. |
| Experimental | Session share, formatter, LSP, batch, image generation, notebooks, continue-on-deny, multi-project, MCP timeout, per-tool toggles. |
| Profile / device auth | Kilo account profile and device-flow login. |
| Anaconda desktop | Optional Anaconda Desktop integration dialog and API. |

## Marketplace, KiloClaw, and extras

| Feature | Description |
|---|---|
| Marketplace | Browse, install, and remove project/global marketplace items (modes, skills, MCP). |
| KiloClaw | Separate panel for KiloClaw conversations, setup, upgrade, messages, and reactions (upstream-linked surface). |
| Session sharing | Experimental manual/auto/disabled sharing of sessions. |
| Image generation setting | Enable image generation and pick the image model. |
| Native notebook tools | Experimental host notebook tools. |
| Enhance prompt | Server/API path to rewrite a user prompt. |
| Commit-message API | Backend endpoint used by the SCM commit-message command. |
| Help command | In-product help command wiring. |

## CLI commands (engine)

| Feature | Description |
|---|---|
| `kilo` TUI | Default interactive terminal session. |
| `kilo serve` | Start the local HTTP/SSE backend. |
| `kilo run` | Headless run. |
| `kilo attach` | Attach to an existing server. |
| `kilo session` | List/inspect sessions. |
| `kilo export` / `import` | Session interchange. |
| `kilo models` / `providers` | List models and providers. |
| `kilo mcp` | Manage MCP servers. |
| `kilo agent` | Agent/mode related CLI. |
| `kilo account` | Account/auth CLI. |
| `kilo github` | GitHub integration commands. |
| `kilo pr` | Pull-request helpers. |
| `kilo stats` | Usage statistics. |
| `kilo config` | Config inspection/editing. |
| `kilo upgrade` / `uninstall` | Installer lifecycle. |
| `kilo db` | Database maintenance. |
| `kilo generate` | Generation utilities. |
| `kilo plug` | Plugin-related CLI. |
| `kilo remote` | Remote session/attachment. |
| `kilo acp` | Agent Client Protocol server. |
| Cloud CLI | Kilo cloud-related CLI commands in the kilocode tree. |

## Host commands (VS Code)

| Feature | Description |
|---|---|
| New task / plus | Start a new conversation from the sidebar. |
| History / routines / settings / profile | Open those surfaces from the sidebar title bar. |
| Check for updates / set update token | Private VSIX update flow. |
| Open diagnostics | Open the local diagnostic bundle UI. |
| Open browser | Open the host browser panel. |
| Migration wizard | Open session migration. |
| Show / toggle memory | Open or toggle project memory. |
| Focus chat / cycle mode / toggle auto-approve | Keyboard productivity commands. |
| Reload / heap snapshot | Developer reload and memory snapshot. |

## Supporting libraries (shipped, not user-facing products)

| Feature | Description |
|---|---|
| kilo-ui | Shared SolidJS component library for the webview. |
| kilo-telemetry | PostHog analytics and OpenTelemetry tracing. |
| kilo-memory | Memory capture, recall, and storage implementation. |
| kilo-indexing | Embedding/index support used by console and indexing. |
| kilo-sandbox | Sandbox backends (bubblewrap/seatbelt) used by the CLI. |
| kilo-plugin | Plugin/tool interface definitions. |
| Design-system helpers | Designer agent plus [`packages/opencode/src/kilocode/design-system/index.ts`](../packages/opencode/src/kilocode/design-system/index.ts). |
| kilo-docs | Documentation site (Next.js + Markdoc) for the product. |

# Future

Documented in the repo, not shipped as finished product. Do not treat these rows as available features.

## Immediate leftovers (current audit / Live)

| Feature | Description | Where |
|---|---|---|
| Packaged Live microphone / acoustic acceptance | Real account, microphone, interruption quality, and latency still required for voice. | [Handoff](Raya-Remaining-Implementation-Handoff.md) |
| Receiving-side telemetry consent order | An old enable can still apply after a later opt-out. | EN-13 |
| Full 38 remaining audit requirements | Implementation plus live/packaged acceptance still open on all IDs except EN-08. | [Progress](Raya-Implementation-Progress.md) |
| Warm handoff and durable spoken snapshots | Live reconnect/history must not replay work; not implemented as product. | OVR-01 |
| Parent/child budget reservation | Cross-child spend limits and attributable overrides. | PR-05 / OVR-04 |
| Per-path and plugin confinement | Path/service grants and trusted-plugin sandbox beyond category deny. | PR-04 |
| Domain capability packs | Documents, slides, research, communications connectors with export contracts. | OVR-08 |
| Self-heal publish / install / rollback | Repair VSIX publication and post-install recovery. | OVR-09 |
| Full UI surface redesign | Remaining chat, history, review, settings, and first-success UX. | OVR-07 / PR-01 |
| Assistive-technology gates | Full AT, high-contrast, and zoom across surfaces. | UI-02 |

## UX foundation (not yet done)

From [Raya-Agent-UX-Foundation.md](Raya-Agent-UX-Foundation.md). Some pieces exist; these are the remaining essentials.

| Feature | Description |
|---|---|
| One active-run language | Queue vs Stop vs goal steering copy that always matches backend behavior. |
| Authoritative queue UI | Visible order, cancel, edit/reorder of queued prompts from `session.queue.changed`. |
| Goal-scoped review and ordered discard | Discard must not report success when snapshots are missing or the session is busy. |
| Discoverable slash commands | Status, Fork, Worktree, Plan as first-class composer commands. |
| One truthful progress surface | Current step from real todos/status, no duplicate timelines or fake activity. |
| Checkpoint picker in the timeline | Jump to a snapshot from conversation history. |
| Per-hunk keep/discard | True line-range revert (backend does not exist yet; file-level Keep/Undo is current). |
| Side-chat / temporary fork lifecycle | `/side` distinct from persistent `/fork`. |
| Direct subagent steering | Steer a running child without treating it as a new parent prompt. |

## Codex-deferred (`CDX-*`)

From [Raya-Codex-Research-Deferred.md](Raya-Codex-Research-Deferred.md). Research only; not approved for implementation until the 39 requirements and Live leftovers finish.

| ID | Description |
|---|---|
| CDX-B01 | Native desktop-app control (Windows UI Automation), distinct from the in-editor browser. |
| CDX-B02 | Pair to the user's existing Chrome/Edge tabs via a browser extension. |
| CDX-B03 | Visual comments on a page tied to document identity and screenshot hash. |
| CDX-B04 | WebMCP page-registered tools from the current origin. |
| CDX-B05 | Grounded element references and persistent QA inventories. |
| CDX-B06 | Reproducible skill packages with provenance, hash, and evaluations. |
| CDX-A01 | Atomic sibling-capacity reservation before creating children. |
| CDX-A02 | Explicit parallel vs exclusive tool admission, observable as waiting vs working. |
| CDX-A03 | Inherited conversation evidence vs inherited executable authority. |
| CDX-A04 | Bounded skill discovery with truthful partial results. |
| CDX-A05 | Deterministic skill precedence with shadowed alternatives. |
| CDX-A06 | Acknowledged persist/flush/shutdown phases. |
| CDX-U01 | Explicit queue vs immediate steering composer actions. |
| CDX-U02 | Searchable prompt recall that does not fake restored attachments. |
| CDX-U03 | Selected-commit and last-turn review scopes. |
| CDX-U04 | Reversible Local ↔ worktree conversation handoff. |
| CDX-U05 | Temporary side-conversation lifecycle (`/side`, `/btw`). |
| CDX-U06 | Effective configuration provenance (value, origin, restriction). |

## To-build roadmap (open goals)

From [docs/to-build/build-goals.md](to-build/build-goals.md). Routines, presence, and structured plans are already current; the rest are future.

| Goal | Description |
|---|---|
| Canvas repair | Make the live React canvas reliable (Goal 3). |
| Deterministic lifecycle hooks | Plugin/session hooks that fire at defined phases. |
| True per-hunk undo | Revert selected line ranges without desyncing snapshots. |
| In-editor Cmd/Ctrl+I | Inline edit overlay (command exists; Cursor-style overlay does not). |
| Per-hunk gutter affordances | File-level Keep/Undo repeated per hunk (honest file scope). |
| Status / preview / takeover on terminal and canvas | Same pattern as the browser panel. |
| Design-system lock flag | Owner lock so generation stays on the chosen system. |
| Design-system-aware generation loop | Generate against the locked system, not a one-off aesthetic. |
| Canvas Design Mode | Inspect/tweak overlay that emits a change hint to the agent. |
| Run artifact capture | Screenshot/recording of canvas or preview for goal evidence. |
| Mobile / web companion | Phone/PWA client over Tailscale to watch and steer local `kilo serve`. See [Raya-Mobile-Companion-Plan.md](Raya-Mobile-Companion-Plan.md). |
| GitHub-native PR review | Review PRs as a first-class GitHub flow. |
| PR autofix | Apply review findings as a follow-up agent run. |
| Issue → PR background agent | Open a PR from an issue without a local driver. |
| Agent SDK + CI runner | Run Raya in CI as a headless SDK consumer. |
| Cloud agents in isolated VMs | Provisioned remote environments; no control plane today. |
| Cloud ↔ local session handoff | Move a live session between PC and cloud. |
| Parallel multi-agent orchestration surface | Cloud-scale sibling orchestration beyond Agent Manager. |
| Design ↔ code round-trip | Faithful Figma↔code beyond the designer prompt. |
| Verify UI without hand-driving the browser | Stronger automated visual verification. |
| Convergence cap on redesign cascades | Stop verify/redesign loops. |
| Distinguish user takeover from bad model input | Browser/canvas recovery copy. |
| Per-role memory | Designer remembers design decisions; accountant remembers financial context (Grok-bot note). |
| Auth gateway | Per-user tokens in front of `kilo serve` (prerequisite for mobile multi-user and cloud). |

## Product direction (owner notes)

Owner-written end-state. **None of these is a current product feature.** A few overlap a Current slice or another Future row; that overlap is a starting point, not completion.

| # | Feature | Description | Overlap / current gap |
|---|---|---|---|
| 1 | Astra-class computer use | Desktop computer use as capable as OpenAI Astra Computer Use (including lessons from the Browser Use team's reverse-engineering write-up). | Related to Future CDX-B01. Today's in-editor browser is not OS-level computer use. |
| 2 | Live multimodal vision (desktop and mobile) | Show the model the screen or camera live, especially on the mobile client, so it can process what it is shown in real time. | Voice/browser screenshots exist. Live mobile vision and continuous desktop multimodal capture do not. |
| 3 | Time in chat | Message timestamps in conversation UI the way Codex shows time. | Not shipped. |
| 4 | Intelligent subagent spawning from any mode | Any model/mode/agent can spawn subagents when the work needs it, not only Auto. Spawned children get intelligent names. | Current: Auto/`task` can delegate specialists. Gap: not all modes spawn freely; children are not intelligently named in the UI. Voice mode currently denies `task`. |
| 5 | Visible, monitorable subagents | Active subagents are easy to open from the main UI to watch what they are doing. | Current: Agent Manager subagent tabs. Gap: not a first-class, glanceable monitor in ordinary chat. |
| 6 | Full Kilo → Raya rebrand | Migrate off Kilo: names, packages, commands, traces, marketplace copy, `kilo serve` identity. The product is Raya end to end. | Current clients still say kilo/`kilo-code` in many traces. |
| 7 | Own editor (VS Code fork) | Eventually ship a Cursor-like fork of VS Code so Raya owns the full UI, not only an extension. | Current: `eden.raya` extension inside VS Code/Cursor. |
| 8 | Contact the owner | Routine (and other) agents can reach the user by email, WhatsApp, Telegram, the in-app Raya messenger, or all of those. | Not shipped. `notify_user` is host-local only. |
| 9 | Organizations of agents | Create named orgs (example: Website Builders) with roles (design, accounting, growth, CEO, scrape, report, chief designer, sub-designers, coder/frontend, host, sales, marketing, customer success). Assign jobs; agents coordinate, go outside, hand off, and close the loop through to paid work. As many orgs as wanted. This is the **end goal of routines**. | Current: single-worker routines plus worker-to-worker delegation. Gap: no org graph, no multi-role company as a first-class object. |
| 10 | Universal skills; stronger designer | Update `designer.md` and `designer.txt`. Every agent can load designer. Add universal skills: coding (influenced by Astra's system prompt), marketing, writing, and the same for other roles. | Current: designer.txt and browser skills. Gap: not universal; coding/marketing/writing skills and Astra-influenced coding skill are not shipped. |
| 11 | Admin / health console | An admin surface with every Raya part, health, and logs for debugging. | Current: diagnostics export. Gap: no admin console covering all subsystems. |
| 12 | Messenger-style routine chats | Routine threads look and behave like iMessage/WhatsApp: chat info, settings, shared media/links, and which agents that worker talked to and what they shared. Agents in an org can message each other. | Current: two-pane inbox. Gap: no chat-info pane, media inventory, or org-wide agent graph. |
| 13 | Create routine or org from main chat | From ordinary chat, say create a routine or an organization; the agent uses `ask`/`ask_options` to clarify, then creates it. UI must support both single routines and organizations with strong UX. | Current: `schedule_task` and Routines panel create. Gap: no org create, no first-class “create from chat” journey with clarifying questions. |
| 14 | Survive restarts and rebuilds | Routines and agents keep identity, jobs, conversations, and in-flight work across session restart, extension reload, and VSIX rebuild. | Current: persisted tasks/occurrences/inbox. Gap: full lifecycle across rebuild, locked CLI, and host replacement still needs to be product-true. |
| 15 | Personal intelligent todo | A personal todo tab: manual items, focus timer, agent-assisted organization and reminders. Example: “Rent a house” → ask clarifying questions → populate ADHD-style subtasks (research area, budget, house type). | Current: conversation todos and goals. Gap: no personal todo product, no focus timer, no reminder loop. |
| 16 | Cloud session storage and remote continue | Sessions and routines stored in the cloud so a home PC can keep running while the user continues chats, routines, and monitoring from a phone or another PC anywhere. | Related to Future mobile companion, auth gateway, and cloud ↔ local handoff. Not shipped. |

This is a product inventory, not a support matrix. For client/platform evidence see [Raya-Supported-Clients.md](Raya-Supported-Clients.md). For remaining unfinished acceptance see [Raya-Remaining-Implementation-Handoff.md](Raya-Remaining-Implementation-Handoff.md).
