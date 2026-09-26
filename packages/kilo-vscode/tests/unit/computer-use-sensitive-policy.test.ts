import { describe, expect, it } from "bun:test"
import type { DesktopRequest } from "@kilocode/sdk/v2/client"
import {
  ComputerUseLeaseStore,
  type LeaseStorage,
  type SensitivePolicy,
} from "../../src/services/computer-use/lease-store"

const policy = (rule: SensitivePolicy[keyof SensitivePolicy]): SensitivePolicy => ({
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

const request = (sessionID = "one") =>
  ({
    id: "request",
    sessionID,
    operation: "authorize",
    surface: "desktop",
    action: "pointer",
    windowID: "window",
    sensitive: "communications",
  }) satisfies Extract<DesktopRequest, { operation: "authorize" }>

function memory() {
  const data = new Map<string, unknown>()
  const storage: LeaseStorage = {
    get: <T>(key: string) => data.get(key) as T | undefined,
    update: async (key, value) => {
      if (value === undefined) data.delete(key)
      else data.set(key, structuredClone(value))
    },
  }
  return { storage, data }
}

describe("reusable Computer Use sensitive policy", () => {
  it("survives restart without becoming a grant or carrying private action data", async () => {
    const state = memory()
    const first = new ComputerUseLeaseStore(state.storage, () => 100)
    const saved = policy("ask")
    saved.communications = "allow_always"
    await first.savePolicy(saved)
    const second = new ComputerUseLeaseStore(state.storage, () => 200)
    expect(second.savedPolicy()).toEqual(saved)
    expect(second.current()).toBeUndefined()
    expect(second.authorize(request()).decision).toBe("ask")
    expect([...state.data.keys()]).toEqual(["raya.computerUse.sensitivePolicy.v1"])
    expect(JSON.stringify([...state.data.values()])).not.toContain("window")
  })

  it("does not alter an active lease until an explicit new grant applies selected rules", async () => {
    const state = memory()
    const store = new ComputerUseLeaseStore(state.storage, () => 100)
    await store.grant({
      sessionID: "one",
      level: "autonomous",
      duration: "session",
      applications: "all",
      actions: ["pointer"],
      sensitive: policy("ask"),
      cooperativeInput: false,
    })
    const saved = policy("allow_always")
    await store.savePolicy(saved)
    expect(store.authorize(request()).decision).toBe("ask")
    await store.stop()
    expect(store.authorize(request()).decision).toBe("deny")
    const restarted = new ComputerUseLeaseStore(state.storage, () => 200)
    expect(restarted.savedPolicy()).toEqual(saved)
    expect(restarted.authorize(request()).decision).toBe("ask")
    await restarted.grant({
      sessionID: "one",
      level: "autonomous",
      duration: "session",
      applications: "all",
      actions: ["pointer"],
      sensitive: restarted.savedPolicy()!,
      cooperativeInput: false,
    })
    expect(restarted.authorize(request()).decision).toBe("allow")
  })

  it("keeps policy after lease expiry and revocation but never treats it as authority", async () => {
    const state = memory()
    let now = 100
    const store = new ComputerUseLeaseStore(state.storage, () => now)
    await store.savePolicy(policy("allow_always"))
    await store.grant({
      sessionID: "one",
      level: "autonomous",
      duration: "hour",
      applications: "all",
      actions: ["pointer"],
      sensitive: policy("allow_always"),
      cooperativeInput: false,
    })
    now += 60 * 60 * 1000
    expect(store.authorize(request()).decision).toBe("deny")
    await store.stop()
    expect(store.savedPolicy()).toEqual(policy("allow_always"))
    await store.clearPolicy()
    const restarted = new ComputerUseLeaseStore(state.storage, () => now)
    expect(restarted.savedPolicy()).toBeUndefined()
    expect(restarted.current()).toBeUndefined()
  })

  it("refuses malformed or incomplete saved policies", async () => {
    const state = memory()
    const store = new ComputerUseLeaseStore(state.storage)
    await expect(store.savePolicy({ communications: "allow_always" } as SensitivePolicy)).rejects.toThrow(
      /every sensitive action category/,
    )
    state.data.set("raya.computerUse.sensitivePolicy.v1", { version: 1, sensitive: { communications: "allow_always" } })
    expect(new ComputerUseLeaseStore(state.storage).savedPolicy()).toBeUndefined()
  })

  it("does not claim a saved policy after persistence fails", async () => {
    const storage: LeaseStorage = {
      get: () => undefined,
      update: async (key) => {
        if (key === "raya.computerUse.sensitivePolicy.v1") throw new Error("disk unavailable")
      },
    }
    const store = new ComputerUseLeaseStore(storage)
    await expect(store.savePolicy(policy("allow_always"))).rejects.toThrow("disk unavailable")
    expect(store.savedPolicy()).toBeUndefined()
    expect(store.authorize(request()).decision).toBe("ask")
  })
})
