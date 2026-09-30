import { describe, expect, it } from "bun:test"
import { nativeCaptureTrial } from "../../src/commands/native-capture-trial-core"
import { ComputerUseLeaseStore, type ComputerUseLease } from "../../src/services/computer-use/lease-store"
import { DesktopCaptureMetrics } from "../../src/services/computer-use/desktop-capture-metrics"

async function setup() {
  const values = new Map<string, unknown>()
  const lease = new ComputerUseLeaseStore({
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key, value) => {
      values.set(key, value)
    },
  })
  await lease.grant({
    sessionID: "session_test",
    level: "observe",
    duration: "session",
    applications: "current",
    windowID: "0x123",
    identity: "A".repeat(64),
    actions: ["observe"],
    cooperativeInput: false,
    sensitive: {
      communications: "deny",
      financial: "deny",
      credentials: "deny",
      software: "deny",
      system: "deny",
      deletion: "deny",
      disclosure: "deny",
      legal: "deny",
      publishing: "deny",
    },
  })
  const listeners = new Set<() => void>()
  const metrics = new DesktopCaptureMetrics(0)
  metrics.event({ kind: "frame", at: 3, received: 1, accepted: 2, acquisitionMs: 1, preparationMs: 1 })
  const state = { connected: true, manual: false, opened: 0, loaded: 0, stopped: 0, lease: lease.current()! }
  const input = {
    lease: () => state.lease,
    ready: () => true,
    connected: () => state.connected,
    manual: () => state.manual,
    concurrent: { path: "powershell_fallback" as const, pid: null },
    onLease: lease.onChange.bind(lease),
    onConnection: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onState: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load: async () => {
      state.loaded++
      return { path: "installed/raya-desktop-capture.exe", sha256: "c".repeat(64) }
    },
    open: (_scope: ComputerUseLease, _failed: () => void, _valid: () => boolean) => {
      state.opened++
      return {
        timing: async () => metrics.snapshot(),
        pid: () => 1234,
        stop: () => {
          state.stopped++
        },
      }
    },
  }
  return { input, state, lease, listeners }
}

describe("bounded selected native capture trial", () => {
  it("requires an existing selected observe session before hashing or capture", async () => {
    const test = await setup()
    for (const patch of [
      { state: "paused" as const },
      { level: "autonomous" as const },
      { applications: { kind: "all" as const } },
      { lifetime: { kind: "all_sessions" as const } },
      {
        applications: {
          kind: "selected" as const,
          values: ["0x123", "0x124"],
          identities: { "0x123": "A".repeat(64), "0x124": "B".repeat(64) },
        },
      },
    ]) {
      const report = await nativeCaptureTrial({ ...test.input, lease: () => ({ ...test.state.lease, ...patch }) }, 100)
      expect(report.status).toBe("unavailable")
    }
    const absent = await nativeCaptureTrial({ ...test.input, lease: () => undefined }, 100)
    expect(absent.status).toBe("unavailable")
    expect(test.state.loaded).toBe(0)
    expect(test.state.opened).toBe(0)
  })

  it("retains exact native identity, reports concurrent capture and stops without renewing the lease", async () => {
    const test = await setup()
    const before = test.lease.current()
    const report = await nativeCaptureTrial(test.input, 100)
    expect(report.status).toBe("complete")
    expect(report.source).toMatchObject({
      path: "native_selected_window",
      sha256: "c".repeat(64),
      pid: 1234,
      windowID: "0x123",
      identity: "A".repeat(64),
      stop: "requested",
    })
    expect(report.concurrentCapture.path).toBe("powershell_fallback")
    expect(report.releaseGateEligible).toBe(false)
    expect(test.state.opened).toBe(1)
    expect(test.state.stopped).toBeGreaterThan(0)
    expect(test.lease.current()).toEqual(before)
    expect(test.listeners.size).toBe(0)
    expect(JSON.stringify(report)).not.toContain("session_test")
  })

  it("cancels held binary admission on Stop without starting native capture", async () => {
    const test = await setup()
    const pending = nativeCaptureTrial(
      { ...test.input, lease: () => test.lease.current(), load: () => new Promise(() => {}) },
      100,
    )
    await test.lease.stop()
    const report = await pending
    expect(report.reason).toBe("authority_changed")
    expect(test.state.opened).toBe(0)
  })

  it("expires during sampling without a lease-change event", async () => {
    const test = await setup()
    test.state.lease = { ...test.state.lease, expiry: { kind: "expires_at", expiresAt: Date.now() + 25 } }
    const report = await nativeCaptureTrial(
      {
        ...test.input,
        open: (scope, failed, valid) => ({
          ...test.input.open(scope, failed, valid),
          timing: () => new Promise(() => {}),
        }),
      },
      100,
    )
    expect(report.reason).toBe("authority_expired")
    expect(test.state.stopped).toBeGreaterThan(0)
  })

  it("requires an actual child PID and rechecks silent authority changes before completion", async () => {
    const test = await setup()
    const missing = await nativeCaptureTrial(
      {
        ...test.input,
        open: (scope, failed, valid) => ({ ...test.input.open(scope, failed, valid), pid: () => undefined }),
      },
      100,
    )
    expect(missing.status).toBe("unavailable")
    const changed = await nativeCaptureTrial(
      {
        ...test.input,
        open: (scope, failed, valid) => {
          const source = test.input.open(scope, failed, valid)
          return {
            ...source,
            timing: async () => {
              test.state.manual = true
              return source.timing()
            },
          }
        },
      },
      100,
    )
    expect(changed.status).toBe("cancelled")
    expect(changed.reason).toBe("authority_changed")
  })

  it.each(["disconnect", "manual", "cancel", "fault", "deadline"])(
    "stops a held capture on %s without retry",
    async (kind) => {
      const test = await setup()
      const controller = new AbortController()
      let failed: (() => void) | undefined
      const pending = nativeCaptureTrial(
        {
          ...test.input,
          signal: controller.signal,
          open: (scope, failure, valid) => {
            const source = test.input.open(scope, failure, valid)
            failed = failure
            return { ...source, timing: () => new Promise(() => {}) }
          },
        },
        30,
      )
      await Bun.sleep(1)
      if (kind === "disconnect") test.state.connected = false
      if (kind === "manual") test.state.manual = true
      if (kind === "cancel") controller.abort()
      if (kind === "fault") failed?.()
      if (kind === "disconnect" || kind === "manual") for (const listener of test.listeners) listener()
      const report = await pending
      expect(report.status).not.toBe("complete")
      expect(test.state.opened).toBe(1)
      expect(test.state.stopped).toBeGreaterThan(0)
      expect(test.listeners.size).toBe(0)
      expect(report.source?.stop).toBe("requested")
    },
  )
})
