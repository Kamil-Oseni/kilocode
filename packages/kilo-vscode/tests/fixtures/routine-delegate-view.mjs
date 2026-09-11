import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-delegate-dom",
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
  "HTMLTextAreaElement",
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
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
                    return createComponent(RoutinesView, {})
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
const person = (name) => {
  const found = [...root.querySelectorAll(".routines-identity")].find((item) => item.textContent.includes(name))
  assert.ok(found, `Missing worker: ${name}`)
  return found
}
try {
  await new Promise((resolve) => setImmediate(resolve))
  const request = sent.find((msg) => msg.type === "routineList")
  const chief = {
    id: "chief",
    name: "Chief of Staff",
    role: "briefer",
    objective: "Coordinate Friday close",
    capabilities: [],
    schedule: { kind: "manual" },
    enabled: true,
    access: "brief",
  }
  const books = {
    id: "books",
    name: "Books",
    role: "accountant",
    objective: "Review accounts",
    capabilities: ["accounting"],
    schedule: { kind: "manual" },
    enabled: true,
    access: "full",
  }
  emit({
    type: "routineState",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    agents: [chief, books],
    templates: [],
  })
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: chief.id,
        conversationID: "rcv_chief",
        name: chief.name,
        role: chief.role,
        unread: 0,
        state: "scheduled",
      },
      {
        agentID: books.id,
        conversationID: "rcv_books",
        name: books.name,
        role: books.role,
        unread: 0,
        state: "scheduled",
      },
    ],
  })
  emit({ type: "routineState", requestID: request.requestID, viewID: request.viewID, refreshID: 1, refresh: "complete" })
  person("Chief of Staff").click()
  await new Promise((resolve) => setImmediate(resolve))
  const page = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(page.agentID, chief.id)
  emit({
    type: "routineInboxPage",
    requestID: page.requestID,
    agentID: chief.id,
    messages: [],
  })
  assert.match(root.textContent, /Does not change either assignment/)
  const area = root.querySelector("textarea[aria-label='Ask another worker']")
  area.value = "Review Friday expenses."
  area.dispatchEvent(new window.Event("input", { bubbles: true }))
  button("Ask Books").click()
  const first = sent.findLast((msg) => msg.type === "routineDelegate")
  assert.equal(first.agentID, chief.id)
  assert.equal(first.recipientID, books.id)
  assert.equal(first.objective, "Review Friday expenses.")
  assert.equal(first.parentRunID, undefined)
  emit({
    type: "routineDelegated",
    requestID: first.requestID,
    agentID: chief.id,
    error: "Could not ask that worker.",
  })
  assert.match(root.textContent, /Could not ask that worker/)
  button("Retry ask Books").click()
  const retry = sent.findLast((msg) => msg.type === "routineDelegate")
  assert.equal(retry.source, first.source)
  assert.equal(retry.objective, first.objective)
  emit({
    type: "routineDelegated",
    requestID: retry.requestID,
    agentID: chief.id,
    record: { id: "rdl_1", source: retry.source, state: "queued" },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(root.textContent, /Queued until this worker is free/)
  const reload = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(reload.agentID, chief.id)
  emit({
    type: "routineInboxPage",
    requestID: reload.requestID,
    agentID: chief.id,
    messages: [
      {
        id: "rmg_sent",
        agentID: chief.id,
        kind: "delegation",
        source: `sent:${retry.source}`,
        occurrenceID: "rdl_1",
        body: "Asked Books:\nReview Friday expenses.\nThis request is queued until the worker is free. It has not started.",
        time: 2,
      },
    ],
  })
  assert.match(root.textContent, /Asked another worker/)
  assert.match(root.textContent, /Asked Books/)
  assert.match(root.textContent, /queued until the worker is free/)
  assert.equal(root.querySelector("textarea[aria-label='Ask another worker']").value, "")
  button("Show request chain").click()
  const inspect = sent.findLast((msg) => msg.type === "routineDelegateChain")
  assert.equal(inspect.agentID, chief.id)
  assert.equal(inspect.id, "rdl_1")
  emit({
    type: "routineDelegateChain",
    requestID: inspect.requestID,
    agentID: chief.id,
    id: "rdl_1",
    error: "The request chain could not be read.",
  })
  assert.match(root.textContent, /The request chain could not be read/)
  button("Show request chain").click()
  const againChain = sent.findLast((msg) => msg.type === "routineDelegateChain")
  assert.equal(againChain.id, inspect.id)
  emit({
    type: "routineDelegateChain",
    requestID: againChain.requestID,
    agentID: chief.id,
    id: "rdl_1",
    record: {
      id: "rdl_1",
      state: "queued",
      objective: "Review Friday expenses.",
    },
    above: [],
    below: [
      {
        id: "rdl_child",
        state: "queued",
        objective: "Name the missing travel receipts.",
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(root.textContent, /This request/)
  assert.match(root.textContent, /Follow-on request/)
  assert.match(root.textContent, /Name the missing travel receipts/)
  button("Stop this request").click()
  const stop = sent.findLast((msg) => msg.type === "routineDelegateCancel")
  assert.equal(stop.agentID, chief.id)
  assert.equal(stop.id, "rdl_1")
  emit({
    type: "routineDelegateStopped",
    requestID: stop.requestID,
    agentID: chief.id,
    error: "Could not stop that request.",
  })
  assert.match(root.textContent, /Could not stop that request/)
  button("Stop this request").click()
  const again = sent.findLast((msg) => msg.type === "routineDelegateCancel")
  assert.equal(again.id, stop.id)
  emit({
    type: "routineDelegateStopped",
    requestID: again.requestID,
    agentID: chief.id,
    record: { id: "rdl_1", state: "cancelled" },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const after = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: after.requestID,
    agentID: chief.id,
    messages: [
      {
        id: "rmg_sent",
        agentID: chief.id,
        kind: "delegation",
        source: `sent:${retry.source}`,
        occurrenceID: "rdl_1",
        body: "Asked Books:\nReview Friday expenses.\nThis request is queued until the worker is free. It has not started.",
        time: 2,
      },
      {
        id: "rmg_reply",
        agentID: chief.id,
        kind: "delegation",
        source: `reply:${retry.source}`,
        body: "Delegation cancelled (Books).\nStopped by the user.\nThis is not a completed worker reply.",
        time: 3,
      },
    ],
  })
  assert.match(root.textContent, /Answer from another worker/)
  assert.equal(
    [...root.querySelectorAll("button")].some((item) => item.textContent.trim() === "Stop this request"),
    false,
  )
  button("Back").click()
  person("Books").click()
  await new Promise((resolve) => setImmediate(resolve))
  const asked = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(asked.agentID, books.id)
  emit({
    type: "routineInboxPage",
    requestID: asked.requestID,
    agentID: books.id,
    messages: [
      {
        id: "rmg_ask",
        agentID: books.id,
        kind: "delegation",
        source: `ask:${retry.source}`,
        body: "Request from Chief of Staff:\nReview Friday expenses.",
        time: 2,
      },
    ],
  })
  assert.match(root.textContent, /Asked you/)
  assert.match(root.textContent, /Request from Chief of Staff/)
  button("Back").click()
  person("Chief of Staff").click()
  await new Promise((resolve) => setImmediate(resolve))
  const reopen = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: reopen.requestID,
    agentID: chief.id,
    messages: [],
  })
  emit({
    type: "routineRuns",
    agentID: chief.id,
    runs: [
      {
        id: "occ_parent",
        agentID: chief.id,
        at: 1,
        sessionID: "ses_chief",
        status: "running",
      },
    ],
  })
  const area2 = root.querySelector("textarea[aria-label='Ask another worker']")
  area2.value = "Need the missing receipts."
  area2.dispatchEvent(new window.Event("input", { bubbles: true }))
  button("Ask Books").click()
  const linked = sent.findLast((msg) => msg.type === "routineDelegate")
  assert.equal(linked.parentRunID, "occ_parent")
  assert.equal(linked.objective, "Need the missing receipts.")
  emit({
    type: "routineDelegated",
    requestID: linked.requestID,
    agentID: chief.id,
    record: {
      id: "rdl_2",
      source: linked.source,
      state: "failed",
      reason: "This worker is paused. Delegation is not started until it is enabled.",
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(area2.value, "Need the missing receipts.")
  assert.match(root.textContent, /This worker is paused/)
  emit({ type: "routineState", agents: [chief, { ...books, enabled: false }] })
  assert.match(root.textContent, /Paused workers cannot start a new request/)
  assert.equal(button("Books is paused").disabled, true)
  const asks = sent.filter((msg) => msg.type === "routineDelegate").length
  button("Books is paused").click()
  assert.equal(sent.filter((msg) => msg.type === "routineDelegate").length, asks)
  emit({
    type: "routineInbox",
    items: [
      {
        agentID: chief.id,
        conversationID: "rcv_chief",
        name: chief.name,
        role: chief.role,
        unread: 0,
        state: "scheduled",
      },
      {
        agentID: books.id,
        conversationID: "rcv_books",
        name: books.name,
        role: books.role,
        unread: 0,
        state: "paused",
      },
    ],
  })
  person("Books").click()
  await new Promise((resolve) => setImmediate(resolve))
  const paused = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({ type: "routineInboxPage", requestID: paused.requestID, agentID: books.id, messages: [] })
  assert.match(root.textContent, /Follow-ups still arrive here/)
  assert.match(root.textContent, /Scheduled starts stay off/)
  console.log("routine-delegate-view: paused recipient copy passed")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
