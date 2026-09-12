// raya_change - dev-only visual preview harness. Renders isolated presentational
// components with sample props and explicitly labeled illustrative markup, in
// simulated VS Code themes. Only production-view fixtures verify product markup.
/* @refresh reload */
import "@kilocode/kilo-ui/styles"
import "../src/styles/eden.css"
import "../src/styles/banners.css"
import "../src/styles/task-header.css"
import "../src/styles/session-actions.css" // raya_change - preview the Review/Keep/Undo cluster
import "../src/styles/prompt-input.css" // raya_change - preview the composer chrome
import "../src/styles/history.css" // raya_change - preview the history + session-list surfaces
import "../src/styles/tool-overrides.css" // raya_change - preview the bundled tool-call group (#8)
import "../src/styles/chat-layout.css" // raya_change - preview conversation lane + turn rhythm (#12)
import "../src/styles/memory-provenance.css"
import "../src/styles/routines.css"
import "./preview.css"
import { RoutinesPreview } from "./routines"
import { render } from "solid-js/web"
import { For, Show, type Component } from "solid-js"
import { installMockVsCode } from "./mock-vscode"
import { GoalBannerView } from "../src/components/chat/GoalBanner"
import type { GoalBannerProps } from "../src/components/chat/GoalBanner"
import type { GoalState, GoalStatus } from "../../src/shared/goal"
import { UsageHistoryView } from "../src/components/chat/UsageHistory"
import { MemoryProvenance } from "../src/components/chat/MemoryProvenance"
import { provenance } from "../../src/shared/memory-provenance"
import type { ProjectUsage } from "../src/types/messages"

installMockVsCode()

type PvState =
  | "default"
  | "hover"
  | "focus"
  | "pressed"
  | "disabled"
  | "expanded"
  | "editing"
  | "discard"
  | "discard-busy"
  | "usage"
  | "memory"
  | "memory-legacy"
  | "paused"
  | "complete"
  | "blocked"
  | "notice"
  | "slash"
  | "review"
  | "review-undo"
  | "composer"
  | "composer-focus"
  | "topnav"
  | "transcript"
  | "edit-review"
  | "history"
  | "conversation"
  | "routines"
type Theme = "light" | "dark"

const states: PvState[] = [
  "default",
  "hover",
  "focus",
  "pressed",
  "disabled",
  "expanded",
  "editing",
  "discard",
  "discard-busy",
  "usage",
  "memory",
  "memory-legacy",
  "paused",
  "complete",
  "blocked",
  "notice",
  "slash",
  "review",
  "review-undo",
  "composer",
  "composer-focus",
  "topnav",
  "transcript",
  "edit-review",
  "history",
  "conversation",
  "routines",
]
const themes: Theme[] = ["light", "dark"]

function receipt(legacy: boolean) {
  const value = provenance({
    type: "text",
    text: "",
    synthetic: true,
    ignored: true,
    metadata: {
      kiloMemory: legacy
        ? { type: "recall", sources: ["project-notes.md"] }
        : {
            type: "startup",
            count: 6,
            tokens: 720,
            files: ["team-preferences.md", `${"long-project-name-".repeat(12)}.md`],
            captured: 1_788_998_400_000,
            scope: { directory: "C:/Projects/example/worktrees/review", project: "example-project" },
          },
    },
  })
  if (!value) throw new Error("Invalid memory preview receipt")
  return value
}

const memory = receipt(false)
const legacy = receipt(true)

const now = Date.now()
const usage: ProjectUsage = {
  range: "7d",
  since: now - 7 * 86_400_000,
  until: now,
  timezone: "UTC",
  sessions: 18,
  totals: {
    steps: 94,
    cost: 12.4831,
    tokens: { input: 824_500, output: 126_800, reasoning: 41_200, cache: { read: 1_420_000, write: 88_000 } },
  },
  models: [
    {
      providerID: "openai",
      modelID: "gpt-5.3-codex",
      steps: 51,
      cost: 8.992,
      tokens: { input: 430_000, output: 76_000, reasoning: 31_000, cache: { read: 910_000, write: 48_000 } },
    },
    {
      providerID: "qwen",
      modelID: "qwen3.8-max",
      steps: 43,
      cost: 3.4911,
      tokens: { input: 394_500, output: 50_800, reasoning: 10_200, cache: { read: 510_000, write: 40_000 } },
    },
  ],
}

// Mock goal props. The words are fixture copy for the preview, not product copy.
const goal = (status: GoalStatus, extra?: Partial<GoalState>): GoalState => ({
  objective: "Stand up the preview harness and redesign the goal banner with Eden typography.",
  status,
  createdAt: now - 86_400_000,
  updatedAt: now - 60_000,
  usage: { turns: 12, continuations: 3, toolCalls: 87 },
  progress: [{ at: now - 60_000, kind: "turn", message: "Verified the preview serves cleanly on localhost." }],
  ...extra,
})

const propsFor = (state: PvState): GoalBannerProps => {
  const todos = [
    { id: "preview", content: "Build the preview harness", status: "completed" as const, priority: "high" as const },
    {
      id: "states",
      content: "Verify every state in both themes",
      status: "in_progress" as const,
      priority: "high" as const,
    },
    { id: "compile", content: "Run the extension compile", status: "pending" as const, priority: "medium" as const },
  ]
  if (state === "hover") return { goal: goal("active"), pv: "hover" }
  if (state === "focus") return { goal: goal("active"), pv: "focus" }
  if (state === "pressed") return { goal: goal("active"), pv: "active" }
  if (state === "disabled") return { goal: goal("active"), disabled: true }
  if (state === "expanded") return { goal: goal("active"), todos, expanded: true }
  if (state === "editing") return { goal: goal("active"), todos, expanded: true, editing: true }
  if (state === "discard") return { goal: goal("paused"), todos, expanded: true, confirmingStop: true }
  if (state === "discard-busy") {
    return {
      goal: goal("paused"),
      todos,
      expanded: true,
      confirmingStop: true,
    }
  }
  if (state === "paused") return { goal: goal("paused") }
  if (state === "complete") return { goal: goal("complete") }
  if (state === "blocked") {
    return {
      goal: goal("blocked", { blockedReason: "Compile failed. Fix the type errors, then run the smoke run again." }),
    }
  }
  if (state === "notice") {
    return {
      goal: goal("active"),
      notice: "Raya recognized this as durable goal work and will continue until it is verified or honestly blocked.",
    }
  }
  return { goal: goal("active") }
}

// raya_change - presentational replica of the slash pill in a rendered user
// bubble, using the real kilo-ui class contract so the composer and transcript
// pill treatment can be verified by eye in both themes.
const SlashBubble: Component = () => (
  <div class="chat-view">
    <div data-component="user-message">
      <div data-slot="user-message-text">
        <span data-highlight="slash" data-command="goal">
          /goal
        </span>{" "}
        Redesign the composer, then run{" "}
        <span data-highlight="slash" data-command="loop">
          /loop
        </span>{" "}
        to keep iterating on the preview.
      </div>
    </div>
  </div>
)

// raya_change - the chat-level Review changes cluster: Review changes with counts,
// Keep all, and the in-place Undo all -> Confirm undo swap (no clipping question).
const ReviewCluster: Component<{ confirming?: boolean }> = (props) => (
  <div class="session-actions-row">
    <div class="session-review-cluster">
      <button type="button" class="session-move-changes session-move-changes--has-changes">
        <span class="session-review-label">Review changes</span>
        <span class="session-diff-add">+128</span>
        <span class="session-diff-del">-14</span>
      </button>
      <Show when={!props.confirming}>
        <button type="button" class="session-move-changes">
          Keep all
        </button>
      </Show>
      <Show
        when={props.confirming}
        fallback={
          <button type="button" class="session-move-changes">
            Undo all
          </button>
        }
      >
        <button type="button" class="session-move-changes session-move-changes--confirm">
          Confirm undo
        </button>
        <button type="button" class="session-move-changes">
          Cancel
        </button>
      </Show>
    </div>
  </div>
)

// raya_change - presentational replica of the composer chrome using the real
// class contract. The overlay mirrors the textarea so the in-field slash pill
// and caret alignment can be judged by eye. Empty draft shows the placeholder.
const Composer: Component<{ focus?: boolean; empty?: boolean }> = (props) => (
  <div
    class="prompt-input-container"
    style={props.focus ? "border-color: color-mix(in srgb, var(--text-base) 32%, transparent)" : ""}
  >
    <div class="prompt-input-wrapper">
      <div class="prompt-input-ghost-wrapper">
        <Show when={!props.empty}>
          <div class="prompt-input-highlight-overlay" aria-hidden="true">
            <span class="prompt-input-slash" data-command="goal">
              /goal
            </span>{" "}
            Redesign the composer as one calm editorial sheet.
          </div>
        </Show>
        <textarea
          class="prompt-input"
          placeholder="Ask Raya, or start a durable goal with /goal"
          value={props.empty ? "" : "/goal Redesign the composer as one calm editorial sheet."}
          rows={1}
        />
      </div>
    </div>
    <div class="prompt-input-hint">
      <div class="prompt-input-hint-selectors">
        <button type="button" data-component="button">
          Agent
        </button>
        <button type="button" data-component="button">
          qwen3-max
        </button>
        <button type="button" data-component="button">
          Thinking
        </button>
      </div>
      <div class="prompt-input-hint-actions">
        <button type="button" data-component="button" aria-label="Attach">
          +
        </button>
        <button
          type="button"
          data-component="button"
          class="prompt-send-button prompt-send-button--ready"
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </div>
  </div>
)

// raya_change - top-nav replica using the real task-header class contract:
// serif title, mono run metrics, text-first Summarize, quiet expand chevron.
const TopNav: Component = () => (
  <div data-component="task-header">
    <div data-slot="task-header-title">
      <span data-slot="task-header-title-trigger">
        <span data-slot="task-header-title-label" dir="auto">
          Redesign Raya into an editorial system
        </span>
      </span>
    </div>
    <div data-slot="task-header-stats">
      <span>$0.42</span>
      <span>38%</span>
      <button type="button" data-component="button" class="task-header-compact">
        Summarize
      </button>
      <button type="button" data-slot="task-header-expand" aria-label="Toggle timeline">
        ⌄
      </button>
    </div>
  </div>
)

// raya_change - transcript replica exercising the three treatments the objective
// names: grey Thought/Explored affordance, compact mono file-edit header, grey
// terminal output. Uses the real kilo-ui class contract inside .chat-view so the
// theme-scoped rules apply.
const Transcript: Component = () => (
  <div class="chat-view">
    <div data-component="reasoning-part">
      <div data-slot="collapsible-trigger">
        <div data-slot="reasoning-header">
          <span data-component="icon">◦</span>
          <span data-slot="reasoning-label">Thought</span>
          <span data-slot="reasoning-title">for 6s · weighed the composer focus treatment</span>
        </div>
      </div>
    </div>
    <div data-component="tool-part-wrapper" data-tool="edit">
      <div data-component="tool-trigger">
        <div data-component="edit-trigger">
          <div data-slot="message-part-title-area">
            <div data-slot="message-part-title">
              <span data-slot="message-part-title-filename">prompt-input.css</span>
              <span data-slot="message-part-directory-inline">webview-ui/src/styles</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div data-component="bash-output">
      <div data-slot="bash-terminal" data-kind="command">
        <div data-slot="bash-section" data-kind="command">
          <span data-slot="bash-prompt" aria-hidden="true">
            $
          </span>
          <div data-slot="bash-section-code">
            <pre data-slot="bash-pre">
              <code data-lang="shellscript">bun run typecheck</code>
            </pre>
          </div>
        </div>
      </div>
      <div data-slot="bash-terminal" data-kind="output">
        <div data-slot="bash-section" data-kind="output">
          <div data-slot="bash-section-code">
            <pre data-slot="bash-pre">
              <code data-lang="log">Checked 42 files in 1.2s. No errors.</code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  </div>
)

// raya_change - presentational replica of the inline edit-review chrome, mirroring
// the DOM the VS Code override emits so the hued block + pills + navigator can be
// checked in both themes without the full tool registry.
const ReviewEdit: Component<{ status?: "added" | "deleted" | "modified"; nav?: boolean }> = (props) => (
  <div class="chat-view">
    <div data-component="edit-review-block" data-review-status={props.status ?? "modified"} data-review-pending="">
      <div data-component="tool-part-wrapper" data-tool="edit">
        <div data-component="tool-trigger">
          <div data-component="edit-trigger">
            <div data-slot="message-part-title-area">
              <div data-slot="message-part-title">
                <span data-slot="message-part-title-filename">prompt-input.css</span>
                <span data-slot="message-part-directory-inline">webview-ui/src/styles</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div data-slot="edit-review-actions">
        <button type="button" data-slot="edit-review-undo">
          Undo
        </button>
        <button type="button" data-slot="edit-review-keep">
          Keep
        </button>
        <Show when={props.nav}>
          <span data-slot="edit-review-nav">
            <button type="button" aria-label="Previous edit">
              ‹
            </button>
            <span data-slot="edit-review-count">1 of 2</span>
            <button type="button" aria-label="Next edit">
              ›
            </button>
          </span>
        </Show>
      </div>
    </div>
  </div>
)

// raya_change - history + session-list replica mirroring the real kilo-ui List
// DOM contract (search field, caps group headers, rows with title + relative
// date, selected/active states) so the Eden dressing can be checked in both
// themes without the session context, dialog, and context-menu providers.
const sessions: { id: string; title: string; when: string; group: string }[] = [
  { id: "s1", title: "Reskin the composer and goal bar", when: "2h ago", group: "Today" },
  { id: "s2", title: "Inline edit-review chrome", when: "5h ago", group: "Today" },
  { id: "s3", title: "Per-file undo, keep the conversation", when: "Yesterday", group: "Yesterday" },
  { id: "s4", title: "Eden token layer for the webview", when: "Tue", group: "This week" },
  { id: "s5", title: "Bundle Instrument Serif and Outfit offline", when: "Mon", group: "This week" },
]

const HistoryRow: Component<{
  s: (typeof sessions)[number]
  active?: boolean
  selected?: boolean
}> = (props) => (
  <div class="session-row">
    <button
      type="button"
      data-slot="list-item"
      data-active={props.active ? "true" : "false"}
      data-selected={props.selected ? "true" : "false"}
    >
      <span data-slot="list-item-title" dir="auto">
        {props.s.title}
      </span>
      <span data-slot="list-item-description">{props.s.when}</span>
    </button>
    <span data-slot="session-row-action">✎</span>
    <span data-slot="session-row-action">🗑</span>
  </div>
)

const History: Component = () => {
  const groups = ["Today", "Yesterday", "This week"]
  return (
    <div class="history-view">
      <div class="history-view-header">
        <span style={{ color: "var(--text-weak)", "font-size": "12px" }}>‹ Back</span>
        <div class="history-view-tabs" role="tablist">
          <button type="button" class="history-tab-btn history-tab-btn--active">
            Local
          </button>
          <button type="button" class="history-tab-btn">
            Cloud
          </button>
        </div>
        <span class="history-import-btn" style={{ color: "var(--text-weak)", "font-size": "12px" }}>
          Import
        </span>
      </div>
      <div class="history-view-content">
        <div class="session-list">
          <div data-component="list">
            <div data-slot="list-search-wrapper">
              <div data-slot="list-search">
                <div data-slot="list-search-container">
                  <span style={{ opacity: 0.5 }}>⌕</span>
                  <span style={{ color: "var(--text-weak)", "font-size": "13px" }}>Search sessions…</span>
                </div>
              </div>
            </div>
            <div data-slot="list-scroll">
              <For each={groups}>
                {(group) => (
                  <div data-slot="list-group">
                    <div data-slot="list-header">{group}</div>
                    <div data-slot="list-items">
                      <For each={sessions.filter((s) => s.group === group)}>
                        {(s) => <HistoryRow s={s} active={s.id === "s2"} selected={s.id === "s1"} />}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// raya_change - #12/#15: a full user->assistant turn using the real class
// contract so the conversation rhythm can be judged by eye: user bubble, a
// bundled tool-call group (#8), assistant prose, then the edit-review card and
// the diff summary. Verifies turns read as a conversation, not a text column.
const Conversation: Component = () => (
  <div class="chat-view">
    <div class="message-list-content">
      <div class="vscode-session-turn" data-row="assistant">
        <div class="vscode-session-turn-user">
          <div data-component="user-message">
            <div data-slot="user-message-text">
              <span data-highlight="slash" data-command="goal">
                /goal
              </span>{" "}
              Make the transcript read like a real conversation and bundle the noisy tool calls.
            </div>
          </div>
        </div>
        <div class="vscode-session-turn-assistant">
          <div data-component="tool-part-wrapper" data-part-type="text">
            <div data-component="text-part">
              <div data-component="markdown">
                <p>
                  On it. I grouped the routing and goal-bookkeeping steps into a single quiet row so the conversation
                  stays readable, then made the edits.
                </p>
              </div>
            </div>
          </div>
          <div class="tool-group" data-open="">
            <button type="button" class="tool-group__summary" aria-expanded="true">
              <span data-component="icon">›</span>
              <span class="tool-group__count">3 steps</span>
              <span class="tool-group__names">get_goal, generalist agent, update_goal</span>
            </button>
          </div>
          <div class="tool-group">
            <button type="button" class="tool-group__summary" aria-expanded="false">
              <span data-component="icon">›</span>
              <span class="tool-group__count">2 steps</span>
              <span class="tool-group__names">read, grep</span>
            </button>
          </div>
          <div data-component="tool-part-wrapper" data-part-type="text">
            <div data-component="text-part">
              <div data-component="markdown">
                <p>Here's the change to the composer stylesheet.</p>
              </div>
            </div>
          </div>
          <div data-component="edit-review-block" data-review-status="modified" data-review-pending="">
            <div data-component="tool-part-wrapper" data-tool="edit">
              <div data-component="tool-trigger">
                <div data-component="edit-trigger">
                  <div data-slot="message-part-title-area">
                    <div data-slot="message-part-title">
                      <span data-slot="message-part-title-filename">eden.css</span>
                      <span data-slot="message-part-directory-inline">webview-ui/src/styles</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div data-slot="edit-review-actions">
              <button type="button" data-slot="edit-review-undo">
                Undo
              </button>
              <button type="button" data-slot="edit-review-keep">
                Keep
              </button>
            </div>
          </div>
        </div>
        <div class="vscode-session-turn-diffs" data-component="session-turn">
          <button type="button" class="vscode-session-turn-diffs-trigger">
            <span data-slot="session-turn-diffs-label">Modified</span>
            <span data-slot="session-turn-diffs-count">1 file</span>
          </button>
        </div>
      </div>
    </div>
  </div>
)

const chrome = new Set<PvState>([
  "conversation",
  "slash",
  "review",
  "review-undo",
  "composer",
  "composer-focus",
  "topnav",
  "transcript",
  "edit-review",
  "history",
])

const Fixture: Component<{ id: string; theme: Theme; state: PvState }> = (props) => (
  <figure
    class="pv-fixture"
    data-fixture={props.id}
    data-preview-kind={chrome.has(props.state) ? "illustrative" : "production-view"}
  >
    <figcaption class="pv-fixture__label">
      {props.theme} · {props.state}
      <span>
        {chrome.has(props.state) ? " · Illustrative markup; not production UI" : " · Production view with sample data"}
      </span>
    </figcaption>
    <div class={`pv-panel pv-theme--${props.theme}`}>
      <Show when={props.state === "usage"}>
        <UsageHistoryView range="7d" usage={usage} locale="en" providers={{}} />
      </Show>
      <Show when={props.state === "memory" || props.state === "memory-legacy"}>
        <MemoryProvenance receipt={props.state === "memory" ? memory : legacy} partID={props.id} />
      </Show>
      <Show when={props.state === "slash"}>
        <SlashBubble />
      </Show>
      <Show when={props.state === "review"}>
        <ReviewCluster />
      </Show>
      <Show when={props.state === "review-undo"}>
        <ReviewCluster confirming />
      </Show>
      <Show when={props.state === "composer"}>
        <Composer empty />
      </Show>
      <Show when={props.state === "composer-focus"}>
        <Composer focus />
      </Show>
      <Show when={props.state === "topnav"}>
        <TopNav />
      </Show>
      <Show when={props.state === "transcript"}>
        <Transcript />
      </Show>
      <Show when={props.state === "edit-review"}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
          <ReviewEdit status="added" nav />
          <ReviewEdit status="modified" />
          <ReviewEdit status="deleted" />
        </div>
      </Show>
      <Show when={props.state === "history"}>
        <History />
      </Show>
      <Show when={props.state === "conversation"}>
        <Conversation />
      </Show>
      <Show when={props.state === "routines"}>
        <RoutinesPreview />
      </Show>
      <Show
        when={
          props.state !== "usage" &&
          props.state !== "routines" &&
          !props.state.startsWith("memory") &&
          !chrome.has(props.state)
        }
      >
        <GoalBannerView {...propsFor(props.state)} />
      </Show>
    </div>
  </figure>
)

const focused = new URLSearchParams(window.location.search).get("state")
const fixtures = themes.flatMap((theme) => states.map((state) => ({ theme, state, id: `${theme}-${state}` })))

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")

render(
  () => (
    <main classList={{ "pv-page": true, "pv-page--focused": !!focused }}>
      <header class="pv-page__header">
        <h1 class="pv-page__title">Raya · component preview</h1>
        <p class="pv-page__sub">
          Goal, usage, memory and routines fixtures render production views with sample data. Composer, history, review
          and other illustrative fixtures are labeled and cannot establish production interaction or accessibility
          results.
        </p>
      </header>
      <For each={fixtures}>
        {(fixture) => (
          <Show when={!focused || fixture.id === focused}>
            <Fixture id={fixture.id} theme={fixture.theme} state={fixture.state} />
          </Show>
        )}
      </For>
    </main>
  ),
  root,
)
