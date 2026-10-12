import assert from "node:assert/strict"
import { Window } from "happy-dom"

const window = new Window()
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  PointerEvent: window.PointerEvent,
  CustomEvent: window.CustomEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})
const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { RoutineActivity } = await import("../../webview-ui/src/components/chat/RoutineActivity")
const { ReportingChoice } = await import("../../webview-ui/src/components/routines/ReportingChoice")

const root = document.createElement("div")
document.body.append(root)
const card = {
  version: 1 as const,
  id: "occurrence-original",
  agentID: "routine-original",
  reportSessionID: "origin",
  name: "Review accounts",
  status: "queued" as const,
  delivery: "delivered" as const,
  revision: 1,
  at: 1700000000000,
  summary: "",
  projectID: "project-original",
  directory: "/original",
  notice: { at: 1700000000000, reason: "busy" as const },
}
const [items, setItems] = createSignal<Parameters<typeof RoutineActivity>[0]["items"]>([card])
const [error, setError] = createSignal<string>()
const [choice, setChoice] = createSignal("origin")
const [next, setNext] = createSignal<string>()
const [historical, setHistorical] = createSignal(false)
const [loading, setLoading] = createSignal(false)
const [bootstrap, setBootstrap] = createSignal<Parameters<typeof RoutineActivity>[0]["bootstrap"]>()
const opened: [string, string | undefined][] = []
let refreshed = 0
let older = 0
let latest = 0
let retried = 0
let resumed = 0
const dispose = render(
  () => (
    <>
      <RoutineActivity
        items={items()}
        error={error()}
        next={next()}
        historical={historical()}
        loading={loading()}
        bootstrap={bootstrap()}
        onRefresh={() => refreshed++}
        onOlder={() => older++}
        onLatest={() => latest++}
        onRetry={() => retried++}
        onContinue={() => resumed++}
        onOpen={(agent, worker) => opened.push([agent, worker])}
      />
      <ReportingChoice
        value={choice()}
        choices={[
          { id: "origin", label: "This chat" },
          { id: "review", label: "Monthly review" },
        ]}
        onChange={setChoice}
      />
    </>
  ),
  root,
)
try {
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(root.querySelectorAll("[data-report-id]").length, 1)
  assert.match(root.textContent!, /Waiting to start/)
  assert.equal(root.querySelectorAll('[data-slot="routine-activity-notice"]').length, 1)
  assert.match(root.textContent!, /Raya was busy/)
  assert.equal(root.querySelector("time")?.dateTime, new Date(card.notice.at).toISOString())
  assert.doesNotMatch(root.textContent!, /View worker conversation/)
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>("button")]
  buttons()
    .find((button) => button.textContent?.includes("View routine"))!
    .click()
  assert.deepEqual(opened, [[card.agentID, undefined]])
  setItems([{ ...card, status: "running", revision: 2, workerSessionID: "worker-original" }])
  assert.equal(root.querySelectorAll("[data-report-id]").length, 1)
  assert.match(root.textContent!, /Running/)
  setItems([
    {
      ...card,
      status: "complete",
      revision: 3,
      workerSessionID: "worker-original",
      summary: "<script>Original verified report</script>",
    },
  ])
  assert.equal(root.querySelectorAll("[data-report-id]").length, 1)
  assert.match(root.textContent!, /Run finished/)
  assert.equal(root.querySelectorAll('[data-slot="routine-activity-notice"]').length, 1)
  assert.match(root.textContent!, /Start delay recorded/)
  assert.equal(root.querySelector("script"), null)
  assert.match(root.textContent!, /<script>Original verified report<\/script>/)
  buttons()
    .find((button) => button.textContent?.includes("View worker conversation"))!
    .click()
  assert.deepEqual(opened.at(-1), [card.agentID, "worker-original"])
  setError("Connection unavailable.")
  assert.match(root.textContent!, /Previously loaded reports remain visible/)
  assert.equal(root.querySelectorAll("[data-report-id]").length, 1)
  buttons()
    .find((button) => button.textContent?.includes("Refresh latest reports"))!
    .click()
  assert.equal(refreshed, 1)
  const select = root.querySelector<HTMLButtonElement>('[data-slot="select-select-trigger"]')!
  assert.ok(
    select
      .getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .some((id) => document.getElementById(id)?.textContent === "Report conversation"),
  )
  assert.match(select.textContent!, /This chat/)
  select.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
  await new Promise((resolve) => setImmediate(resolve))
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("Monthly review"),
  )
  assert.ok(option, "The existing Select must open its reporting destinations")
  option.click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(choice(), "review")
  assert.equal(root.querySelectorAll('[data-slot="select-select-trigger"]').length, 1)
  setNext("opaque-next")
  buttons()
    .find((button) => button.textContent?.trim() === "Older reports")!
    .click()
  assert.equal(older, 1)
  setHistorical(true)
  assert.match(root.textContent!, /Viewing older reports/)
  buttons()
    .find((button) => button.textContent?.trim() === "Back to latest")!
    .click()
  assert.equal(latest, 1)
  buttons()
    .find((button) => button.textContent?.trim() === "Retry this page")!
    .click()
  assert.equal(retried, 1)
  setItems([])
  setError(undefined)
  setNext(undefined)
  assert.ok(root.querySelector('[data-component="routine-activity"]'), "An empty historical page remains visible")
  assert.ok(buttons().find((button) => button.textContent?.trim() === "Back to latest"))
  setBootstrap({ complete: false, scanned: 200, total: 501 })
  assert.match(root.textContent!, /200 of 501 records checked/)
  assert.equal(root.querySelectorAll("[data-report-id]").length, 0)
  assert.doesNotMatch(root.textContent!, /No reports|No history/)
  buttons()
    .find((button) => button.textContent?.trim() === "Continue loading reports")!
    .click()
  assert.equal(resumed, 1)
  setNext("opaque-next")
  setLoading(true)
  const pending = buttons().find((button) => button.textContent?.trim() === "Older reports")!
  assert.equal(pending.disabled, true)
  pending.click()
  assert.equal(older, 1)
} finally {
  dispose()
  await window.happyDOM.close()
}
