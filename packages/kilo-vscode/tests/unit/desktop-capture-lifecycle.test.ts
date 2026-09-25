import { describe, expect, it } from "bun:test"
import { DesktopCaptureLifecycle } from "../../src/services/computer-use/desktop-capture-lifecycle"

describe("continuous desktop capture lifecycle", () => {
  it("starts only with a connected active lease and agent control, including a later Resume", () => {
    const listeners = {
      lease: new Set<() => void>(),
      session: new Set<() => void>(),
      connection: new Set<(state: string) => void>(),
    }
    const state: {
      lease: "active" | "paused" | undefined
      scope: "all" | "selected"
      control: "agent" | "manual"
      connection: string
      ready: boolean
    } = { lease: undefined, scope: "all", control: "manual", connection: "connected", ready: false }
    let starts = 0
    let stops = 0
    const capture = new DesktopCaptureLifecycle(
      {
        current: () =>
          state.lease
            ? {
                state: state.lease,
                applications: { kind: state.scope },
                monitors: { kind: "all" },
                surfaces: ["desktop"],
                actions: ["observe"],
              }
            : undefined,
        onChange: (listener) => {
          listeners.lease.add(listener)
          return () => listeners.lease.delete(listener)
        },
      },
      {
        current: () => ({ control: state.control }),
        onState: (listener) => {
          listeners.session.add(listener)
          return () => listeners.session.delete(listener)
        },
      },
      {
        startCapture: () => starts++,
        stopCapture: () => stops++,
      },
      {
        getConnectionState: () => state.connection,
        onStateChange: (listener) => {
          listeners.connection.add(listener)
          return () => listeners.connection.delete(listener)
        },
      },
      () => undefined,
      () => state.ready,
    )
    state.lease = "active"
    for (const listener of listeners.lease) listener()
    expect(starts).toBe(0)
    state.control = "agent"
    for (const listener of listeners.session) listener()
    expect(starts).toBe(0)
    state.ready = true
    capture.refresh()
    expect(starts).toBe(1)
    state.control = "manual"
    for (const listener of listeners.session) listener()
    expect(stops).toBeGreaterThan(0)
    state.connection = "disconnected"
    for (const listener of listeners.connection) listener(state.connection)
    state.control = "agent"
    for (const listener of listeners.session) listener()
    expect(starts).toBe(1)
    state.connection = "connected"
    for (const listener of listeners.connection) listener(state.connection)
    expect(starts).toBe(2)
    state.lease = "paused"
    for (const listener of listeners.lease) listener()
    state.control = "manual"
    for (const listener of listeners.session) listener()
    state.lease = "active"
    for (const listener of listeners.lease) listener()
    expect(starts).toBe(2)
    state.control = "agent"
    for (const listener of listeners.session) listener()
    expect(starts).toBe(3)
    const before = stops
    state.scope = "selected"
    for (const listener of listeners.lease) listener()
    expect(stops).toBeGreaterThan(before)
    state.control = "manual"
    for (const listener of listeners.session) listener()
    state.control = "agent"
    for (const listener of listeners.session) listener()
    expect(starts).toBe(3)
    capture.dispose()
    expect(listeners.lease.size + listeners.session.size + listeners.connection.size).toBe(0)
  })
})
