import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import App from "../../webview-ui/src/App"
import { render } from "solid-js/web"

const id = "session-routine"
const directory = "C:\\routine-conversation-fixture"
const messages = []
const emit = (data) => window.dispatchEvent(new MessageEvent("message", { data }))
const row = {
  id,
  directory,
  projectID: "project",
  parentID: null,
  title: "Original Routine conversation",
  createdAt: "2026-10-19T12:00:00Z",
  updatedAt: "2026-10-19T12:00:01Z",
}
const agent = {
  id: "worker",
  name: "Conversation worker",
  role: "reviewer",
  objective: "Review original conversation",
  capabilities: [],
  enabled: false,
  schedule: { kind: "manual" },
  scheduleVersion: 1,
}
const run = {
  id: "run-original",
  agentID: agent.id,
  sessionID: id,
  at: Date.parse(row.createdAt),
  status: "blocked",
  outcome: { kind: "notify", summary: "Original saved report" },
}
let held
let opened = []
const profile = crypto.randomUUID()
let updates = Promise.resolve()
let pending
const catalog = async (mode = "valid") => {
  await updates
  const response = await fetch("/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode, profile, directory }),
  })
  if (!response.ok) throw new Error("Catalog fixture failed")
  if (response.status === 204) return
  emit(await response.json())
}
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage(message) {
    messages.push(message)
    document.body.dataset.posts = JSON.stringify(messages)
    if (message.type === "sidebar.openSessions") {
      opened = message.sessionIDs
      document.body.dataset.opened = JSON.stringify(opened)
      const ids = [...opened]
      updates = updates.then(async () => {
        const response = await fetch("/opened", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ profile, opened: ids }),
        })
        if (!response.ok) throw new Error("Open conversation fixture failed")
      })
    }
    if (message.type === "webviewReady")
      queueMicrotask(() => emit({ type: "ready", serverInfo: { version: "fixture" }, workspaceDirectory: directory }))
    if (message.type === "requestWorkStyle") queueMicrotask(() => emit({ type: "workStyleLoaded", style: "skipped" }))
    if (message.type === "loadSessions") void catalog()
    if (message.type === "loadMessages" && message.sessionID === id) {
      held = message
      document.body.dataset.held = id
    }
    if (message.type === "routineList")
      queueMicrotask(() => {
        emit({ type: "routineState", requestID: message.requestID, agents: [agent], templates: [] })
        emit({ type: "routineRuns", agentID: agent.id, runs: [run] })
      })
    if (message.type === "routineHistory")
      queueMicrotask(() => emit({ type: "routineRuns", agentID: agent.id, runs: [run] }))
    if (message.type === "routineSnapshot")
      queueMicrotask(() =>
        emit({
          ...message,
          snapshot: {
            version: 1,
            agentID: agent.id,
            runID: run.id,
            at: run.at,
            objective: agent.objective,
            definition: agent,
          },
        }),
      )
  },
})
window.conversation = {
  refresh: catalog,
  async hold() {
    pending = catalog("held")
    const response = await fetch(`/held?profile=${profile}`)
    if (!response.ok) throw new Error("Held catalog fixture failed")
  },
  async finish() {
    await updates
    const response = await fetch(`/release?profile=${profile}`, { method: "POST" })
    if (!response.ok) throw new Error("Catalog release fixture failed")
    await pending
  },
  release() {
    if (!held) throw new Error("Original messages request was not held")
    emit({ type: "sessionUpdated", session: row })
    emit({
      type: "messagesLoaded",
      sessionID: id,
      mode: "replace",
      messages: [
        {
          id: "message-user",
          sessionID: id,
          role: "user",
          createdAt: row.createdAt,
          time: { created: Date.parse(row.createdAt) },
          parts: [
            {
              id: "part-user",
              type: "text",
              sessionID: id,
              messageID: "message-user",
              text: "Original saved question",
            },
          ],
        },
        {
          id: "message-assistant",
          sessionID: id,
          parentID: "message-user",
          role: "assistant",
          createdAt: row.updatedAt,
          time: { created: Date.parse(row.updatedAt), completed: Date.parse(row.updatedAt) },
          finish: "stop",
          parts: [
            {
              id: "part-assistant",
              type: "text",
              sessionID: id,
              messageID: "message-assistant",
              text: "Original saved answer — café 日本語.",
            },
          ],
        },
      ],
    })
  },
  remove() {
    emit({ type: "sessionDeleted", sessionID: id })
  },
  directory() {
    emit({ type: "workspaceDirectoryChanged", directory: "C:\\different-fixture" })
  },
}
render(() => <App />, document.getElementById("root"))
