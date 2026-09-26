import { describe, expect, test } from "bun:test"
import {
  beginTaskAudit,
  beginTaskEvidence,
  endTaskAudit,
  endTaskEvidence,
  type TaskAuditIdentity,
} from "../../src/commands/installed-desktop-task-audit-session"

const identity: TaskAuditIdentity = {
  version: "7.4.23-snapshot+abc",
  digest: "a".repeat(64),
  captureSha256: "b".repeat(64),
  backend: { pid: 41, startedAt: 1234, port: 4200, generation: 1 },
  lease: { grantHash: "c".repeat(64), level: "autonomous", state: "active" },
  desktop: { host: "desktop-1", input: "desktop-1" },
}

const old = {
  hash: "d".repeat(64),
  effect: "interact" as const,
  outcome: "confirmed" as const,
  startedAt: 10,
  finishedAt: 11,
}
const next = {
  hash: "e".repeat(64),
  effect: "manage" as const,
  outcome: "unknown" as const,
  startedAt: 12,
  finishedAt: 13,
}
const before = { epoch: "epoch-1", revision: 4, entries: [old] }
const after = { epoch: "epoch-1", revision: 5, entries: [old, next] }
const sessionHash = "a".repeat(64)
const evidence = { epoch: "epoch-1", revision: 4, sessionHash, audit: [old], events: [] }
const event = {
  hash: next.hash,
  sessionHash,
  effect: next.effect,
  phase: "post_dispatch" as const,
  outcome: next.outcome,
  startedAt: next.startedAt,
  finishedAt: next.finishedAt,
}

describe("installed Desktop task audit boundary", () => {
  test("binds version 2 action evidence to the exact host and hashed session", () => {
    const started = beginTaskEvidence("run-12345", "dialog-handling", identity, evidence)
    expect(started.status).toBe("ready")
    if (started.status !== "ready") return
    const restored = JSON.parse(JSON.stringify(started.boundary)) as typeof started.boundary
    const result = endTaskEvidence(restored, "run-12345", identity, {
      ...evidence,
      revision: 5,
      audit: [old, next],
      events: [event],
    })
    expect(result).toMatchObject({
      status: "available",
      version: 2,
      evidence: { audit: [next], events: [event], releaseGateEligible: false },
      releaseGateEligible: false,
    })
    expect(JSON.stringify(result)).not.toContain("ses_private")
    expect(endTaskEvidence(restored, "other-run", identity, { ...evidence, revision: 5 }).status).toBe("unavailable")
    expect(
      endTaskEvidence(
        restored,
        "run-12345",
        { ...identity, backend: { ...identity.backend, pid: 42 } },
        {
          ...evidence,
          revision: 5,
        },
      ).status,
    ).toBe("unavailable")
  })

  test("opens version 3 for a settled native journal and preserves the run boundary", () => {
    const broker = {
      ...evidence,
      native: [] as {
        hash: string
        sessionHash: string
        requestHash: string
        sequence: number
        phase: "settled"
        startedAt: number
        finishedAt: number
        outcome: "confirmed"
        code: string
        accepted: number
        attempted: number
      }[],
      legacy: false,
      nativeGeneration: 0,
    }
    const started = beginTaskEvidence("run-12345", "dialog-handling", identity, broker)
    expect(started.status).toBe("ready")
    if (started.status !== "ready") return
    expect(started.boundary.version).toBe(3)
    const row = {
      hash: "f".repeat(64),
      sessionHash,
      requestHash: next.hash,
      sequence: 0,
      phase: "settled" as const,
      startedAt: 12,
      finishedAt: 13,
      outcome: "confirmed" as const,
      code: "ok",
      accepted: 1,
      attempted: 1,
    }
    const restored = JSON.parse(JSON.stringify(started.boundary)) as typeof started.boundary
    const result = endTaskEvidence(restored, "run-12345", identity, {
      ...broker,
      revision: 5,
      audit: [old, { ...next, outcome: "confirmed" }],
      events: [{ ...event, outcome: "confirmed" }],
      native: [row],
    })
    expect(result).toMatchObject({
      status: "available",
      version: 3,
      evidence: { native: [row] },
      releaseGateEligible: false,
    })
    expect(endTaskEvidence(restored, "other-run", identity, broker).status).toBe("unavailable")
    expect(
      endTaskEvidence(restored, "run-12345", { ...identity, backend: { ...identity.backend, pid: 42 } }, broker).status,
    ).toBe("unavailable")
    expect(beginTaskEvidence("run-12345", "dialog-handling", identity, { ...broker, legacy: true }).status).toBe(
      "ready",
    )
    expect(
      beginTaskEvidence("run-12345", "dialog-handling", identity, { ...broker, nativeTruncated: true }).status,
    ).toBe("unavailable")
  })

  test("does not upgrade a legacy task marker into version 2 evidence", () => {
    const oldRun = beginTaskAudit("run-12345", "dialog-handling", identity, before)
    if (oldRun.status !== "ready") throw new Error("Expected a legacy boundary")
    expect(endTaskEvidence(oldRun.boundary, "run-12345", identity, evidence)).toMatchObject({
      status: "unavailable",
      releaseGateEligible: false,
    })
    const privateEvidence = { ...evidence, sessionID: "ses_private" }
    expect(beginTaskEvidence("run-12345", "dialog-handling", identity, privateEvidence).status).toBe("unavailable")
  })

  test("binds a redacted durable delta to one run but never claims release eligibility", () => {
    const started = beginTaskAudit("run-12345", "dialog-handling", identity, before)
    expect(started.status).toBe("ready")
    if (started.status !== "ready") return
    const restored = JSON.parse(JSON.stringify(started.boundary)) as typeof started.boundary
    expect(endTaskAudit(restored, "run-12345", identity, after)).toMatchObject({
      status: "available",
      runId: "run-12345",
      scenario: "dialog-handling",
      audit: { entries: [next], releaseGateEligible: false },
      releaseGateEligible: false,
    })
  })

  test("refuses changed backend, lease, package, input desktop and run", () => {
    const started = beginTaskAudit("run-12345", "dialog-handling", identity, before)
    if (started.status !== "ready") throw new Error("Expected a task boundary")
    const changed = [
      { ...identity, backend: { ...identity.backend, generation: 2 } },
      { ...identity, lease: { ...identity.lease, grantHash: "f".repeat(64) } },
      { ...identity, digest: "f".repeat(64) },
      { ...identity, desktop: { host: "desktop-2", input: "desktop-2" } },
    ]
    for (const item of changed)
      expect(endTaskAudit(started.boundary, "run-12345", item, after).status).toBe("unavailable")
    expect(endTaskAudit(started.boundary, "another-run", identity, after).status).toBe("unavailable")
  })

  test("refuses an invalid host and a journal without new native effects", () => {
    expect(
      beginTaskAudit("run-12345", "dialog-handling", { ...identity, desktop: { host: "a", input: "b" } }, before)
        .status,
    ).toBe("unavailable")
    const started = beginTaskAudit("run-12345", "dialog-handling", identity, before)
    if (started.status !== "ready") throw new Error("Expected a task boundary")
    expect(endTaskAudit(started.boundary, "run-12345", identity, { ...before, revision: 5 }).status).toBe("unavailable")
    expect(endTaskAudit(started.boundary, "run-12345", identity, { ...after, epoch: "other" }).status).toBe(
      "unavailable",
    )
  })
})
