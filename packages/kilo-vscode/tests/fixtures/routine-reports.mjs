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
  reply(reopened, { items: [card("destination", { status: "stopped", revision: 4, summary: "Stopped by you." })] })
  assert.equal(state.view.items()[0].status, "stopped", "Retain the explicit terminal status from the backend")
  assert.equal(state.view.error(), undefined)
  reply(reopened, { items: [card("destination", { status: "error", revision: 5, summary: "Stopped by you." })] })
  assert.equal(
    state.view.items()[0].status,
    "error",
    "A summary cannot upgrade a historical failure into a verified stop",
  )
  const rows = Array.from({ length: 200 }, (_, index) => card("destination", { id: `report-${index}` }))
  reply(reopened, { items: [...rows, card("destination", { id: "overflow" })] })
  assert.equal(state.view.items()[0].summary, "Stopped by you.", "An oversized page cannot replace valid history")
  reply(reopened, { items: rows, next: "opaque-next", bootstrap: { complete: false, scanned: 200, total: 501 } })
  assert.equal(state.view.items().length, 200)
  assert.equal(state.view.next(), "opaque-next")
  assert.equal(state.view.historical(), false)
  state.view.older()
  const older = requests.at(-1)
  assert.equal(older.cursor, "opaque-next")
  reply(reopened, { items: [card("destination", { summary: "Late latest SSE" })] })
  assert.equal(state.view.items().length, 200)
  reply(older, { error: "Older read failed" })
  assert.equal(state.view.items().length, 200)
  assert.equal(state.view.next(), "opaque-next")
  assert.deepEqual(state.view.bootstrap(), { complete: false, scanned: 200, total: 501 })
  assert.equal(state.view.historical(), false, "A failed page must not relabel retained latest reports")
  state.view.retry()
  const retry = requests.at(-1)
  assert.equal(retry.cursor, older.cursor)
  assert.notEqual(retry.requestID, older.requestID)
  reply(retry, { items: [card("destination", { id: "old-report", summary: "Older report" })], next: "older-next" })
  assert.equal(state.view.items().length, 1, "Pages replace rather than accumulate")
  assert.equal(state.view.historical(), true)
  reply({ ...retry, cursor: undefined }, { items: [card("destination", { summary: "Wrong cursor" })] })
  assert.equal(state.view.items()[0].summary, "Older report")
  state.view.resume()
  const resumed = requests.at(-1)
  assert.equal(resumed.cursor, retry.cursor, "Continuation rereads the displayed page")
  reply(resumed, { items: [card("destination", { id: "old-report", summary: "Retained older report" })] })
  state.view.refresh()
  const latest = requests.at(-1)
  assert.equal(latest.cursor, undefined, "Refresh returns to latest")
  reply(resumed, { items: [card("destination", { summary: "Late historical page" })] })
  assert.equal(state.view.items()[0].summary, "Retained older report")
  reply(latest, { items: [], bootstrap: { complete: false, scanned: 400, total: 501 } })
  assert.equal(state.view.historical(), false)
  assert.deepEqual(state.view.items(), [])
  assert.deepEqual(state.view.bootstrap(), { complete: false, scanned: 400, total: 501 })
  setConnected(false)
  assert.equal(state.view.next(), undefined)
  assert.equal(state.view.bootstrap(), undefined)
} finally {
  state.dispose()
}
assert.equal(stopped, true)
const count = requests.length
state.view.refresh()
assert.equal(requests.length, count)
