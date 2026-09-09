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
              value: { agents: () => [] },
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
const button = (text) => {
  const found = [...root.querySelectorAll("button")].find((item) => item.textContent.trim() === text)
  assert.ok(found, `Missing button: ${text}`)
  return found
}
try {
  await new Promise((resolve) => setImmediate(resolve))
  const request = sent.find((msg) => msg.type === "routineList")
  const reply = (msg) => emit({ requestID: request.requestID, viewID: request.viewID, refreshID: 1, ...msg })
  const agent = {
    id: "routine",
    name: "Review",
    role: "reviewer",
    objective: "Review changes",
    capabilities: [],
    schedule: { kind: "manual" },
    enabled: true,
    access: "brief",
  }
  reply({ type: "routineState", refresh: "loading" })
  for (let i = 0; i < 100; i++) emit({ type: "sessionTurnClosed", sessionID: `session-${i}` })
  assert.equal(sent.filter((msg) => msg.type === "routineList").length, 1)
  reply({ type: "routineState", agents: [agent], templates: [] })
  reply({
    type: "routineRuns",
    agentID: agent.id,
    runs: [{ id: "run", agentID: agent.id, status: "complete", at: 1, outcome: { summary: "Retained report" } }],
  })
  reply({ type: "routineState", refresh: "complete" })
  assert.equal(sent.filter((msg) => msg.type === "routineList").length, 2)
  assert.match(root.textContent, /Retained report/)
  reply({ type: "routineState", refreshID: 2, refresh: "loading" })
  reply({ type: "routineRuns", refreshID: 2, agentID: agent.id, error: "History unavailable" })
  reply({ type: "routineState", refreshID: 2, refresh: "partial", failed: [agent.id] })
  assert.match(root.textContent, /History may be stale: History unavailable/)
  assert.match(root.textContent, /Some history could not be refreshed/)
  assert.match(root.textContent, /Retained report/)
  assert.equal(button("Refresh routines").disabled, false)
  button("Refresh routines").click()
  assert.equal(sent.filter((msg) => msg.type === "routineList").length, 3)
  reply({ type: "routineRuns", refreshID: 3, agentID: agent.id, runs: [] })
  reply({ type: "routineState", refreshID: 3, refresh: "complete" })
  assert.equal(root.textContent.includes("Retained report"), false)
  assert.equal(root.textContent.includes("History may be stale"), false)
  reply({
    type: "routineRuns",
    refreshID: 1,
    agentID: agent.id,
    runs: [{ outcome: { summary: "Late obsolete history" } }],
  })
  assert.equal(root.textContent.includes("Late obsolete history"), false)
  emit({ type: "workspaceDirectoryChanged", directory: "different" })
  reply({ type: "routineState", refreshID: 4, agents: [{ ...agent, name: "Wrong workspace" }] })
  assert.equal(root.textContent.includes("Wrong workspace"), false)
  const current = sent.findLast((msg) => msg.type === "routineList")
  assert.notEqual(current.viewID, request.viewID)
  emit({
    type: "routineState",
    requestID: current.requestID,
    viewID: current.viewID,
    refreshID: 5,
    refresh: "complete",
    agents: [],
  })
  emit({ type: "connectionState", state: "disconnected" })
  assert.match(root.textContent, /Disconnected/)
  emit({ type: "connectionState", state: "connected" })
  assert.equal(button("Refresh routines").disabled, true)
  assert.equal(
    sent.some((msg) => msg.type === "routineRun"),
    false,
  )
  const { RoutineRefresh } = await import("../../src/kilo-provider/routine-refresh.ts")
  const { handleRoutineMessage } = await import("../../src/kilo-provider/routines.ts")
  const offline = new RoutineRefresh(() => ({ client: null, directory: "workspace", generation: 1 }), emit)
  const retry = sent.findLast((msg) => msg.type === "routineList")
  try {
    await handleRoutineMessage({
      client: null,
      directory: "workspace",
      message: retry,
      post: emit,
      refresh: (id, view) => offline.request(id, view),
    })
    assert.equal(button("Refresh routines").disabled, false)
    assert.match(root.textContent, /Refresh failed/)
  } finally {
    offline.dispose()
  }
  const output = {
    destination: "conversation",
    description: "Original requirements",
    criteria: [{ id: "criterion", description: "Report sources", verification: "Check references" }],
  }
  emit({
    type: "routineState",
    requestID: retry.requestID,
    viewID: retry.viewID,
    refreshID: 6,
    agents: [{ ...agent, output }],
  })
  button("Edit output").click()
  button("Save requirements").click()
  const saving = sent.findLast((msg) => msg.type === "routineOutputUpdate")
  emit({
    type: "routineOutputUpdated",
    requestID: saving.requestID,
    agentID: agent.id,
    error: "Requirements changed; compare first.",
  })
  button("Compare with current requirements").click()
  const comparison = sent.findLast((msg) => msg.type === "routineList")
  emit({
    type: "routineState",
    requestID: comparison.requestID,
    viewID: retry.viewID,
    refreshID: 7,
    refresh: "loading",
  })
  assert.equal(button("Loading current requirements").disabled, true)
  assert.equal(root.textContent.includes("This routine is no longer available"), false)
  emit({
    type: "routineState",
    requestID: comparison.requestID,
    viewID: retry.viewID,
    refreshID: 7,
    agents: [{ ...agent, output: { ...output, description: "Current authoritative requirements" } }],
  })
  assert.match(root.querySelector("[data-routine-comparison]").textContent, /Current authoritative requirements/)
  assert.equal(root.querySelector("section textarea").value, "Original requirements")
  console.log("routine-refresh-view: 22 assertions passed")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
