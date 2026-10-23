import "@kilocode/kilo-ui/styles"
import "../../webview-ui/src/styles/eden.css"
import "../../webview-ui/src/styles/chat.css"
import { beginPendingSend, finishPendingSend } from "../../webview-ui/src/utils/draft-store"
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
// External restored-content wire only: the actual App, LocalTabs and PromptInput own discovery and hydration.
const draftBox = new URLSearchParams(location.search).get("draftBox")
const same = new URLSearchParams(location.search).has("sameMode")
const draftID = "sidebar-pending:restored-original"
const draft = draftBox
  ? {
      identity: {
        workspace: directory,
        projectID: "project",
        box: draftBox,
        key: `${draftBox}:pending:${draftID}`,
        pendingID: draftID,
      },
      token: { generation: crypto.randomUUID(), revision: 1 },
      content: {
        text: "  Restored unsent draft — café 日本語.  ",
        comments: [],
        images: [],
        scroll: 0,
        selection: { start: 0, end: 0 },
        agent: "auto",
      },
      mutation: "original-unsent",
      digest: "",
    }
  : undefined
const entries =
  draftBox === "collision"
    ? ["sidebar:new-task", "sidebar:fallback"].map((box, index) => ({
        ...structuredClone(draft),
        identity: { ...draft.identity, box, key: `${box}:pending:${draftID}` },
        content: {
          ...draft.content,
          text: index ? "  Fallback draft — 二番 😀.  " : "  Primary draft — 一番 café.  ",
          agent: index && !same ? "plan" : "auto",
          model: { providerID: "local", modelID: index ? "second" : "first" },
          variant: index ? "high" : "low",
        },
      }))
    : draft
      ? [draft]
      : []
const digest = Promise.all(
  entries.map(async (entry) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(entry.content)))
    entry.digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }),
)
window.restoredDraft = {
  entry: draft,
  entries,
  messages,
  hold: () => beginPendingSend(draftID),
  release: () => finishPendingSend(draftID),
}
const composers = (message) => {
  if (!draft) return false
  if (message.type === "composerDraftPane") {
    if (message.active)
      queueMicrotask(() =>
        emit({
          type: "composerDraftState",
          epoch: message.epoch,
          generation: 1,
          connected: true,
          owners: [
            { box: "sidebar:new-task", owner: profile },
            { box: "sidebar:fallback", owner: profile },
          ],
        }),
      )
    return true
  }
  if (
    ![
      "composerDraftList",
      "composerDraftLoad",
      "composerDraftSave",
      "composerDraftClear",
      "composerDraftPromote",
    ].includes(message.type)
  )
    return false
  void digest.then(() => {
    const base = {
      type: "composerDraftResult",
      operation: message.type,
      requestID: message.requestID,
      epoch: message.epoch,
      generation: message.generation,
      owner: message.owner,
    }
    if (message.type === "composerDraftList")
      return emit({
        ...base,
        entries: entries.filter((entry) => entry.identity.box === message.box).map((entry) => structuredClone(entry)),
      })
    if (message.type === "composerDraftLoad") {
      const selected = entries.find(
        (entry) =>
          message.identity.box === entry.identity.box &&
          message.identity.key === entry.identity.key &&
          message.identity.pendingID === entry.identity.pendingID,
      )
      return emit({ ...base, entry: selected ? structuredClone(selected) : null })
    }
    if (message.type === "composerDraftClear") {
      const selected = entries.find(
        (entry) =>
          message.identity.box === entry.identity.box &&
          message.identity.key === entry.identity.key &&
          message.identity.pendingID === entry.identity.pendingID,
      )
      if (!selected || JSON.stringify(message.expected) !== JSON.stringify(selected.token))
        return emit({ ...base, error: "conflict" })
      selected.content = null
      selected.token = { ...selected.token, revision: selected.token.revision + 1 }
      selected.mutation = message.mutation
      void crypto.subtle.digest("SHA-256", new TextEncoder().encode("null")).then((hash) => {
        selected.digest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
        emit({ ...base, entry: structuredClone(selected) })
      })
      return
    }
    emit({ ...base, error: "unavailable" })
  })
  return true
}
window.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage(message) {
    messages.push(message)
    document.body.dataset.posts = JSON.stringify(messages)
    if (composers(message)) return
    if (draftBox === "collision" && message.type === "requestAgents")
      queueMicrotask(() =>
        emit({
          type: "agentsLoaded",
          agents: [
            { name: "auto", displayName: "General", mode: "primary" },
            { name: "plan", displayName: "Ask", mode: "primary" },
          ],
          allAgents: [],
          defaultAgent: "auto",
        }),
      )
    if (draftBox === "collision" && message.type === "requestProviders")
      queueMicrotask(() =>
        emit({
          type: "providersLoaded",
          generation: 0,
          providers: {
            local: {
              id: "local",
              name: "Local",
              env: [],
              models: Object.fromEntries(
                ["first", "second"].map((id) => [
                  id,
                  {
                    id,
                    name: `Original ${id} model`,
                    limit: { context: 8192, output: 2048 },
                    variants: { low: {}, high: {} },
                  },
                ]),
              ),
            },
          },
          connected: ["local"],
          defaults: { local: "first" },
          defaultSelection: { providerID: "local", modelID: "first" },
          authMethods: {},
          authStates: {},
        }),
      )
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
