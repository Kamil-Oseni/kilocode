import { describe, expect, it } from "bun:test"
import { DesktopCaptureLifecycle } from "../../src/services/computer-use/desktop-capture-lifecycle"

describe("continuous desktop capture lifecycle", () => {
  it("pins one selected foreground window at a time and stops on unselected or reused handles", async () => {
    const ids = { "0x111": "A".repeat(64), "0x222": "B".repeat(64) }
    const state = {
      window: "0x111",
      identity: ids["0x111"],
      control: "agent" as "agent" | "manual",
      connected: "connected",
      lease: "active" as "active" | "paused",
    }
    const starts: Array<{ windowID: string; identity: string } | undefined> = []
    let stops = 0
    let failures = 0
    const lease = new Set<() => void>()
    const session = new Set<() => void>()
    const connection = new Set<(state: string) => void>()
    const capture = new DesktopCaptureLifecycle(
      {
        current: () => ({
          id: "grant_multi",
          state: state.lease,
          applications: { kind: "selected" as const, values: Object.keys(ids), identities: ids },
          monitors: { kind: "all" as const },
          surfaces: ["desktop"],
          actions: ["observe"],
        }),
        onChange: (listener) => {
          lease.add(listener)
          return () => lease.delete(listener)
        },
      },
      {
        current: () => ({ control: state.control }),
        onState: (listener) => {
          session.add(listener)
          return () => session.delete(listener)
        },
      },
      {
        probeCurrent: async () => ({ windowID: state.window }),
        probePinCurrent: async (windowID) => ({ windowID, identity: state.identity }),
        cancelProbe: () => undefined,
        startCapture: (_failed, target) => starts.push(target),
        stopCapture: () => {
          stops++
        },
      },
      {
        getConnectionState: () => state.connected,
        onStateChange: (listener) => {
          connection.add(listener)
          return () => connection.delete(listener)
        },
      },
      () => {
        failures++
      },
    )
    await Bun.sleep(20)
    expect(starts).toEqual([{ windowID: "0x111", identity: ids["0x111"] }])
    state.window = "0x222"
    state.identity = ids["0x222"]
    await Bun.sleep(300)
    expect(starts.at(-1)).toEqual({ windowID: "0x222", identity: ids["0x222"] })
    expect(starts).toHaveLength(2)
    state.window = "0x333"
    await Bun.sleep(300)
    expect(starts).toHaveLength(2)
    const before = stops
    state.window = "0x111"
    state.identity = "C".repeat(64)
    await Bun.sleep(300)
    expect(starts).toHaveLength(2)
    expect(stops).toBeGreaterThan(before)
    expect(failures).toBe(0)
    state.identity = ids["0x111"]
    await Bun.sleep(300)
    expect(starts).toHaveLength(3)
    state.control = "manual"
    for (const listener of session) listener()
    await Bun.sleep(300)
    expect(starts).toHaveLength(3)
    capture.dispose()
  })

  it("invalidates an in-flight selected probe on Pause, disconnect, and disposal", async () => {
    const id = "A".repeat(64)
    const state = {
      lease: "active" as "active" | "paused",
      connected: "connected",
      control: "agent" as "agent" | "manual",
    }
    const listeners = {
      lease: new Set<() => void>(),
      session: new Set<() => void>(),
      connection: new Set<(state: string) => void>(),
    }
    const probes: Array<(value: { windowID: string }) => void> = []
    const starts: string[] = []
    let stops = 0
    const capture = new DesktopCaptureLifecycle(
      {
        current: () => ({
          id: "grant_multi",
          state: state.lease,
          applications: {
            kind: "selected" as const,
            values: ["0x111", "0x222"],
            identities: { "0x111": id, "0x222": "B".repeat(64) },
          },
          monitors: { kind: "all" as const },
          surfaces: ["desktop"],
          actions: ["observe"],
        }),
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
        probeCurrent: () => new Promise((resolve) => probes.push(resolve)),
        probePinCurrent: async (windowID) => ({ windowID, identity: id }),
        cancelProbe: () => undefined,
        startCapture: (_failed, target) => starts.push(target!.windowID),
        stopCapture: () => {
          stops++
        },
      },
      {
        getConnectionState: () => state.connected,
        onStateChange: (listener) => {
          listeners.connection.add(listener)
          return () => listeners.connection.delete(listener)
        },
      },
      () => undefined,
    )
    expect(probes).toHaveLength(1)
    await Bun.sleep(320)
    expect(probes).toHaveLength(1)
    state.lease = "paused"
    for (const listener of listeners.lease) listener()
    probes.shift()!({ windowID: "0x111" })
    await Bun.sleep(0)
    expect(starts).toEqual([])
    state.lease = "active"
    for (const listener of listeners.lease) listener()
    expect(probes).toHaveLength(1)
    state.connected = "disconnected"
    for (const listener of listeners.connection) listener(state.connected)
    probes.shift()!({ windowID: "0x111" })
    await Bun.sleep(0)
    expect(starts).toEqual([])
    state.connected = "connected"
    for (const listener of listeners.connection) listener(state.connected)
    expect(probes).toHaveLength(1)
    capture.dispose()
    probes.shift()!({ windowID: "0x111" })
    await Bun.sleep(0)
    expect(starts).toEqual([])
    expect(stops).toBeGreaterThan(0)
  })

  it("stops selected capture and reports driver loss once without retrying a broken probe", async () => {
    let probes = 0
    let starts = 0
    const failures: unknown[] = []
    const capture = new DesktopCaptureLifecycle(
      {
        current: () => ({
          id: "grant_multi",
          state: "active" as const,
          applications: {
            kind: "selected" as const,
            values: ["0x111", "0x222"],
            identities: { "0x111": "A".repeat(64), "0x222": "B".repeat(64) },
          },
          monitors: { kind: "all" as const },
          surfaces: ["desktop"],
          actions: ["observe"],
        }),
        onChange: () => () => undefined,
      },
      { current: () => ({ control: "agent" as const }), onState: () => () => undefined },
      {
        probeCurrent: async () => {
          probes++
          throw new Error("driver lost")
        },
        probePinCurrent: async (windowID) => ({ windowID, identity: "A".repeat(64) }),
        cancelProbe: () => undefined,
        startCapture: () => {
          starts++
        },
        stopCapture: () => undefined,
      },
      { getConnectionState: () => "connected", onStateChange: () => () => undefined },
      (error) => failures.push(error),
    )
    await Bun.sleep(320)
    expect(starts).toBe(0)
    expect(probes).toBe(1)
    expect(failures).toHaveLength(1)
    capture.dispose()
  })

  it("latches probe loss through unrelated state changes until an explicit Pause and Resume", async () => {
    const listeners = new Set<() => void>()
    const state = { lease: "active" as "active" | "paused", failed: true }
    let probes = 0
    let starts = 0
    const capture = new DesktopCaptureLifecycle(
      {
        current: () => ({
          id: "grant_multi",
          state: state.lease,
          applications: {
            kind: "selected" as const,
            values: ["0x111", "0x222"],
            identities: { "0x111": "A".repeat(64), "0x222": "B".repeat(64) },
          },
          monitors: { kind: "all" as const },
          surfaces: ["desktop"],
          actions: ["observe"],
        }),
        onChange: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      { current: () => ({ control: "agent" as const }), onState: () => () => undefined },
      {
        probeCurrent: async () => {
          probes++
          if (state.failed) throw new Error("driver lost")
          return { windowID: "0x111" }
        },
        probePinCurrent: async (windowID) => ({ windowID, identity: "A".repeat(64) }),
        cancelProbe: () => undefined,
        startCapture: () => {
          starts++
        },
        stopCapture: () => undefined,
      },
      { getConnectionState: () => "connected", onStateChange: () => () => undefined },
      () => undefined,
    )
    await Bun.sleep(0)
    expect(probes).toBe(1)
    state.failed = false
    for (const listener of listeners) listener()
    await Bun.sleep(300)
    expect(probes).toBe(1)
    expect(starts).toBe(0)
    state.lease = "paused"
    for (const listener of listeners) listener()
    state.lease = "active"
    for (const listener of listeners) listener()
    await Bun.sleep(0)
    expect(starts).toBe(1)
    capture.dispose()
  })

  it("does not start a stale pinned window after a rapid foreground switch", async () => {
    const ids = { "0x111": "A".repeat(64), "0x222": "B".repeat(64) }
    let foreground = "0x111"
    let release: ((value: { windowID: string; identity: string }) => void) | undefined
    const starts: string[] = []
    const capture = new DesktopCaptureLifecycle(
      {
        current: () => ({
          id: "grant_multi",
          state: "active" as const,
          applications: { kind: "selected" as const, values: Object.keys(ids), identities: ids },
          monitors: { kind: "all" as const },
          surfaces: ["desktop"],
          actions: ["observe"],
        }),
        onChange: () => () => undefined,
      },
      { current: () => ({ control: "agent" as const }), onState: () => () => undefined },
      {
        probeCurrent: async () => ({ windowID: foreground }),
        probePinCurrent: (windowID) =>
          windowID === "0x111"
            ? new Promise((resolve) => {
                release = resolve
              })
            : Promise.resolve({ windowID, identity: ids["0x222"] }),
        cancelProbe: () => undefined,
        startCapture: (_failed, target) => starts.push(target!.windowID),
        stopCapture: () => undefined,
      },
      { getConnectionState: () => "connected", onStateChange: () => () => undefined },
      () => undefined,
    )
    await Bun.sleep(0)
    expect(release).toBeDefined()
    foreground = "0x222"
    release!({ windowID: "0x111", identity: ids["0x111"] })
    await Bun.sleep(20)
    expect(starts).toEqual([])
    await Bun.sleep(300)
    expect(starts).toEqual(["0x222"])
    capture.dispose()
  })
  it("starts only with a connected active lease and agent control, including a later Resume", () => {
    const listeners = {
      lease: new Set<() => void>(),
      session: new Set<() => void>(),
      connection: new Set<(state: string) => void>(),
    }
    const state: {
      lease: "active" | "paused" | undefined
      scope: "all" | "selected"
      identity: string | undefined
      monitor: "all" | "selected"
      control: "agent" | "manual"
      connection: string
      ready: boolean
    } = {
      lease: undefined,
      scope: "all",
      identity: "A".repeat(64),
      monitor: "all",
      control: "manual",
      connection: "connected",
      ready: false,
    }
    let starts = 0
    let stops = 0
    const targets: Array<{ windowID: string; identity: string } | undefined> = []
    const capture = new DesktopCaptureLifecycle(
      {
        current: () =>
          state.lease
            ? {
                state: state.lease,
                id: "grant-1",
                applications:
                  state.scope === "selected"
                    ? { kind: "selected" as const, values: ["0x123"], identity: state.identity }
                    : { kind: "all" as const },
                monitors: { kind: state.monitor },
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
        startCapture: (_failed, target) => {
          starts++
          targets.push(target)
        },
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
    expect(targets.at(-1)).toEqual({ windowID: "0x123", identity: "A".repeat(64) })
    state.control = "manual"
    for (const listener of listeners.session) listener()
    state.control = "agent"
    for (const listener of listeners.session) listener()
    expect(starts).toBe(5)
    state.identity = undefined
    for (const listener of listeners.lease) listener()
    expect(stops).toBeGreaterThan(before)
    state.identity = "A".repeat(64)
    state.monitor = "selected"
    for (const listener of listeners.lease) listener()
    expect(starts).toBe(5)
    capture.dispose()
    expect(listeners.lease.size + listeners.session.size + listeners.connection.size).toBe(0)
  })
})
