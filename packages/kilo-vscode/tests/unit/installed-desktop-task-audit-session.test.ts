import { describe, expect, test } from "bun:test"
import {
  beginTaskAudit,
  endTaskAudit,
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

describe("installed Desktop task audit boundary", () => {
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
