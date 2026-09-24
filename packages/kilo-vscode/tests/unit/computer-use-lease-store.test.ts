import { describe, expect, it } from "bun:test"
import type { DesktopRequest } from "@kilocode/sdk/v2/client"
import {
  ComputerUseLeaseStore,
  type GrantInput,
  type LeaseStorage,
  type SensitivePolicy,
} from "../../src/services/computer-use/lease-store"

const policy = (rule: SensitivePolicy[keyof SensitivePolicy] = "ask"): SensitivePolicy => ({
  communications: rule,
  financial: rule,
  credentials: rule,
  software: rule,
  system: rule,
  deletion: rule,
  disclosure: rule,
  legal: rule,
  publishing: rule,
})

const auth = (patch: Partial<Extract<DesktopRequest, { operation: "authorize" }>> = {}) =>
  ({
    id: "authorize_test",
    sessionID: "session_test",
    operation: "authorize",
    surface: "desktop",
    action: "pointer",
    windowID: "window_test",
    sensitive: false,
    ...patch,
  }) satisfies Extract<DesktopRequest, { operation: "authorize" }>

function memory(seed?: unknown) {
  let value = seed
  return {
    get: <T>(_key: string) => value as T | undefined,
    update: async (_key: string, next: unknown) => {
      value = structuredClone(next)
    },
    read: () => value,
  } satisfies LeaseStorage & { read(): unknown }
}

describe("Computer Use lease store", () => {
  it("Stop cancels a pending durable grant before it can authorize or survive restart", async () => {
    let release!: () => void
    let signal!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const called = new Promise<void>((resolve) => (signal = resolve))
    let value: unknown
    let writes = 0
    const storage: LeaseStorage = {
      get: <T>() => value as T | undefined,
      update: async (_key, next) => {
        writes++
        if (writes === 1) {
          signal()
          await gate
        }
        value = structuredClone(next)
      },
    }
    const store = new ComputerUseLeaseStore(storage, () => 100)
    const pending = store.grant({
      sessionID: "session_test",
      level: "autonomous",
      duration: "until_stopped",
      applications: "all",
      actions: ["pointer"],
      sensitive: policy(),
      cooperativeInput: false,
    })
    await called
    expect(store.authorize(auth()).decision).toBe("ask")
    const stopped = store.stop()
    release()
    await expect(pending).rejects.toThrow(/changed before persistence/i)
    await stopped
    expect(writes).toBe(2)
    expect(value).toBeUndefined()
    expect(store.authorize(auth()).decision).toBe("deny")
    expect(new ComputerUseLeaseStore(storage, () => 100).current()).toBeUndefined()
  })

  it("does not authorize an uncommitted grant and recovers after a failed write", async () => {
    let fail!: (error: Error) => void
    let signal!: () => void
    const called = new Promise<void>((resolve) => (signal = resolve))
    let writes = 0
    const storage: LeaseStorage = {
      get: () => undefined,
      update: () => {
        writes++
        if (writes === 1)
          return new Promise<void>((_resolve, reject) => {
            fail = reject
            signal()
          })
        return Promise.resolve()
      },
    }
    const store = new ComputerUseLeaseStore(storage, () => 100)
    const input: GrantInput = {
      sessionID: "session_test",
      level: "autonomous",
      duration: "until_stopped",
      applications: "all",
      actions: ["pointer"],
      sensitive: policy(),
      cooperativeInput: false,
    }
    const pending = store.grant(input)
    expect(store.current()).toBeUndefined()
    expect(store.authorize(auth()).decision).toBe("ask")
    await called
    fail(new Error("Storage write failed"))
    await expect(pending).rejects.toThrow("Storage write failed")
    expect(store.current()).toBeUndefined()
    const saved = await store.grant(input)
    expect(writes).toBe(2)
    expect(store.authorize(auth()).grantID).toBe(saved.id)
  })

  it("rejects malformed grant messages before creating or widening authority", async () => {
    const store = new ComputerUseLeaseStore(memory(), () => 100)
    const valid: GrantInput = {
      sessionID: "session_test",
      level: "autonomous",
      duration: "session",
      applications: "current",
      windowID: "window_test",
      actions: ["pointer"],
      sensitive: policy(),
      cooperativeInput: false,
    }
    for (const patch of [
      { level: "unexpected" },
      { duration: "unlimited" },
      { applications: "everywhere" },
      { windowID: 42 },
      { actions: "pointer" },
      { sessionID: "" },
      { cooperativeInput: "false" },
    ]) {
      await expect(store.grant({ ...valid, ...patch } as unknown as GrantInput)).rejects.toThrow()
      expect(store.current()).toBeUndefined()
      expect(store.authorize(auth()).decision).toBe("ask")
    }
  })

  it("allows an ordinary exact-session action and keeps the grant memory-only", async () => {
    const storage = memory()
    const store = new ComputerUseLeaseStore(storage, () => 100)
    const lease = await store.grant({
      sessionID: "session_test",
      level: "autonomous",
      duration: "session",
      applications: "current",
      windowID: "window_test",
      actions: ["observe", "pointer"],
      sensitive: policy(),
      cooperativeInput: false,
    })

    expect(storage.read()).toBeUndefined()
    expect(store.authorize(auth())).toEqual({
      operation: "authorize",
      decision: "allow",
      reason: "Authorized by active Computer Use grant",
      grantID: lease.id,
    })
    expect(store.authorize(auth({ sessionID: "session_other" }))).toMatchObject({ decision: "ask" })
    expect(store.authorize(auth({ windowID: "window_other" }))).toMatchObject({ decision: "ask" })
    expect(
      store.authorize({
        id: "browser_authorize_test",
        sessionID: "session_test",
        operation: "authorize",
        surface: "browser",
        action: "browser",
        sensitive: false,
      }),
    ).toMatchObject({ decision: "ask" })
  })

  it("persists all-session authority and restores it without widening scope", async () => {
    const storage = memory()
    const first = new ComputerUseLeaseStore(storage, () => 1_000)
    await first.grant({
      sessionID: "session_test",
      level: "assisted",
      duration: "hour",
      applications: "all",
      actions: ["observe", "pointer", "keyboard"],
      sensitive: policy(),
      cooperativeInput: false,
    })
    const second = new ComputerUseLeaseStore(storage, () => 2_000)

    expect(second.authorize(auth({ sessionID: "session_other" }))).toMatchObject({ decision: "allow" })
    expect(second.authorize(auth({ action: "scroll" }))).toEqual({
      operation: "authorize",
      decision: "ask",
      reason: "This action is outside the grant",
    })
    expect(
      second.authorize({
        id: "browser_authorize_test",
        sessionID: "session_other",
        operation: "authorize",
        surface: "browser",
        action: "keyboard",
        sensitive: false,
      }),
    ).toMatchObject({ decision: "allow" })
  })

  it("denies pause, expiry, and observe-only mutation before dispatch", async () => {
    const storage = memory()
    let now = 1_000
    const store = new ComputerUseLeaseStore(storage, () => now)
    await store.grant({
      sessionID: "session_test",
      level: "observe",
      duration: "hour",
      applications: "all",
      actions: ["observe"],
      sensitive: policy(),
      cooperativeInput: false,
    })
    expect(store.authorize(auth())).toMatchObject({
      decision: "deny",
      reason: "Observe only cannot control the desktop",
    })
    expect(store.authorize(auth({ action: "observe" }))).toMatchObject({ decision: "allow" })
    await store.pause()
    expect(store.authorize(auth({ action: "observe" }))).toMatchObject({
      decision: "deny",
      reason: "Computer Use is paused",
    })
    await store.resume()
    now += 60 * 60 * 1000
    expect(store.authorize(auth({ action: "observe" }))).toMatchObject({
      decision: "deny",
      reason: "The Computer Use grant expired",
    })
  })

  it("asks for sensitive actions and rejects unsafe or unstable grants", async () => {
    const storage = memory()
    const store = new ComputerUseLeaseStore(storage, () => 100)
    await store.grant({
      sessionID: "session_test",
      level: "autonomous",
      duration: "until_stopped",
      applications: "all",
      actions: ["pointer"],
      sensitive: policy(),
      cooperativeInput: false,
    })
    expect(store.authorize(auth({ sensitive: true }))).toMatchObject({ decision: "ask" })
    await expect(
      store.grant({
        sessionID: "session_test",
        level: "autonomous",
        duration: "until_stopped",
        applications: "current",
        windowID: "window_test",
        actions: ["pointer"],
        sensitive: policy(),
        cooperativeInput: false,
      }),
    ).rejects.toThrow(/limited to this task/i)
  })

  it("ignores malformed, expired, and session grants during reconstruction", async () => {
    const invalid = new ComputerUseLeaseStore(memory({ version: 1, id: "bad" }))
    expect(invalid.current()).toBeUndefined()

    const storage = memory()
    const first = new ComputerUseLeaseStore(storage, () => 1_000)
    await first.grant({
      sessionID: "session_test",
      level: "assisted",
      duration: "hour",
      applications: "all",
      actions: ["observe"],
      sensitive: policy(),
      cooperativeInput: false,
    })
    const expired = new ComputerUseLeaseStore(storage, () => 4_000_001)
    expect(expired.current()).toBeUndefined()

    const session = memory({
      version: 2,
      id: "grant_session",
      level: "autonomous",
      state: "active",
      issuedAt: 1,
      lifetime: { kind: "session", sessionID: "session_test" },
      expiry: { kind: "until_stopped" },
      applications: { kind: "all" },
      monitors: { kind: "all" },
      surfaces: ["desktop"],
      actions: ["pointer"],
      sensitive: policy(),
      sensitiveSessionID: "session_test",
      cooperativeInput: false,
    })
    expect(new ComputerUseLeaseStore(session).current()).toBeUndefined()
  })

  it("enforces each sensitive policy decision without exposing private action data", async () => {
    const store = new ComputerUseLeaseStore(memory(), () => 100)
    const sensitive = policy()
    sensitive.communications = "allow_session"
    sensitive.financial = "deny"
    sensitive.publishing = "allow_always"
    await store.grant({
      sessionID: "session_test",
      level: "autonomous",
      duration: "until_stopped",
      applications: "all",
      actions: ["pointer"],
      sensitive,
      cooperativeInput: false,
    })

    expect(store.authorize(auth({ sensitive: "communications" }))).toMatchObject({ decision: "allow" })
    expect(store.authorize(auth({ sensitive: "communications", sessionID: "session_other" }))).toMatchObject({
      decision: "ask",
    })
    expect(store.authorize(auth({ sensitive: "financial" }))).toMatchObject({ decision: "deny" })
    expect(store.authorize(auth({ sensitive: "publishing", sessionID: "session_other" }))).toMatchObject({
      decision: "allow",
    })
    expect(store.authorize(auth({ sensitive: "credentials" }))).toMatchObject({ decision: "ask" })
  })

  it("asks before sensitive assisted actions despite an allow rule", async () => {
    const store = new ComputerUseLeaseStore(memory(), () => 100)
    const sensitive = policy("allow_always")
    sensitive.financial = "deny"
    await store.grant({
      sessionID: "session_test",
      level: "assisted",
      duration: "session",
      applications: "all",
      actions: ["pointer"],
      sensitive,
      cooperativeInput: false,
    })
    expect(store.authorize(auth())).toMatchObject({ decision: "allow" })
    expect(store.authorize(auth({ sensitive: "communications" }))).toMatchObject({
      decision: "ask",
      reason: "Assisted control asks before sensitive actions",
    })
    expect(store.authorize(auth({ sensitive: "financial" }))).toMatchObject({ decision: "deny" })
  })

  it("retains a session revocation until a fresh user review begins", async () => {
    const store = new ComputerUseLeaseStore(memory(), () => 100)
    await store.grant({
      sessionID: "session_test",
      level: "autonomous",
      duration: "session",
      applications: "all",
      actions: ["pointer"],
      sensitive: policy(),
      cooperativeInput: false,
    })
    expect(store.authorize(auth())).toMatchObject({ decision: "allow" })
    await store.stop()
    expect(store.authorize(auth())).toMatchObject({ decision: "deny" })
    expect(store.review(auth())).toMatchObject({ decision: "ask" })
  })
})
