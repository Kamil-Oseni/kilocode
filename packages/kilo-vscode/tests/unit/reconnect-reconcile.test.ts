import { describe, expect, it } from "bun:test"
import { RECONNECT_CONCURRENCY, RECONNECT_LIMIT, reconcile } from "../../src/kilo-provider/reconnect-reconcile"

function deferred() {
  const gates: Array<() => void> = []
  return {
    gates,
    load: () => new Promise<void>((resolve) => gates.push(resolve)),
  }
}

describe("reconnect transcript reconciliation", () => {
  it("prioritizes focus, removes duplicates, and caps request concurrency", async () => {
    const gate = deferred()
    const started: string[] = []
    let active = 0
    let peak = 0
    const ids = Array.from({ length: 60 }, (_, index) => `session-${index}`)
    ids.push("session-20", "session-0")

    const work = reconcile({
      ids,
      focused: "session-20",
      valid: () => true,
      load: async (id) => {
        started.push(id)
        active += 1
        peak = Math.max(peak, active)
        await gate.load()
        active -= 1
      },
    })

    while (started.length < RECONNECT_CONCURRENCY) await Promise.resolve()
    expect(started[0]).toBe("session-20")
    expect(peak).toBe(RECONNECT_CONCURRENCY)

    while (gate.gates.length) gate.gates.shift()!()
    while (started.length < RECONNECT_LIMIT) {
      await Promise.resolve()
      while (gate.gates.length) gate.gates.shift()!()
    }
    while (gate.gates.length) gate.gates.shift()!()
    await work

    expect(started).toHaveLength(RECONNECT_LIMIT)
    expect(new Set(started).size).toBe(RECONNECT_LIMIT)
    expect(peak).toBe(RECONNECT_CONCURRENCY)
  })

  it("stops queued reads when a newer connection generation wins", async () => {
    const gate = deferred()
    const started: string[] = []
    let valid = true
    const work = reconcile({
      ids: Array.from({ length: 20 }, (_, index) => `session-${index}`),
      valid: () => valid,
      load: async (id) => {
        started.push(id)
        await gate.load()
      },
    })

    while (started.length < RECONNECT_CONCURRENCY) await Promise.resolve()
    valid = false
    while (gate.gates.length) gate.gates.shift()!()
    await work

    expect(started).toHaveLength(RECONNECT_CONCURRENCY)
  })
})
