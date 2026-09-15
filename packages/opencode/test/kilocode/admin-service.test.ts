import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { RayaAdminService } from "@/kilocode/admin/service"

const at = 1_800_000_000_000

describe("Raya admin health service", () => {
  test("reads each authoritative source once and composes its existing signals", async () => {
    const reads = { sessions: 0, agents: 0, histories: 0, browser: 0, voice: 0 }
    const service = RayaAdminService.make({
      runtime: () => "connected",
      sessions: {
        list: () => {
          reads.sessions++
          return Effect.succeed([])
        },
      },
      tasks: {
        list: () => {
          reads.agents++
          return Effect.succeed([{ execution: { state: "active" as const } }])
        },
        histories: () => {
          reads.histories++
          return Effect.succeed({ items: [], failed: [] })
        },
      },
      browser: () => {
        reads.browser++
        return { status: "ready" }
      },
      voice: () => {
        reads.voice++
        return { available: true, states: [{ info: { status: "active" }, incomplete: false }] }
      },
      clock: () => at,
    })

    const snapshot = await service.snapshot()
    expect(reads).toEqual({ sessions: 1, agents: 1, histories: 1, browser: 1, voice: 1 })
    expect(snapshot.items.map((item) => [item.id, item.status, item.reason])).toEqual([
      ["runtime", "healthy", "ready"],
      ["sessions", "healthy", "ready"],
      ["routines", "healthy", "ready"],
      ["agents", "healthy", "ready"],
      ["browser", "healthy", "ready"],
      ["voice", "healthy", "ready"],
    ])
  })

  test("keeps disconnected output useful without reading backend-owned stores", async () => {
    const reads = { sessions: 0, tasks: 0 }
    const service = RayaAdminService.make({
      runtime: () => "disconnected",
      sessions: {
        list: () => {
          reads.sessions++
          return Effect.succeed([])
        },
      },
      tasks: {
        list: () => {
          reads.tasks++
          return Effect.succeed([])
        },
        histories: () => {
          reads.tasks++
          return Effect.succeed({ items: [], failed: [] })
        },
      },
      browser: () => ({ status: "locked" }),
      clock: () => at,
    })

    const snapshot = await service.snapshot()
    expect(reads).toEqual({ sessions: 0, tasks: 0 })
    expect(snapshot.items.map((item) => [item.id, item.status, item.reason])).toEqual([
      ["runtime", "offline", "disconnected"],
      ["sessions", "offline", "disconnected"],
      ["routines", "unknown", "disconnected"],
      ["agents", "unknown", "disconnected"],
      ["browser", "blocked", "browser-locked"],
      ["voice", "unknown", "not-checked"],
    ])
  })

  test("contains source failures and never emits their details", async () => {
    const service = RayaAdminService.make({
      runtime: () => "connected",
      sessions: {
        list: () => Effect.fail(new Error("C:/private/session-store synthetic-session-secret")),
      },
      tasks: {
        list: () => Effect.fail(new Error("synthetic-task-secret")),
        histories: () => Effect.succeed({ items: [], failed: [] }),
      },
      browser: () => Promise.reject(new Error("https://private.example/?token=synthetic-browser-secret")),
      voice: () => Promise.reject(new Error("synthetic-voice-secret")),
      clock: () => at,
    })

    const snapshot = await service.snapshot()
    expect(snapshot.items.map((item) => [item.id, item.status, item.reason])).toEqual([
      ["runtime", "healthy", "ready"],
      ["sessions", "degraded", "storage-unreadable"],
      ["routines", "unknown", "probe-failed"],
      ["agents", "unknown", "probe-failed"],
      ["browser", "unknown", "probe-failed"],
      ["voice", "unknown", "probe-failed"],
    ])
    expect(JSON.stringify(snapshot)).not.toContain("synthetic")
    expect(JSON.stringify(snapshot)).not.toContain("private")
  })
})
