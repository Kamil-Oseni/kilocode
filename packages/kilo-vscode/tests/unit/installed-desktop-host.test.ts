import { describe, expect, test } from "bun:test"
import {
  inspectInstalledHost,
  ObservationFailure,
  observeStage,
  type ObservationDiagnostic,
} from "../../src/commands/installed-desktop-host-core"

const version = "7.4.23-snapshot+abc.test.1"
const digest = "a".repeat(64)
const process = { pid: 123, startedAt: 1000, port: 41123, generation: 1 }
const lease = {
  grantHash: "b".repeat(64),
  level: "autonomous" as const,
  state: "active" as const,
  scopeCount: 2,
  expiresAt: null,
}
const frame = {
  before: { windowID: "0x10", location: "same", identity: "A".repeat(64) },
  after: { windowID: "0x10", location: "same", identity: "A".repeat(64) },
  window: { windowID: "0x10", location: "same" },
  width: 800,
  height: 600,
  timing: { acquisitionMs: 20, preparationMs: 8, semanticsMs: 7, totalMs: 35 },
  semantics: { status: "available", count: 4, truncated: false },
}

function input() {
  return {
    loadedVersion: version,
    loadedCaptureSha256: "c".repeat(64),
    active: { version, digest },
    expected: { version, digest },
    desktop: { host: "Default", input: "Default" },
    backend: () => "connected",
    process: () => process,
    lease: () => lease,
    journal: () => ({
      state: "durable" as const,
      summary: {
        epoch: "epoch-test",
        revision: 3,
        lastAckAt: null,
        pendingNative: { confirmed: 1, unknown: 2 },
        audit: { count: 4, confirmed: 3, unknown: 1 },
      },
    }),
    observe: async () => frame,
  }
}

describe("installed interactive host probe", () => {
  test("records bounded stage timing and distinguishes overall deadline from capture failure", async () => {
    for (const [message, expired, code] of [
      ["private clipboard secret", false, "failed"],
      ["Desktop semantic read timed out: private", false, "timeout"],
      ["Windows driver was cancelled: private", false, "cancelled"],
      ["Windows driver was cancelled: private", true, "deadline"],
    ] as const) {
      const rows: ObservationDiagnostic[] = []
      let clock = 100
      const report = await inspectInstalledHost({
        ...input(),
        observation: { path: "powershell_fallback", stages: rows },
        observe: async () => {
          await observeStage(
            rows,
            "foreground_before",
            async () => {
              clock += 20
            },
            () => false,
            () => clock,
          )
          await observeStage(
            rows,
            "capture",
            async () => {
              clock += 30_000
              throw new Error(message)
            },
            () => expired,
            () => clock,
          )
          return frame
        },
      })
      expect(report.observationDiagnostics).toEqual({
        path: "powershell_fallback",
        stages: [
          { stage: "foreground_before", code: "ready", elapsedMs: 20 },
          { stage: "capture", code, elapsedMs: 15_000 },
        ],
      })
      expect(report.observationFailure).toEqual({ stage: "capture" })
      expect(JSON.stringify(report)).not.toContain(message)
      expect(report.releaseGateEligible).toBe(false)
    }
  })

  test("does not claim the hashed native binary was exercised by fallback capture", async () => {
    const rows: ObservationDiagnostic[] = []
    const report = await inspectInstalledHost({
      ...input(),
      observation: { path: "powershell_fallback", stages: rows },
      observe: () =>
        observeStage(
          rows,
          "capture",
          async () => frame,
          () => false,
        ),
    })
    expect(report.status).toBe("observed")
    expect(report.loadedCaptureSha256).toBe("c".repeat(64))
    expect(report.observationDiagnostics).toMatchObject({
      path: "powershell_fallback",
      stages: [{ stage: "capture", code: "ready" }],
    })
  })

  test("distinguishes unavailable startup evidence from an actual package mismatch", async () => {
    for (const status of ["missing", "timeout", "failed"] as const) {
      let called = false
      const report = await inspectInstalledHost({
        ...input(),
        active: undefined,
        diagnostics: {
          vault: { status, elapsedMs: 5 },
          desktop: { status: "ready", elapsedMs: 3 },
          capture: { status: "ready", elapsedMs: 1 },
        },
        observe: async () => {
          called = true
          return frame
        },
      })
      expect(report.status).toBe("unavailable")
      expect(report.reason).toContain(`unavailable (${status})`)
      expect(report.reason).not.toContain("does not match")
      expect(report.diagnostics?.vault).toEqual({ status, elapsedMs: 5 })
      expect(report.releaseGateEligible).toBe(false)
      expect(called).toBe(false)
    }
    const missing = await inspectInstalledHost({ ...input(), desktop: {} })
    expect(missing.reason).toContain("desktop identity is unavailable")
    const different = await inspectInstalledHost({ ...input(), active: { version: "old", digest } })
    expect(different.reason).toContain("does not match")
  })

  test("records a stable live observation without pixels or claiming task success", async () => {
    const report = await inspectInstalledHost(input())
    expect(report.status).toBe("observed")
    expect(report.releaseGateEligible).toBe(false)
    expect(report.version).toBe(6)
    expect(report.actionReceipts).toBeNull()
    expect(report.receiptEvidence).toBe("durable_summary")
    expect(report.journal).toEqual({
      status: "durable",
      epoch: "epoch-test",
      revision: 3,
      lastAckAt: null,
      pendingNative: { confirmed: 1, unknown: 2 },
      audit: { count: 4, confirmed: 3, unknown: 1 },
    })
    expect(report.taskFinalState).toBeNull()
    expect(report.backendProcess).toEqual(process)
    expect(report.lease).toEqual(lease)
    expect(JSON.stringify(report)).not.toContain("data:")
  })

  test("rejects an unloaded version or unexpected active digest before capture", async () => {
    let called = false
    const wrong = await inspectInstalledHost({ ...input(), active: { version: "7.4.23-snapshot+old.test.1", digest } })
    const stale = await inspectInstalledHost({
      ...input(),
      active: { version, digest: "b".repeat(64) },
      observe: async () => {
        called = true
        return frame
      },
    })
    expect(wrong.status).toBe("unavailable")
    expect(stale.status).toBe("unavailable")
    expect(called).toBe(false)
    const binary = await inspectInstalledHost({
      ...input(),
      expected: { version, digest, captureSha256: "d".repeat(64) },
    })
    expect(binary.status).toBe("unavailable")
  })

  test("rejects missing foreground and changed target", async () => {
    const empty = await inspectInstalledHost({
      ...input(),
      observe: async () => {
        throw new Error("no foreground")
      },
    })
    const changed = await inspectInstalledHost({
      ...input(),
      observe: async () => ({ ...frame, after: { ...frame.after, windowID: "0x20" } }),
    })
    const replaced = await inspectInstalledHost({
      ...input(),
      observe: async () => ({ ...frame, after: { ...frame.after, identity: "B".repeat(64) } }),
    })
    expect(empty.status).toBe("unavailable")
    expect(empty.observationFailure).toEqual({ stage: "unknown" })
    expect(changed.status).toBe("unavailable")
    expect(replaced.status).toBe("unavailable")
  })

  test("reports only a bounded observation stage and never raw native failure details", async () => {
    const privateText = "private window password clipboard data:image/png;base64,secret"
    for (const stage of [
      "foreground_before",
      "identity_before",
      "capture",
      "identity_after",
      "foreground_after",
    ] as const) {
      const error = new ObservationFailure(stage)
      error.message = privateText
      const report = await inspectInstalledHost({
        ...input(),
        observe: async () => {
          throw error
        },
      })
      expect(report.status).toBe("unavailable")
      expect(report.observationFailure).toEqual({ stage })
      expect(JSON.stringify(report)).not.toContain(privateText)
      expect("foreground" in report).toBe(false)
      expect(report.releaseGateEligible).toBe(false)
    }
    const report = await inspectInstalledHost({
      ...input(),
      observe: async () => {
        throw new Error(privateText)
      },
    })
    expect(report.observationFailure).toEqual({ stage: "unknown" })
    expect(JSON.stringify(report)).not.toContain(privateText)
    const forged = Object.assign(new ObservationFailure("capture"), { stage: privateText })
    const invalid = await inspectInstalledHost({
      ...input(),
      observe: async () => {
        throw forged
      },
    })
    expect(invalid.observationFailure).toEqual({ stage: "unknown" })
    expect(JSON.stringify(invalid)).not.toContain(privateText)
  })

  test.each(["Default", "CodexSandboxDesktop-123"])(
    "refuses capture on a sandbox desktop with input %s even when package and backend match",
    async (name) => {
      let called = false
      const report = await inspectInstalledHost({
        ...input(),
        desktop: { host: "CodexSandboxDesktop-123", input: name },
        observe: async () => {
          called = true
          return frame
        },
      })
      expect(report.status).toBe("unavailable")
      expect(report.desktop).toEqual({ host: "CodexSandboxDesktop-123", input: name })
      expect(called).toBe(false)
    },
  )

  test("rejects backend disconnect during observation", async () => {
    let state = "connected"
    const report = await inspectInstalledHost({
      ...input(),
      backend: () => state,
      observe: async () => {
        state = "disconnected"
        return frame
      },
    })
    expect(report.status).toBe("unavailable")
    expect("foreground" in report).toBe(false)
  })

  test("refuses an unmanaged backend before capture", async () => {
    let called = false
    const report = await inspectInstalledHost({
      ...input(),
      process: () => null,
      observe: async () => {
        called = true
        return frame
      },
    })
    expect(report.status).toBe("unavailable")
    expect(report.reason).toContain("managed")
    expect(called).toBe(false)
  })

  test("refuses a backend restart or lease transition during capture", async () => {
    let identity = process
    let grant = lease
    const restarted = await inspectInstalledHost({
      ...input(),
      process: () => identity,
      observe: async () => {
        identity = { ...process, generation: 2 }
        return frame
      },
    })
    expect(restarted.status).toBe("unavailable")
    expect(restarted.reason).toContain("backend changed")
    const changed = await inspectInstalledHost({
      ...input(),
      lease: () => grant,
      observe: async () => {
        grant = { ...lease, grantHash: "c".repeat(64) }
        return frame
      },
    })
    expect(changed.status).toBe("unavailable")
    expect(changed.reason).toContain("lease changed")
  })

  test("refuses identity and lease changes before starting capture", async () => {
    let calls = 0
    let captures = 0
    const restart = await inspectInstalledHost({
      ...input(),
      process: () => (++calls === 1 ? process : { ...process, pid: 456 }),
      observe: async () => {
        captures++
        return frame
      },
    })
    expect(restart.status).toBe("unavailable")
    expect(captures).toBe(0)
    calls = 0
    const policy = await inspectInstalledHost({
      ...input(),
      lease: () => (++calls === 1 ? lease : { ...lease, state: "paused" }),
      observe: async () => {
        captures++
        return frame
      },
    })
    expect(policy.status).toBe("unavailable")
    expect(captures).toBe(0)
  })

  test("does not invent empty receipts for absent, malformed, or migrating journals", async () => {
    for (const state of ["absent", "malformed", "migrating_legacy", "unavailable"] as const) {
      const report = await inspectInstalledHost({ ...input(), journal: () => ({ state, summary: null }) })
      expect(report.journal).toEqual({ status: state })
      expect(report.receiptEvidence).toBe("not_inspected")
      expect(report.actionReceipts).toBeNull()
      expect(JSON.stringify(report)).not.toContain("pendingNative")
    }
    const inconsistent = await inspectInstalledHost({
      ...input(),
      journal: () => ({ state: "durable", summary: null }),
    })
    expect(inconsistent.journal).toEqual({ status: "unavailable" })
    expect(inconsistent.receiptEvidence).toBe("not_inspected")
  })
})
