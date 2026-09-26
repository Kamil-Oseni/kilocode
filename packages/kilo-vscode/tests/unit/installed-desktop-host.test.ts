import { describe, expect, test } from "bun:test"
import { inspectInstalledHost } from "../../src/commands/installed-desktop-host-core"

const version = "7.4.23-snapshot+abc.test.1"
const digest = "a".repeat(64)
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
    observe: async () => frame,
  }
}

describe("installed interactive host probe", () => {
  test("records a stable live observation without pixels or claiming task success", async () => {
    const report = await inspectInstalledHost(input())
    expect(report.status).toBe("observed")
    expect(report.releaseGateEligible).toBe(false)
    expect(report.actionReceipts).toEqual([])
    expect(report.taskFinalState).toBeNull()
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
    expect(changed.status).toBe("unavailable")
    expect(replaced.status).toBe("unavailable")
  })

  test("refuses capture on a sandbox desktop even when the package and backend match", async () => {
    let called = false
    const report = await inspectInstalledHost({
      ...input(),
      desktop: { host: "CodexSandboxDesktop-123", input: "Default" },
      observe: async () => {
        called = true
        return frame
      },
    })
    expect(report.status).toBe("unavailable")
    expect(report.desktop).toEqual({ host: "CodexSandboxDesktop-123", input: "Default" })
    expect(called).toBe(false)
  })

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
})
