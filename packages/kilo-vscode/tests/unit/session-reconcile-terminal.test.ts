import { expect, test } from "bun:test"
import { mergeMessages, sameReconcileShape } from "../../webview-ui/src/context/session-merge"
import { reconcileQueued } from "../../webview-ui/src/context/session-queue"
import type { Message } from "../../webview-ui/src/types/messages"

const user: Message = { id: "user", sessionID: "session", role: "user", createdAt: "2026-10-05T02:17:40Z" }
const reply: Message = {
  id: "reply",
  sessionID: "session",
  role: "assistant",
  parentID: user.id,
  createdAt: "2026-10-05T02:17:41Z",
  time: { created: 1791166661000 },
}

test("same-part snapshot applies parented terminal error metadata before reconciling the queue", () => {
  // Sanitized actual failed General turn: parented UnknownError, completed,
  // no finish. No transcript, file contents or provider error body is needed.
  const current = [user, reply]
  const incoming = [
    user,
    { ...reply, error: { name: "UnknownError" }, time: { created: 1791166661000, completed: 1791166668725 } },
  ]
  expect(reconcileQueued(current, [user.id])).toEqual([user.id])
  expect(sameReconcileShape(current, incoming, () => [])).toBe(false)
  const merged = mergeMessages(current, incoming, "reconcile")
  expect(reconcileQueued(merged, [user.id])).toEqual([])
})

test("same-part terminal stop heals only its exact parent and preserves a newer queued user", () => {
  const next = { ...user, id: "newer", createdAt: "2026-10-05T02:17:49Z" }
  const current = [user, reply, next]
  const incoming = [user, { ...reply, finish: "stop" }, next]
  expect(sameReconcileShape(current, incoming, () => [])).toBe(false)
  expect(reconcileQueued(mergeMessages(current, incoming, "reconcile"), [user.id, next.id])).toEqual([next.id])
})

test("completion time, parent identity and role changes cannot be skipped with equal parts", () => {
  for (const changed of [
    { ...reply, time: { ...reply.time!, completed: 1791166668725 } },
    { ...reply, parentID: "different-user" },
    { ...reply, role: "user" as const },
  ])
    expect(sameReconcileShape([reply], [changed], () => [])).toBe(false)
})

test("tool continuation and unfinished replies retain queued work after metadata reconciliation", () => {
  for (const finish of ["tool-calls", "unknown", undefined]) {
    const incoming = [user, { ...reply, finish, time: { ...reply.time!, completed: 1791166668725 } }]
    expect(reconcileQueued(mergeMessages([user, reply], incoming, "reconcile"), [user.id])).toEqual([user.id])
  }
})

test("identical terminal metadata and parts preserve the existing fast path", () => {
  const current = [user, { ...reply, finish: "stop", error: { name: "UnknownError", data: { message: "synthetic" } } }]
  const incoming = structuredClone(current)
  expect(sameReconcileShape(current, incoming, () => [])).toBe(true)
})
