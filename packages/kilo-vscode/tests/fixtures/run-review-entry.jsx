import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { VSCodeProvider } from "../../webview-ui/src/context/vscode"
import { RunReview } from "../../webview-ui/src/components/routines/RunReview"

const rows = ["first", "second", "third"].map((id, index) => ({
  id,
  at: Date.parse(`2026-10-19T12:${46 + index}:17Z`),
  status: "complete",
  sessionID: `session-${id}`,
  trigger: {
    kind: "timer",
    id: `occurrence-${id}`,
    scheduledAt: Date.parse(`2026-10-19T12:${46 + index}:00Z`),
    observedAt: Date.parse(`2026-10-19T12:${46 + index}:17Z`),
    tz: "America/Toronto",
  },
  outcome: { kind: "notify", summary: `Exact ${id} final report` },
}))
const messages = []
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (message) => {
    messages.push(message)
    document.body.dataset.messages = JSON.stringify(messages)
  },
})

const [runs, setRuns] = createSignal(rows)
window.review = {
  clone: () => setRuns(structuredClone(rows)),
  reorder: () => {
    const next = structuredClone(rows)
    next[2].status = "stopped"
    setRuns([next[1], { ...structuredClone(rows[0]), id: "fourth", sessionID: "session-fourth" }, next[2], next[0]])
  },
  reply: (request, objective) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          ...request,
          snapshot: {
            version: 1,
            agentID: request.agentID,
            runID: request.runID,
            at: rows.find((row) => row.id === request.runID).at,
            objective,
            definition: { name: objective },
          },
        },
      }),
    ),
}

render(
  () => (
    <VSCodeProvider>
      <RunReview
        id="review"
        name="Saved worker"
        agentID="worker"
        selected="third"
        runs={runs()}
        onClose={() => {}}
        onOpenSession={(id) => (document.body.dataset.opened = id)}
      />
    </VSCodeProvider>
  ),
  document.getElementById("root"),
)
