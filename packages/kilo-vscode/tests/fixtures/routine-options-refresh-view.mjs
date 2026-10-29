import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-refresh-dom",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        configFile: false,
        babelrc: false,
        presets: [
          [import.meta.resolve("babel-preset-solid"), { generate: "dom" }],
          import.meta.resolve("@babel/preset-typescript"),
        ],
      })
      if (!result?.code) throw new Error("No compiled component")
      return { contents: result.code, loader: "js" }
    })
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad({ filter: /\?worker&url$/ }, () => ({ contents: "export default 'test-worker.js'", loader: "js" }))
  },
})
const window = new Window()
for (const name of [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "MessageEvent",
  "CustomEvent",
])
  globalThis[name] = window[name]
globalThis.window = window
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
const sent = []
globalThis.acquireVsCodeApi = () => ({
  postMessage: (msg) => sent.push(msg),
  getState: () => undefined,
  setState: () => {},
})
const { createComponent } = await import("solid-js")
const { render } = await import("solid-js/web")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode.tsx")
const { LanguageContext } = await import("../../webview-ui/src/context/language.tsx")
const { SessionContext } = await import("../../webview-ui/src/context/session.tsx")
const { DialogProvider } = await import("@kilocode/kilo-ui/context/dialog")
const { default: RoutinesView } = await import("../../webview-ui/src/components/routines/RoutinesView.tsx")
const root = document.createElement("div")
const opened = []
document.body.append(root)
const dispose = render(
  () =>
    createComponent(VSCodeProvider, {
      get children() {
        return createComponent(LanguageContext.Provider, {
          value: { t: (key) => key },
          get children() {
            return createComponent(SessionContext.Provider, {
              value: { agents: () => [], sessions: () => [], currentSessionID: () => undefined },
              get children() {
                return createComponent(DialogProvider, {
                  get children() {
                    return createComponent(RoutinesView, { onOpenSession: (id) => opened.push(id) })
                  },
                })
              },
            })
          },
        })
      },
    }),
  root,
)
const emit = (data) => window.dispatchEvent(new window.MessageEvent("message", { data }))
const trigger = (id) => root.querySelector(`[data-routine-options="${id}"]`)
const item = (menu, text) =>
  [...menu.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim() === text)
const flush = () => new Promise((resolve) => setImmediate(resolve))
try {
  await flush()
  const request = sent.find((msg) => msg.type === "routineList")
  assert.ok(request)
  const reply = (agents, refreshID) =>
    emit({
      type: "routineState",
      requestID: request.requestID,
      viewID: request.viewID,
      refreshID,
      agents,
      templates: [],
    })
  const agent = {
    id: "amber",
    name: "Review",
    role: "reviewer",
    objective: "Original job",
    capabilities: [],
    schedule: { kind: "manual" },
    enabled: true,
    access: "brief",
  }
  const removed = { ...agent, id: "removed", name: "Removed worker" }
  reply([agent, removed], 1)
  const button = trigger(agent.id)
  assert.ok(button)
  const row = button.closest("li")
  const menu = row.querySelector('[role="menu"]')
  const run = item(menu, "Run now")
  const discarded = trigger(removed.id).closest("li")
  button.click()
  run.focus()
  assert.equal(menu.hidden, false)
  assert.ok(document.activeElement === run)
  for (let index = 0; index < 3; index++) {
    const updated = { ...agent, name: "Updated review", objective: `Updated job ${index}`, enabled: false }
    reply(index % 2 ? [{ ...removed }, updated] : [updated, { ...removed }], index + 2)
    await flush()
    assert.ok(trigger(agent.id)?.closest("li") === row, "Refresh must preserve the worker row")
    assert.ok(row.querySelector('[role="menu"]') === menu, "Refresh must preserve the menu node")
    assert.equal(menu.hidden, false, "Refresh must leave the opened options menu visible")
    assert.ok(item(menu, "Run now") === run)
    assert.ok(
      document.activeElement === run,
      `Refresh ${index} must preserve focused action; actual=${document.activeElement?.tagName}:${document.activeElement?.textContent?.slice(0, 50)}`,
    )
    assert.match(row.textContent, new RegExp(`Updated job ${index}`))
    assert.equal(button.getAttribute("aria-label"), "Updated review options")
    assert.ok(item(menu, "Enable"), "Menu actions must use the current worker data")
  }
  const active = {
    ...agent,
    name: "Updated review",
    execution: { state: "active", runID: "latest-run", sessionID: "latest-session" },
  }
  reply([active], 5)
  assert.equal(discarded.isConnected, false, "Workers removed by the authoritative refresh must disappear")
  assert.equal(trigger(removed.id), null)
  assert.ok(trigger(agent.id)?.closest("li") === row)
  assert.equal(menu.hidden, false)
  const open = item(menu, "Open run")
  assert.ok(open, "The retained menu must react to a newly active execution")
  open.click()
  assert.deepEqual(opened, ["latest-session"], "Open run must use the latest execution instead of the captured worker")
  assert.equal(sent.filter((msg) => msg.type === "routineRun").length, 0)
  reply([{ ...agent, access: undefined }], 6)
  button.click()
  const start = item(menu, "Run now")
  assert.ok(start)
  assert.equal(start.disabled, true, "Removing access must disable the retained action")
  start.click()
  assert.equal(sent.filter((msg) => msg.type === "routineRun").length, 0)
  reply([{ ...agent, name: "Final review", objective: "Final job" }], 7)
  assert.equal(start.disabled, false)
  start.click()
  start.click()
  assert.deepEqual(
    sent.filter((msg) => msg.type === "routineRun"),
    [{ type: "routineRun", agentID: "amber" }],
  )
  assert.equal(menu.hidden, true)
  assert.equal(item(menu, "Running")?.disabled, true)
  button.click()
  assert.equal(menu.hidden, false)
  emit({ type: "workspaceDirectoryChanged", directory: "different" })
  assert.equal(row.isConnected, false, "Changing workspace must retire old worker rows")
  const current = sent.findLast((msg) => msg.type === "routineList")
  assert.notEqual(current.viewID, request.viewID)
  emit({
    type: "routineState",
    requestID: current.requestID,
    viewID: current.viewID,
    refreshID: 1,
    agents: [{ ...agent, name: "Other workspace" }],
    templates: [],
  })
  const next = trigger(agent.id).closest("li")
  assert.ok(next !== row, "Same ID in another workspace must create a new row")
  assert.equal(next.querySelector('[role="menu"]').hidden, true, "Another workspace must not inherit the open menu")
  trigger(agent.id).click()
  assert.equal(item(next, "Run now")?.disabled, false, "Another workspace must not inherit busy state")
  console.log(
    "routine-options-refresh-view: stable row, menu, focus, live actions, reorder, removal, workspace reset and single start passed",
  )
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
