import { describe, expect, it } from "bun:test"
import {
  taskAuditDelta,
  type TaskAuditEntry,
  type TaskAuditSnapshot,
} from "../../src/commands/installed-desktop-task-audit-core"

const old: TaskAuditEntry = {
  hash: "a".repeat(64),
  effect: "manage",
  outcome: "confirmed",
  startedAt: 100,
  finishedAt: 101,
}
const next: TaskAuditEntry = {
  hash: "b".repeat(64),
  effect: "interact",
  outcome: "unknown",
  startedAt: 102,
  finishedAt: 103,
}

function snapshot(revision: number, entries: TaskAuditEntry[] = [old]): TaskAuditSnapshot {
  return { epoch: "epoch-1", revision, entries }
}

describe("installed desktop task audit delta", () => {
  it("returns only newly durable redacted receipts", () => {
    expect(taskAuditDelta(snapshot(4), snapshot(5, [old, next]))).toEqual({
      status: "available",
      format: "raya.installed-desktop-task-audit",
      version: 1,
      epoch: "epoch-1",
      beforeRevision: 4,
      afterRevision: 5,
      entries: [next],
      releaseGateEligible: false,
    })
  })

  it("rejects changed epochs and revisions that did not advance", () => {
    expect(taskAuditDelta(snapshot(4), { ...snapshot(5, [old, next]), epoch: "epoch-2" }).status).toBe("unavailable")
    expect(taskAuditDelta(snapshot(4), snapshot(4, [old, next])).status).toBe("unavailable")
    expect(taskAuditDelta(snapshot(4), snapshot(3, [old, next])).status).toBe("unavailable")
  })

  it("rejects missing, changed, and duplicated prior receipts", () => {
    expect(taskAuditDelta(snapshot(4), snapshot(5, [next])).status).toBe("unavailable")
    expect(taskAuditDelta(snapshot(4), snapshot(5, [{ ...old, outcome: "unknown" }, next])).status).toBe("unavailable")
    expect(taskAuditDelta(snapshot(4), snapshot(5, [old, old, next])).status).toBe("unavailable")
  })

  it("rejects capacity and malformed entries before attempting a delta", () => {
    const full = Array.from({ length: 256 }, (_, index) => ({ ...old, hash: index.toString(16).padStart(64, "0") }))
    expect(taskAuditDelta(snapshot(4), snapshot(5, full)).status).toBe("unavailable")
    expect(taskAuditDelta(snapshot(4, full), snapshot(5, [...full.slice(1), next])).status).toBe("unavailable")
    expect(taskAuditDelta(snapshot(4), snapshot(5, [old, { ...next, hash: "raw request" }])).status).toBe("unavailable")
    expect(taskAuditDelta(snapshot(4), snapshot(5, [old, { ...next, finishedAt: 99 }])).status).toBe("unavailable")
    expect(
      taskAuditDelta(snapshot(4), snapshot(5, [old, Object.assign({}, next, { typedText: "secret" })])).status,
    ).toBe("unavailable")
  })

  it("does not treat a journal acknowledgement without a native effect as a task receipt", () => {
    expect(taskAuditDelta(snapshot(4), snapshot(5)).status).toBe("unavailable")
  })
})
