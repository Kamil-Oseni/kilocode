import { expect, test } from "bun:test"
import { waiting } from "../../webview-ui/src/components/routines/inference"
import type { Box } from "../../webview-ui/src/components/routines/Inbox"

test("routine waiting is transient, exactly bound, and loses to active work, Stop, input and recovery", () => {
  const run = { id: "run_current", sessionID: "ses_current", status: "running" }
  const box: Box = {
    agentID: "agt_current",
    conversationID: "rcv_current",
    name: "Researcher",
    role: "Researcher",
    unread: 0,
    state: "running",
    inference: {
      runID: run.id,
      snapshot: {
        version: 1,
        sessionID: run.sessionID,
        epoch: "10ff0000-0000-4000-8000-000000000000",
        observedAt: 20_000,
        requests: [{ messageID: "msg_primary", queued: 1, active: 0, since: 10_000 }],
      },
    },
  }
  const input = { box, run, connected: true, now: 25_000 }
  expect(waiting(input)).toBe(true)
  for (const change of [
    { connected: false },
    { stale: true },
    { recovery: true },
    { stopping: true },
    { now: 35_001 },
    { now: 19_999 },
    { run: { ...run, id: "run_other" } },
    { run: { ...run, sessionID: "ses_other" } },
    { run: { ...run, status: "complete" } },
  ])
    expect(waiting({ ...input, ...change })).toBe(false)
  for (const state of ["needs_input", "waiting", "failed", "paused", "scheduled"] as const)
    expect(waiting({ ...input, box: { ...box, state } })).toBe(false)
  if (!box.inference) throw new Error("Missing fixture snapshot")
  const snapshot = box.inference.snapshot
  const rows = (requests: typeof snapshot.requests) => ({
    ...box,
    inference: { runID: run.id, snapshot: { ...snapshot, requests } },
  })
  expect(
    waiting({ ...input, box: rows([...snapshot.requests, { messageID: "msg_active", queued: 0, active: 1 }]) }),
  ).toBe(false)
  expect(waiting({ ...input, box: rows([{ messageID: "msg_primary", queued: 1, active: 1, since: 10_000 }]) })).toBe(
    false,
  )
  expect(waiting({ ...input, box: rows([{ messageID: "msg_primary", queued: 1, active: 0 }]) })).toBe(false)
  expect(waiting({ ...input, box: rows([]) })).toBe(false)
  expect(waiting({ ...input, box: { ...box, inference: undefined } })).toBe(false)
  expect(box.inference.snapshot).toEqual(snapshot)
})
