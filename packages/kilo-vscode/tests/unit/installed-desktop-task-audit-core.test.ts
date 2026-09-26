import { describe, expect, it } from "bun:test"
import {
  taskAuditDelta,
  taskEventDelta,
  validTaskEvidence,
  type TaskActionEvent,
  type TaskAuditEntry,
  type TaskAuditSnapshot,
  type TaskEvidenceSnapshot,
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

const session = "c".repeat(64)
const prior: TaskActionEvent = {
  ...old,
  sessionHash: "d".repeat(64),
  phase: "post_dispatch",
}
const native: TaskActionEvent = { ...next, sessionHash: session, phase: "post_dispatch" }
const refused: TaskActionEvent = {
  hash: "e".repeat(64),
  sessionHash: session,
  effect: "interact",
  phase: "pre_dispatch",
  outcome: "refused",
  startedAt: 104,
  finishedAt: 105,
}

function evidence(
  revision: number,
  audit: TaskAuditEntry[] = [old],
  events: TaskActionEvent[] = [prior],
): TaskEvidenceSnapshot {
  return { epoch: "epoch-1", revision, audit, events, sessionHash: session }
}

describe("installed desktop task event delta", () => {
  it("returns only new, correlated native events and receipts", () => {
    expect(taskEventDelta(evidence(4), evidence(5, [old, next], [prior, native]))).toEqual({
      status: "available",
      format: "raya.installed-desktop-task-events",
      version: 2,
      epoch: "epoch-1",
      beforeRevision: 4,
      afterRevision: 5,
      audit: [next],
      events: [native],
      releaseGateEligible: false,
    })
  })

  it("accepts a denied or cancelled pre-dispatch decision without inventing a native receipt", () => {
    const denied = taskEventDelta(evidence(4), evidence(5, [old], [prior, refused]))
    expect(denied.status).toBe("available")
    if (denied.status === "available") {
      expect(denied.audit).toEqual([])
      expect(denied.events).toEqual([refused])
      expect(denied.releaseGateEligible).toBe(false)
    }
    expect(taskEventDelta(evidence(4), evidence(5, [old], [prior, { ...refused, outcome: "cancelled" }])).status).toBe(
      "available",
    )
  })

  it("rejects foreign sessions and invalid phase/outcome pairs", () => {
    expect(
      taskEventDelta(evidence(4), { ...evidence(5, [old, next], [prior, native]), sessionHash: "f".repeat(64) }).status,
    ).toBe("unavailable")
    expect(
      taskEventDelta(evidence(4), evidence(5, [old, next], [prior, { ...native, sessionHash: "f".repeat(64) }])).status,
    ).toBe("unavailable")
    expect(taskEventDelta(evidence(4), evidence(5, [old], [prior, { ...refused, outcome: "confirmed" }])).status).toBe(
      "unavailable",
    )
    expect(
      taskEventDelta(evidence(4), evidence(5, [old], [prior, { ...refused, phase: "post_dispatch" }])).status,
    ).toBe("unavailable")
  })

  it("requires one matching native receipt for every new post-dispatch event", () => {
    expect(taskEventDelta(evidence(4), evidence(5, [old], [prior, native])).status).toBe("unavailable")
    expect(
      taskEventDelta(evidence(4), evidence(5, [old, { ...next, outcome: "confirmed" }], [prior, native])).status,
    ).toBe("unavailable")
    expect(taskEventDelta(evidence(4), evidence(5, [old, next], [prior, { ...native, finishedAt: 105 }])).status).toBe(
      "unavailable",
    )
    expect(taskEventDelta(evidence(4), evidence(5, [old, next], [prior, refused])).status).toBe("unavailable")
    expect(
      taskEventDelta(evidence(4), evidence(5, [old, { ...next, hash: refused.hash }], [prior, refused])).status,
    ).toBe("unavailable")
  })

  it("rejects changed prior rows, journal epochs, and non-advancing revisions", () => {
    expect(taskEventDelta(evidence(4), evidence(5, [next], [prior, native])).status).toBe("unavailable")
    expect(taskEventDelta(evidence(4), evidence(5, [old, next], [{ ...prior, finishedAt: 108 }, native])).status).toBe(
      "unavailable",
    )
    expect(taskEventDelta(evidence(4), evidence(5, [old, next], [native])).status).toBe("unavailable")
    expect(taskEventDelta(evidence(4), { ...evidence(5, [old, next], [prior, native]), epoch: "new" }).status).toBe(
      "unavailable",
    )
    expect(taskEventDelta(evidence(4), evidence(4, [old, next], [prior, native])).status).toBe("unavailable")
    expect(taskEventDelta(evidence(4), evidence(3, [old, next], [prior, native])).status).toBe("unavailable")
  })

  it("rejects full rings, duplicate hashes, and leaked private fields", () => {
    const full = Array.from({ length: 256 }, (_, index) => ({ ...old, hash: index.toString(16).padStart(64, "0") }))
    expect(validTaskEvidence(evidence(5, full, [prior]))).toBe(false)
    expect(validTaskEvidence(evidence(5, [old], Array(256).fill(prior)))).toBe(false)
    expect(validTaskEvidence(evidence(5, [old, old], [prior]))).toBe(false)
    expect(validTaskEvidence(evidence(5, [old], [prior, prior]))).toBe(false)
    expect(validTaskEvidence(evidence(5, [{ ...old, hash: "A".repeat(64) }], [prior]))).toBe(false)
    expect(validTaskEvidence(evidence(5, [old], [{ ...prior, sessionHash: "D".repeat(64) }]))).toBe(false)
    expect(validTaskEvidence({ ...evidence(5), frame: "private pixels" })).toBe(false)
    expect(validTaskEvidence(evidence(5, [Object.assign({}, old, { typedText: "secret" })], [prior]))).toBe(false)
    expect(validTaskEvidence(evidence(5, [old], [Object.assign({}, prior, { clipboard: "secret" })]))).toBe(false)
    expect(taskEventDelta(evidence(4), evidence(5, full, [prior, native])).status).toBe("unavailable")
  })

  it("does not turn an acknowledgement with no new event into action evidence", () => {
    expect(taskEventDelta(evidence(4), evidence(5)).status).toBe("unavailable")
  })
})
