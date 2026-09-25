// raya_change - dev-only visual preview harness. Renders isolated production
// components with sample props in simulated VS Code themes.
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
import "../src/styles/welcome.css"
import "../src/styles/memory-provenance.css"
import "../src/styles/routines.css"
import "../src/styles/chat.css"
import "../kiloclaw/kiloclaw.css"
import "../agent-manager/agent-manager.css"
import "./preview.css"
import { RoutinesPreview } from "./routines"
import { MessengerPreview } from "./messenger"
import {
  BackgroundAgentsPreview,
  AgentManagerSubagentsPreview,
  ChildViewerPreview,
  ComposerPreview,
  WelcomePreview,
  CloudRecoveryPreview,
  HistoryPreview,
  QuestionPreview,
  ReviewPreview,
  EditReviewPreview,
  RecoveryPreview,
} from "./surfaces"
import { ConversationPreview, SlashPreview, TopNavPreview, TranscriptPreview } from "./chrome"
import { render } from "solid-js/web"
import { For, Show, createSignal, type Component } from "solid-js"
import { installMockVsCode } from "./mock-vscode"
import { Card } from "@kilocode/kilo-ui/card"
import { GoalBannerView } from "../src/components/chat/GoalBanner"
import type { GoalBannerProps } from "../src/components/chat/GoalBanner"
import type { GoalState, GoalStatus } from "../../src/shared/goal"
import { UsageHistoryView } from "../src/components/chat/UsageHistory"
import { MemoryProvenance } from "../src/components/chat/MemoryProvenance"
import { MemoryActions, WorkLocation } from "../src/components/settings/ContextTab"
import type { MemoryContextValue } from "../src/context/memory"
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
  | "context"
  | "paused"
  | "waiting"
  | "complete"
  | "blocked"
  | "notice"
  | "slash"
  | "review"
  | "review-undo"
  | "review-loading"
  | "review-unavailable"
  | "review-workspace"
  | "composer"
  | "composer-focus"
  | "welcome"
  | "cloud-recovery"
  | "topnav"
  | "transcript"
  | "edit-review"
  | "history"
  | "question"
  | "conversation"
  | "background-agents"
  | "child-viewer"
  | "agent-manager-subagents"
  | "routines"
  | "messenger"
  | "result"
  | "recovery"
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
  "context",
  "paused",
  "waiting",
  "complete",
  "blocked",
  "notice",
  "slash",
  "review",
  "review-undo",
  "review-loading",
  "review-unavailable",
  "review-workspace",
  "composer",
  "composer-focus",
  "welcome",
  "cloud-recovery",
  "topnav",
  "transcript",
  "edit-review",
  "history",
  "question",
  "conversation",
  "background-agents",
  "child-viewer",
  "agent-manager-subagents",
  "routines",
  "messenger",
  "result",
  "recovery",
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
  charges: {
    goals: 4,
    unreadable: 1,
    conflicts: 1,
    items: [
      {
        currency: "USD",
        provider: "Kilo",
        service: "Provider zero",
        source: "provider.receipt",
        amount: 0,
        recorded: 1,
        unknown: 0,
      },
      {
        provider: "Kilo",
        service: "Interrupted search",
        source: "provider-response-without-receipt",
        recorded: 0,
        unknown: 1,
      },
    ],
  },
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

const criteria = [
  {
    id: "preview",
    description: "Serve the preview harness without a 503 on first request.",
    verification: "Open the focused result fixture and confirm the production banner.",
    required: true as const,
    check: {
      kind: "command" as const,
      command: "bunx playwright test --config playwright.preview.config.ts",
      directory: "C:/Users/User/Desktop/raya/packages/kilo-vscode",
    },
  },
  {
    id: "device",
    description: "Confirm the result on a real device.",
    verification: "Inspect the packaged webview on a machine with a microphone.",
    required: false as const,
  },
]

const requirements = [
  {
    criterionID: "preview",
    requirement: "Deliver the preview harness",
    passed: true,
    evidence: [{ callID: "rebuild", summary: "esbuild rebuilt the preview before listen." }],
  },
  {
    criterionID: "device",
    requirement: "Review on a real device",
    passed: false,
    evidence: [],
  },
]

const pack = (status: GoalStatus, extra?: Partial<GoalState>): GoalState =>
  goal(status, {
    criteria,
    review: {
      status: "accepted",
      at: now - 30_000,
      criteria: ["preview"],
      acceptedAt: now - 15_000,
    },
    audit: {
      summary: "Preview rebuilt before listen; device review remains unverified.",
      requirements,
      verifiedAt: now - 45_000,
    },
    auditAttempt: { accepted: true, at: now - 45_000, requirements },
    deliverables: [
      {
        kind: "browser-download",
        path: "C:\\browser-artifacts\\monthly-report\\artifact",
        transferID: "transfer-monthly-report",
        filename: "monthly-report.csv",
        url: "https://example.com/monthly-report.csv",
        bytes: 2048,
        sha256: "b".repeat(64),
        tool: "browser_download",
        evidence: { callID: "download-report", summary: "Inspected the completed browser download." },
      },
    ],
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
  if (state === "disabled") return { goal: goal("active"), todos, expanded: true, disabled: true }
  if (state === "expanded") return { goal: goal("active"), todos, expanded: true }
  if (state === "editing") {
    return {
      goal: goal("active", {
        criteria,
        budget: { chargeCosts: [{ currency: "USD", limit: 4, reservation: 0.5 }] },
      }),
      todos,
      expanded: true,
      editing: true,
    }
  }
  if (state === "discard") return { goal: goal("paused"), todos, expanded: true, confirmingStop: true }
  if (state === "discard-busy") {
    return {
      goal: goal("paused"),
      todos,
      expanded: true,
      confirmingStop: true,
    }
  }
  if (state === "paused") return { goal: goal("paused"), todos, expanded: true }
  if (state === "waiting")
    return {
      goal: goal("paused", { review: { status: "pending", at: now - 30_000, criteria: [] } }),
      todos,
      expanded: true,
    }
  if (state === "complete") return { goal: goal("complete") }
  if (state === "result") return { goal: pack("complete"), todos, expanded: true }
  if (state === "blocked") {
    return {
      goal: goal("blocked", { blockedReason: "Compile failed. Fix the type errors, then run the smoke run again." }),
      todos,
      expanded: true,
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

const banners = new Set<PvState>([
  "default",
  "hover",
  "focus",
  "pressed",
  "disabled",
  "expanded",
  "editing",
  "discard",
  "discard-busy",
  "paused",
  "waiting",
  "complete",
  "blocked",
  "notice",
  "result",
])

function ContextPreview() {
  const [outcome, setOutcome] = createSignal("No context change submitted")
  const memory = {
    status: () => undefined,
    loading: () => false,
    pending: () => false,
    error: () => undefined,
    enabled: () => true,
    totalTokens: () => 420,
    refresh: () => undefined,
    inspect: () => undefined,
    enable: () => undefined,
    disable: () => undefined,
    auto: () => undefined,
    correct: (text: string) => (setOutcome(`Correction saved: ${text}`), true),
    forget: (query: string) => (setOutcome(`Removal requested: ${query}`), true),
  } satisfies MemoryContextValue
  return (
    <section aria-label="Context provenance">
      <WorkLocation
        directory="C:\\work\\raya-feature"
        root="C:\\work\\raya-feature\\.kilo\\memory"
        scope="project"
        index={{
          message: "Index is stale after the worktree changed.",
          label: "IDX Error",
          tone: "error",
          loading: false,
        }}
      />
      <Card>
        <MemoryActions memory={memory} />
      </Card>
      <p aria-live="polite" data-testid="context-outcome">
        {outcome()}
      </p>
    </section>
  )
}

const Fixture: Component<{ id: string; theme: Theme; state: PvState }> = (props) => (
  <figure class="pv-fixture" data-fixture={props.id} data-preview-kind="production-view">
    <figcaption class="pv-fixture__label">
      {props.theme} · {props.state}
      <span> · Production view with sample data</span>
    </figcaption>
    <div class={`pv-panel pv-theme--${props.theme}`}>
      <Show when={props.state === "usage"}>
        <UsageHistoryView range="7d" usage={usage} locale="en" providers={{}} />
      </Show>
      <Show when={props.state === "memory" || props.state === "memory-legacy"}>
        <MemoryProvenance
          receipt={props.state === "memory" ? memory : legacy}
          partID={props.id}
          onReview={() => undefined}
        />
      </Show>
      <Show when={props.state === "context"}>
        <ContextPreview />
      </Show>
      <Show when={props.state === "slash"}>
        <SlashPreview />
      </Show>
      <Show when={props.state === "review"}>
        <ReviewPreview />
      </Show>
      <Show when={props.state === "review-undo"}>
        <ReviewPreview confirming />
      </Show>
      <Show when={props.state === "review-loading"}>
        <ReviewPreview status="loading" />
      </Show>
      <Show when={props.state === "review-unavailable"}>
        <ReviewPreview status="unavailable" />
      </Show>
      <Show when={props.state === "review-workspace"}>
        <ReviewPreview status="workspace" />
      </Show>
      <Show when={props.state === "composer"}>
        <ComposerPreview />
      </Show>
      <Show when={props.state === "composer-focus"}>
        <ComposerPreview focus />
      </Show>
      <Show when={props.state === "welcome"}>
        <WelcomePreview />
      </Show>
      <Show when={props.state === "cloud-recovery"}>
        <CloudRecoveryPreview />
      </Show>
      <Show when={props.state === "topnav"}>
        <TopNavPreview />
      </Show>
      <Show when={props.state === "transcript"}>
        <TranscriptPreview />
      </Show>
      <Show when={props.state === "edit-review"}>
        <EditReviewPreview />
      </Show>
      <Show when={props.state === "history"}>
        <HistoryPreview />
      </Show>
      <Show when={props.state === "question"}>
        <QuestionPreview />
      </Show>
      <Show when={props.state === "conversation"}>
        <ConversationPreview />
      </Show>
      <Show when={props.state === "background-agents"}>
        <BackgroundAgentsPreview />
      </Show>
      <Show when={props.state === "child-viewer"}>
        <ChildViewerPreview />
      </Show>
      <Show when={props.state === "agent-manager-subagents"}>
        <AgentManagerSubagentsPreview />
      </Show>
      <Show when={props.state === "recovery"}>
        <RecoveryPreview />
      </Show>
      <Show when={props.state === "routines"}>
        <RoutinesPreview />
      </Show>
      <Show when={props.state === "messenger"}>
        <MessengerPreview />
      </Show>
      <Show when={banners.has(props.state)}>
        <GoalBannerView {...propsFor(props.state)} />
      </Show>
    </div>
  </figure>
)

const focused = new URLSearchParams(window.location.search).get("state")
const fixtures = themes.flatMap((theme) => states.map((state) => ({ theme, state, id: `${theme}-${state}` })))

if (focused?.startsWith("light-")) document.body.classList.add("pv-theme--light")
if (focused?.startsWith("dark-")) document.body.classList.add("pv-theme--dark")

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")

render(
  () => (
    <main classList={{ "pv-page": true, "pv-page--focused": !!focused }}>
      <header class="pv-page__header">
        <h1 class="pv-page__title">Raya · component preview</h1>
        <p class="pv-page__sub">
          Goal, usage, memory, routines, agents, composer, history, review, slash, topnav, transcript, conversation, and
          result fixtures render production views with sample data.
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
