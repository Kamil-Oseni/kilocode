import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { RayaAdminLog } from "@/kilocode/admin/log"
import { RayaAdminService } from "@/kilocode/admin/service"

const at = 1_800_000_000_000

describe("Raya admin health service", () => {
  test("reads each authoritative source once and composes its existing signals", async () => {
    const reads = { sessions: 0, agents: 0, histories: 0, browser: 0, voice: 0 }
    const events: RayaAdminLog.Input[] = []
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
      report: (event) => events.push(event),
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
    expect(events).toHaveLength(12)
    for (const id of ["runtime", "sessions", "routines", "agents", "browser", "voice"] as const) {
      expect(events.filter((event) => event.subsystem === id).map((event) => event.code)).toEqual([
        "probe.started",
        "probe.completed",
      ])
    }

    await service.snapshot()
    expect(events).toHaveLength(24)
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
    const events: RayaAdminLog.Input[] = []
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
      report: (event) => events.push(event),
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
    expect(
      events
        .filter((event) => event.code === "probe.failed")
        .map((event) => event.subsystem)
        .sort(),
    ).toEqual(["agents", "browser", "routines", "voice"])
    expect(JSON.stringify(events)).not.toContain("synthetic")
    expect(JSON.stringify(events)).not.toContain("private")
  })

  test("diagnostic sink failure cannot turn a healthy probe into an outage", async () => {
    const service = RayaAdminService.make({
      runtime: () => "connected",
      sessions: { list: () => Effect.succeed([]) },
      tasks: {
        list: () => Effect.succeed([]),
        histories: () => Effect.succeed({ items: [], failed: [] }),
      },
      report: () => Promise.reject(new Error("C:/private/log?token=synthetic-log-secret")),
      clock: () => at,
    })

    const snapshot = await service.snapshot()
    expect(snapshot.items.map((item) => [item.id, item.status, item.reason])).toEqual([
      ["runtime", "healthy", "ready"],
      ["sessions", "healthy", "ready"],
      ["routines", "healthy", "ready"],
      ["agents", "healthy", "ready"],
      ["browser", "unknown", "not-checked"],
      ["voice", "unknown", "not-checked"],
    ])
    expect(JSON.stringify(snapshot)).not.toContain("synthetic")
    expect(JSON.stringify(snapshot)).not.toContain("private")
  })

  test("keeps agent health when routine history alone fails", async () => {
    const reads = { agents: 0, histories: 0 }
    const service = RayaAdminService.make({
      runtime: () => "connected",
      sessions: { list: () => Effect.succeed([]) },
      tasks: {
        list: () => {
          reads.agents++
          return Effect.succeed([
            { execution: { state: "active" as const } },
            { execution: { state: "recovery" as const, runID: "private-run" } },
          ])
        },
        histories: () => {
          reads.histories++
          return Effect.fail(new Error("C:/private/routines?token=synthetic-history-secret"))
        },
      },
      clock: () => at,
    })

    const snapshot = await service.snapshot()
    expect(reads).toEqual({ agents: 1, histories: 1 })
    expect(snapshot.items.find((item) => item.id === "routines")).toEqual({
      id: "routines",
      status: "unknown",
      reason: "probe-failed",
      observedAt: at,
    })
    expect(snapshot.items.find((item) => item.id === "agents")).toEqual({
      id: "agents",
      status: "degraded",
      reason: "agent-recovery",
      observedAt: at,
      metrics: { agents: 2, active: 1, recovering: 1 },
    })
    expect(JSON.stringify(snapshot)).not.toContain("synthetic")
    expect(JSON.stringify(snapshot)).not.toContain("private")
  })
})
