import { describe, expect, test } from "bun:test"
import { RayaAdminLog } from "@/kilocode/admin/log"

describe("Raya admin diagnostic log", () => {
  test("projects only closed fields and strips raw diagnostic content", () => {
    const store = RayaAdminLog.make({ clock: () => 1_800_000_000_000 })
    const entry = store.write({
      subsystem: "sessions",
      severity: "warning",
      code: "storage.checked",
      fields: {
        count: 3,
        state: "degraded",
        reason: "storage-unreadable",
        source: "sessions",
        version: "1.2.3",
        path: "C:/private/workspace",
        message: "synthetic message body",
        credential: "synthetic-secret",
      },
      directory: "C:/private/workspace",
      authorization: "Bearer synthetic-token",
      get error() {
        throw new Error("raw errors must not be inspected")
      },
    })

    expect(entry).toEqual({
      seq: 1,
      at: 1_800_000_000_000,
      subsystem: "sessions",
      severity: "warning",
      code: "storage.checked",
      fields: {
        count: 3,
        state: "degraded",
        reason: "storage-unreadable",
        source: "sessions",
        version: "1.2.3",
      },
    })
    expect(JSON.stringify(entry)).not.toContain("synthetic")
    expect(JSON.stringify(entry)).not.toContain("private")
  })

  test("rejects unknown codes and unsafe values in allowlisted fields", () => {
    const store = RayaAdminLog.make()
    expect(store.write({ subsystem: "runtime", severity: "debug", code: "probe.started" })).toBeUndefined()
    expect(store.write({ subsystem: "runtime", severity: "info", code: "raw.error" })).toBeUndefined()
    expect(
      store.write({
        subsystem: "runtime",
        severity: "error",
        code: "probe.failed",
        fields: { source: "C:/private/workspace" },
      }),
    ).toBeUndefined()
    expect(
      store.write({
        subsystem: "runtime",
        severity: "info",
        code: "probe.completed",
        fields: { version: "1.2.3+" + "x".repeat(100) },
      }),
    ).toBeUndefined()
    expect(
      store.write({
        subsystem: "runtime",
        severity: "info",
        code: "probe.completed",
        fields: { durationMs: 600_001 },
      }),
    ).toBeUndefined()
    expect(store.list()).toEqual([])
  })

  test("caps retained entries and reads by monotonic sequence order", () => {
    const times = [30, 10, 10, 5]
    let index = 0
    const store = RayaAdminLog.make({ capacity: 3, clock: () => times[index++] })
    for (const count of [1, 2, 3, 4]) {
      expect(
        store.write({
          subsystem: "runtime",
          severity: "info",
          code: "probe.completed",
          fields: { count },
        }),
      ).toBeDefined()
    }

    expect(store.list().map((entry) => [entry.seq, entry.at, entry.fields?.count])).toEqual([
      [2, 10, 2],
      [3, 10, 3],
      [4, 5, 4],
    ])
    expect(store.list({ after: 2, limit: 1 }).map((entry) => entry.seq)).toEqual([3])
  })

  test("returns the newest bounded page unless a forward cursor is explicit", () => {
    const store = RayaAdminLog.make({ capacity: 5, clock: () => 1 })
    for (const count of [1, 2, 3, 4, 5]) {
      store.write({
        subsystem: "runtime",
        severity: "info",
        code: "probe.completed",
        fields: { count },
      })
    }

    expect(store.list({ limit: 2 }).map((entry) => entry.seq)).toEqual([4, 5])
    expect(store.list({ after: 0, limit: 2 }).map((entry) => entry.seq)).toEqual([1, 2])
    expect(store.list({ after: 2, limit: 2 }).map((entry) => entry.seq)).toEqual([3, 4])
  })

  test("returns copies so readers cannot mutate retained diagnostics", () => {
    const store = RayaAdminLog.make({ clock: () => 1 })
    const entry = store.write({
      subsystem: "voice",
      severity: "error",
      code: "probe.failed",
      fields: { reason: "voice-failed" },
    })
    if (!entry?.fields) throw new Error("expected diagnostic fields")
    expect(Reflect.set(entry.fields, "reason", "ready")).toBe(true)
    expect(store.list()[0].fields?.reason).toBe("voice-failed")
  })
})
