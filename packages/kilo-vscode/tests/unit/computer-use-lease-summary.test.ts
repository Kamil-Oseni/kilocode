import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { ComputerUseLeaseStore, type SensitivePolicy } from "../../src/services/computer-use/lease-store"

const sensitive: SensitivePolicy = {
  communications: "ask",
  financial: "ask",
  credentials: "ask",
  software: "ask",
  system: "ask",
  deletion: "ask",
  disclosure: "ask",
  legal: "ask",
  publishing: "ask",
}

function memory(seed?: unknown) {
  const values = new Map<string, unknown>()
  if (seed !== undefined) values.set("raya.computerUse.lease.v1", seed)
  let writes = 0
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      writes += 1
      values.set(key, structuredClone(value))
    },
    writes: () => writes,
  }
}

describe("Computer Use lease diagnostic summary", () => {
  test("returns no details for an absent or malformed saved lease", () => {
    expect(new ComputerUseLeaseStore(memory()).summary()).toBeNull()
    const storage = memory({ version: 3, id: "forged", applications: { kind: "all" } })
    expect(new ComputerUseLeaseStore(storage).summary()).toBeNull()
    expect(storage.writes()).toBe(0)
  })

  test("hashes the grant and reports only coarse selected scope and state", async () => {
    const storage = memory()
    const store = new ComputerUseLeaseStore(storage, () => 100)
    const grant = await store.grant({
      sessionID: "private_session",
      level: "autonomous",
      duration: "session",
      applications: "selected",
      windows: [
        { windowID: "private_window_one", identity: "secret_identity_one" },
        { windowID: "private_window_two", identity: "secret_identity_two" },
      ],
      actions: ["observe"],
      sensitive,
      cooperativeInput: false,
    })
    const before = storage.writes()
    const summary = store.summary()
    expect(summary).toEqual({
      grantHash: createHash("sha256").update(grant.id).digest("hex"),
      level: "autonomous",
      state: "active",
      scopeCount: 2,
      expiresAt: null,
    })
    expect(JSON.stringify(summary)).not.toContain(grant.id)
    expect(JSON.stringify(summary)).not.toContain("private_")
    expect(JSON.stringify(summary)).not.toContain("secret_")
    expect(storage.writes()).toBe(before)
    await store.pause()
    expect(store.summary()?.state).toBe("paused")
    await store.stop()
    expect(store.summary()).toBeNull()
  })

  test("reports expired without mutation and preserves durable hash across restart", async () => {
    const storage = memory()
    let now = 100
    const store = new ComputerUseLeaseStore(storage, () => now)
    const grant = await store.grant({
      sessionID: "private_session",
      level: "assisted",
      duration: "hour",
      applications: "all",
      actions: ["observe"],
      sensitive,
      cooperativeInput: false,
    })
    expect(store.summary()).toMatchObject({ scopeCount: null, expiresAt: 3_600_100, state: "active" })
    const fresh = new ComputerUseLeaseStore(storage, () => now)
    expect(fresh.summary()?.grantHash).toBe(createHash("sha256").update(grant.id).digest("hex"))
    const before = storage.writes()
    now = 3_600_101
    expect(store.summary()?.state).toBe("expired")
    expect(store.summary()?.expiresAt).toBe(3_600_100)
    expect(storage.writes()).toBe(before)
    expect(new ComputerUseLeaseStore(storage, () => now).summary()).toBeNull()
  })
})
