// raya_change - dev-only visual preview harness. Renders isolated presentational
// components with mock props, in mocked light and dark VS Code themes, so they
// can be reviewed and screenshotted without a running backend.
/* @refresh reload */
import "@kilocode/kilo-ui/styles"
import "../src/styles/eden.css"
import "../src/styles/banners.css"
import "../src/styles/task-header.css"
import "./preview.css"
import { render } from "solid-js/web"
import { For, Show, type Component } from "solid-js"
import { installMockVsCode } from "./mock-vscode"
import { GoalBannerView } from "../src/components/chat/GoalBanner"
import type { GoalBannerProps } from "../src/components/chat/GoalBanner"
import type { GoalState, GoalStatus } from "../../src/shared/goal"
import { UsageHistoryView } from "../src/components/chat/UsageHistory"
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
  | "paused"
  | "complete"
  | "blocked"
  | "notice"
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
  "paused",
  "complete",
  "blocked",
  "notice",
]
const themes: Theme[] = ["light", "dark"]

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
  if (state === "discard") return { goal: goal("paused"), todos, expanded: true, confirmingDiscard: true }
  if (state === "discard-busy") {
    return {
      goal: goal("paused"),
      todos,
      expanded: true,
      confirmingDiscard: true,
      discardDisabled: true,
      discardHint: "Pause the goal and wait for the current step to stop before discarding.",
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

const Fixture: Component<{ id: string; theme: Theme; state: PvState }> = (props) => (
  <figure class="pv-fixture" data-fixture={props.id}>
    <figcaption class="pv-fixture__label">
      {props.theme} · {props.state}
    </figcaption>
    <div class={`pv-panel pv-theme--${props.theme}`}>
      <Show when={props.state === "usage"} fallback={<GoalBannerView {...propsFor(props.state)} />}>
        <UsageHistoryView range="7d" usage={usage} locale="en" providers={{}} />
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
          Goal status banner on Eden tokens. Instrument Serif for the voice, Outfit for the UI.
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
