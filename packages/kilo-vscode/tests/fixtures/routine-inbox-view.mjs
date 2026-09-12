import assert from "node:assert/strict"
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import { Window } from "happy-dom"

plugin({
  name: "routine-inbox-dom",
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
try {
  await new Promise((resolve) => setImmediate(resolve))
  const request = sent.find((msg) => msg.type === "routineList")
  const agent = {
    id: "routine",
    name: "Books",
    role: "accountant",
    objective: "Review accounts",
    capabilities: ["accounting"],
    schedule: { kind: "manual" },
    enabled: true,
    access: "brief",
  }
  const note = {
    id: "rmg_1",
    agentID: agent.id,
    kind: "report",
    source: "report:occ1",
    body: "Friday expenses increased in travel.",
    files: [{ name: "ledger.pdf", path: "receipts/Q3-close/ledger.pdf" }],
    time: 1,
  }
  emit({
    type: "routineState",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    agents: [agent],
    templates: [],
  })
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: note,
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  emit({ type: "routineState", requestID: request.requestID, viewID: request.viewID, refreshID: 1, refresh: "complete" })
  assert.match(root.textContent, /Friday expenses increased in travel/)
  assert.match(root.textContent, /1 unread/)
  assert.match(root.textContent, /Scheduled/)
  root.querySelector(".routines-identity").click()
  await new Promise((resolve) => setImmediate(resolve))
  const page = sent.findLast((msg) => msg.type === "routineInboxPage")
  assert.equal(page.agentID, agent.id)
  emit({
    type: "routineInboxPage",
    requestID: page.requestID,
    agentID: agent.id,
    messages: [note],
  })
  assert.match(root.textContent, /Report/)
  assert.match(root.textContent, /Does not change the assignment/)
  const card = root.querySelector('[aria-label="Open ledger.pdf"]')
  assert.equal(card.querySelector(".routines-file-name").textContent, "ledger.pdf")
  card.click()
  const opened = sent.findLast((msg) => msg.type === "openFile")
  assert.equal(opened.filePath, "receipts/Q3-close/ledger.pdf")
  const area = root.querySelector("textarea[aria-label='Message this worker']")
  area.focus()
  area.value = "Why did expenses increase?"
  area.dispatchEvent(new window.Event("input", { bubbles: true }))
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: { ...note, id: "rmg_2", body: "A later report arrived." },
        unread: 2,
        state: "scheduled",
      },
    ],
  })
  assert.equal(document.activeElement, area)
  assert.equal(area.value, "Why did expenses increase?")
  button("Send").click()
  const first = sent.findLast((msg) => msg.type === "routineInboxSend")
  assert.equal(first.body, "Why did expenses increase?")
  emit({
    type: "routineInboxSent",
    requestID: first.requestID,
    agentID: agent.id,
    error: "Could not save that follow-up.",
  })
  assert.match(root.textContent, /Could not save that follow-up/)
  button("Retry follow-up").click()
  const retry = sent.findLast((msg) => msg.type === "routineInboxSend")
  assert.equal(retry.source, first.source)
  assert.equal(retry.body, first.body)
  emit({
    type: "routineInboxSent",
    requestID: retry.requestID,
    agentID: agent.id,
    message: { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
  })
  assert.match(root.textContent, /You/)
  assert.equal(root.querySelector("textarea[aria-label='Message this worker']").value, "")
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: { id: "rmg_3", agentID: agent.id, kind: "report", source: "report:occ2", body: "The next Friday close found the travel receipts.", time: 3 },
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  const again = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: again.requestID,
    agentID: agent.id,
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
      {
        id: "rmg_3",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "The next Friday close found the travel receipts.",
        time: 3,
      },
    ],
  })
  assert.match(root.textContent, /Friday expenses increased in travel/)
  assert.match(root.textContent, /Why did expenses increase/)
  assert.match(root.textContent, /The next Friday close found the travel receipts/)
  assert.match(root.textContent, /Does not change the assignment/)
  const thread = root.querySelector(".routines-thread[role='region']")
  assert.equal(thread.getAttribute("aria-label"), "Conversation with Books")
  assert.equal(button("Back").getAttribute("aria-label"), "Back to Books")
  const pane = root.querySelector(".routines-thread-body")
  assert.equal(pane.getAttribute("role"), "log")
  assert.equal(pane.getAttribute("tabindex"), "0")
  assert.equal(pane.getAttribute("aria-label"), "Messages with Books")
  const draft = root.querySelector("textarea[aria-label='Message this worker']")
  draft.focus()
  draft.value = "Keep this draft"
  draft.dispatchEvent(new window.Event("input", { bubbles: true }))
  const legal = {
    id: "legal",
    name: "Counsel",
    role: "counsel",
    objective: "Review contracts",
    capabilities: ["legal"],
    schedule: { kind: "manual" },
    enabled: true,
    access: "brief",
  }
  const pages = sent.filter((msg) => msg.type === "routineInboxPage").length
  emit({
    type: "routineState",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    agents: [agent, legal],
    templates: [],
  })
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: {
          id: "rmg_3",
          agentID: agent.id,
          kind: "report",
          source: "report:occ2",
          body: "The next Friday close found the travel receipts.",
          time: 3,
        },
        unread: 1,
        state: "scheduled",
      },
      {
        agentID: legal.id,
        conversationID: "rcv_legal",
        name: legal.name,
        role: legal.role,
        latest: {
          id: "rmg_legal",
          agentID: legal.id,
          kind: "report",
          source: "report:legal1",
          body: "Counsel filed the motion.",
          time: 4,
        },
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    sent.filter((msg) => msg.type === "routineInboxPage").length,
    pages,
  )
  assert.equal(
    sent.filter((msg) => msg.type === "routineInboxPage" && msg.agentID === legal.id).length,
    0,
  )
  assert.match(root.textContent, /Counsel/)
  assert.equal(root.querySelector(".routines-thread[role='region']").getAttribute("aria-label"), "Conversation with Books")
  assert.equal(document.activeElement, draft)
  assert.equal(draft.value, "Keep this draft")
  assert.doesNotMatch(thread.textContent, /Counsel filed the motion/)
  let top = 40
  Object.defineProperties(pane, {
    scrollHeight: { configurable: true, get: () => 800 },
    clientHeight: { configurable: true, get: () => 200 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => {
        top = value
      },
    },
  })
  pane.dispatchEvent(new window.Event("scroll"))
  emit({
    type: "routineInbox",
    requestID: request.requestID,
    viewID: request.viewID,
    refreshID: 1,
    items: [
      {
        agentID: agent.id,
        conversationID: "rcv_1",
        name: agent.name,
        role: agent.role,
        latest: {
          id: "rmg_4",
          agentID: agent.id,
          kind: "report",
          source: "report:occ3",
          body: "The later receipt stayed in place.",
          time: 5,
        },
        unread: 2,
        state: "scheduled",
      },
      {
        agentID: legal.id,
        conversationID: "rcv_legal",
        name: legal.name,
        role: legal.role,
        latest: {
          id: "rmg_legal",
          agentID: legal.id,
          kind: "report",
          source: "report:legal1",
          body: "Counsel filed the motion.",
          time: 4,
        },
        unread: 1,
        state: "scheduled",
      },
    ],
  })
  await new Promise((resolve) => setImmediate(resolve))
  const later = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: later.requestID,
    agentID: agent.id,
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
      {
        id: "rmg_3",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "The next Friday close found the travel receipts.",
        time: 3,
      },
      {
        id: "rmg_4",
        agentID: agent.id,
        kind: "report",
        source: "report:occ3",
        body: "The later receipt stayed in place.",
        time: 5,
      },
    ],
  })
  await Promise.resolve()
  assert.equal(pane.scrollTop, 40)
  assert.match(root.textContent, /The later receipt stayed in place/)
  button("Back").click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(root.querySelector(".routines-thread[role='region']"), null)
  assert.equal(document.activeElement, root.querySelector('[data-routine-worker="routine"]'))
  const saved = sent.findLast((msg) => msg.type === "routineInboxDraft")
  assert.equal(saved.agentID, agent.id)
  assert.equal(saved.draft, "Keep this draft")
  root.querySelector('[data-routine-worker="routine"]').click()
  await new Promise((resolve) => setImmediate(resolve))
  const reopen = sent.findLast((msg) => msg.type === "routineInboxPage")
  emit({
    type: "routineInboxPage",
    requestID: reopen.requestID,
    agentID: agent.id,
    messages: [
      note,
      { id: "rmg_user", agentID: agent.id, kind: "user", source: retry.source, body: retry.body, time: 2 },
      {
        id: "rmg_3",
        agentID: agent.id,
        kind: "report",
        source: "report:occ2",
        body: "The next Friday close found the travel receipts.",
        time: 3,
      },
      {
        id: "rmg_4",
        agentID: agent.id,
        kind: "report",
        source: "report:occ3",
        body: "The later receipt stayed in place.",
        time: 5,
      },
    ],
  })
  const open = root.querySelector(".routines-thread[role='region']")
  assert.equal(open.getAttribute("aria-label"), "Conversation with Books")
  open.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(root.querySelector(".routines-thread[role='region']"), null)
  assert.equal(document.activeElement, root.querySelector('[data-routine-worker="routine"]'))
  console.log("routine-inbox-view: conversation return and report arrival assertions passed")
} finally {
  dispose()
  root.remove()
  window.happyDOM.abort()
}
