import assert from "node:assert/strict"
import { createRoot, createSignal } from "solid-js"
import { reports } from "../../webview-ui/src/components/chat/routine-reports.ts"

const [session, setSession] = createSignal("origin")
const [directory, setDirectory] = createSignal("/original")
const [connected, setConnected] = createSignal(true)
const requests = []
let listener
let synchronous = true
let stopped = false
const card = (session, patch = {}) => ({
  version: 1,
  id: "original-occurrence",
  agentID: "original-routine",
  name: "Original routine",
  reportSessionID: session,
  directory: directory(),
  projectID: "original-project",
  revision: 1,
  status: "queued",
  delivery: "delivered",
  at: 1700000000000,
  summary: "Original persisted wait",
  ...patch,
})
const reply = (request, values) => listener({ ...request, type: "agentReportsLoaded", ...values })
const state = createRoot((dispose) => ({
  dispose,
  view: reports({
    session,
    directory,
    connected,
    listen(handler) {
      listener = handler
      return () => {
        stopped = true
        listener = undefined
      }
    },
    post(request) {
      assert.equal(typeof listener, "function", "Subscribe before the first request")
      requests.push(request)
      if (synchronous) reply(request, { items: [card(request.sessionID)] })
    },
  }),
}))
try {
  assert.equal(requests.length, 1)
  assert.equal(state.view.loading(), false)
  assert.equal(state.view.items()[0].reportSessionID, "origin")
  synchronous = false
  const first = requests.at(-1)
  state.view.refresh()
  const refreshed = requests.at(-1)
  assert.notEqual(refreshed.requestID, first.requestID)
  assert.equal(state.view.loading(), true)
  reply(first, { items: [card("origin", { summary: "Stale response" })] })
  assert.equal(state.view.items()[0].summary, "Original persisted wait")
  reply(refreshed, { error: "Backend unavailable" })
  assert.equal(state.view.loading(), false)
  assert.equal(state.view.error(), "Backend unavailable")
  assert.equal(state.view.items()[0].summary, "Original persisted wait")
  reply(refreshed, { items: [card("origin", { status: "running", revision: 2, summary: "Working" })] })
  assert.equal(state.view.items().length, 1)
  assert.equal(state.view.items()[0].status, "running")
  assert.equal(state.view.error(), undefined)
  setSession("destination")
  const destination = requests.at(-1)
  assert.notEqual(destination.requestID, refreshed.requestID)
  assert.deepEqual(state.view.items(), [])
  reply(refreshed, { items: [card("origin", { status: "complete" })] })
  assert.deepEqual(state.view.items(), [])
  reply(destination, { items: [card("destination")] })
  assert.equal(state.view.items()[0].reportSessionID, "destination")
  setDirectory("/other-workspace")
  const workspace = requests.at(-1)
  assert.notEqual(workspace.requestID, destination.requestID)
  assert.deepEqual(state.view.items(), [])
  reply(destination, { items: [card("destination")] })
  assert.deepEqual(state.view.items(), [])
  reply(workspace, { items: [card("wrong-destination")] })
  assert.deepEqual(state.view.items(), [])
  assert.match(state.view.error(), /could not be verified/)
  reply(workspace, { items: [card("destination"), card("destination")] })
  assert.deepEqual(state.view.items(), [])
  reply(workspace, { items: [card("destination", { summary: "Retained current report" })] })
  assert.equal(state.view.items().length, 1)
  setConnected(false)
  assert.deepEqual(state.view.items(), [])
  assert.equal(state.view.loading(), false)
  const count = requests.length
  state.view.refresh()
  assert.equal(requests.length, count)
  reply(workspace, { items: [card("destination")] })
  assert.deepEqual(state.view.items(), [])
  setConnected(true)
  const reopened = requests.at(-1)
  assert.notEqual(reopened.requestID, workspace.requestID)
  reply(reopened, { items: [card("destination", { status: "complete", revision: 3, summary: "Final report" })] })
  assert.equal(state.view.items()[0].summary, "Final report")
} finally {
  state.dispose()
}
assert.equal(stopped, true)
const count = requests.length
state.view.refresh()
assert.equal(requests.length, count)
