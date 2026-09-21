import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { RayaAdminLog } from "@/kilocode/admin/log"
import { RayaAdminService } from "@/kilocode/admin/service"

const at = 1_800_000_000_000

describe("Raya admin health service", () => {
  test("reads each authoritative source once and composes its existing signals", async () => {
    const reads = {
      sessions: 0,
      goals: 0,
      scheduler: 0,
      agents: 0,
      histories: 0,
      organizations: 0,
      skills: 0,
      todos: 0,
      contacts: 0,
      memory: 0,
      canvas: 0,
      browser: 0,
      voice: 0,
    }
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
      goals: () => {
        reads.goals++
        return { goals: 2, active: 1, paused: 1, blocked: 0, failed: 0, incomplete: 0 }
      },
      scheduler: () => {
        reads.scheduler++
        return {
          queued: 1,
          active: 1,
          recovering: 0,
          claims: 1,
          staged: 0,
          pending: 1,
          stranded: 0,
          failed: 0,
          incomplete: 0,
        }
      },
      organizations: () => reads.organizations++,
      skills: () => reads.skills++,
      todos: () => reads.todos++,
      contacts: () => reads.contacts++,
      memory: () => reads.memory++,
      canvas: () => reads.canvas++,
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
    expect(reads).toEqual({
      sessions: 1,
      goals: 1,
      scheduler: 1,
      agents: 1,
      histories: 1,
      organizations: 1,
      skills: 1,
      todos: 1,
      contacts: 1,
      memory: 1,
      canvas: 1,
      browser: 1,
      voice: 1,
    })
    expect(snapshot.items.map((item) => [item.id, item.status, item.reason])).toEqual([
      ["runtime", "healthy", "ready"],
      ["sessions", "healthy", "ready"],
      ["goals", "healthy", "ready"],
      ["routines", "healthy", "ready"],
      ["organizations", "healthy", "ready"],
      ["scheduler", "healthy", "ready"],
      ["agents", "healthy", "ready"],
      ["skills", "healthy", "ready"],
      ["todos", "healthy", "ready"],
      ["contacts", "healthy", "ready"],
      ["browser", "healthy", "ready"],
      ["computer", "unknown", "not-checked"],
      ["voice", "healthy", "ready"],
      ["memory", "healthy", "ready"],
      ["canvas", "healthy", "ready"],
      ["sync", "unknown", "not-checked"],
      ["updates", "unknown", "not-checked"],
    ])
    expect(events).toHaveLength(28)
    for (const id of [
      "runtime",
      "sessions",
      "goals",
      "scheduler",
      "routines",
      "organizations",
      "agents",
      "skills",
      "todos",
      "contacts",
      "browser",
      "voice",
      "memory",
      "canvas",
    ] as const) {
      expect(events.filter((event) => event.subsystem === id).map((event) => event.code)).toEqual([
        "probe.started",
        "probe.completed",
      ])
    }

    await service.snapshot()
    expect(events).toHaveLength(56)
  })

  test("keeps disconnected output useful without reading backend-owned stores", async () => {
    const reads = { sessions: 0, tasks: 0, checks: 0 }
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
      organizations: () => reads.checks++,
      skills: () => reads.checks++,
      todos: () => reads.checks++,
      contacts: () => reads.checks++,
      memory: () => reads.checks++,
      canvas: () => reads.checks++,
      browser: () => ({ status: "locked" }),
      clock: () => at,
    })

    const snapshot = await service.snapshot()
    expect(reads).toEqual({ sessions: 0, tasks: 0, checks: 0 })
    expect(snapshot.items.map((item) => [item.id, item.status, item.reason])).toEqual([
      ["runtime", "offline", "disconnected"],
      ["sessions", "offline", "disconnected"],
      ["goals", "unknown", "disconnected"],
      ["routines", "unknown", "disconnected"],
      ["organizations", "unknown", "disconnected"],
      ["scheduler", "unknown", "disconnected"],
      ["agents", "unknown", "disconnected"],
      ["skills", "unknown", "disconnected"],
      ["todos", "unknown", "disconnected"],
      ["contacts", "unknown", "disconnected"],
      ["browser", "blocked", "browser-locked"],
      ["computer", "unknown", "not-checked"],
      ["voice", "unknown", "not-checked"],
      ["memory", "unknown", "disconnected"],
      ["canvas", "unknown", "disconnected"],
      ["sync", "unknown", "not-checked"],
      ["updates", "unknown", "not-checked"],
    ])
  })

  test("contains source failures and never emits their details", async () => {
    const events: RayaAdminLog.Input[] = []
    const service = RayaAdminService.make({
      runtime: () => "connected",
      sessions: {
        list: () => Effect.die(new Error("C:/private/session-store synthetic-session-secret")),
      },
      tasks: {
        list: () => Effect.die(new Error("synthetic-task-secret")),
        histories: () => Effect.succeed({ items: [], failed: [] }),
      },
      goals: () => Promise.reject(new Error("C:/private/goals synthetic-goal-secret")),
      scheduler: () => Promise.reject(new Error("C:/private/scheduler synthetic-scheduler-secret")),
      organizations: () => Promise.reject(new Error("C:/private/organizations synthetic-organization-secret")),
      skills: () => Promise.reject(new Error("C:/private/skills synthetic-skill-secret")),
      todos: () => Promise.reject(new Error("C:/private/todos synthetic-todo-secret")),
      contacts: () => Promise.reject(new Error("C:/private/contacts synthetic-contact-secret")),
      memory: () => Promise.reject(new Error("C:/private/memory synthetic-memory-secret")),
      canvas: () => Promise.reject(new Error("C:/private/canvas synthetic-canvas-secret")),
      browser: () => Promise.reject(new Error("https://private.example/?token=synthetic-browser-secret")),
      voice: () => Promise.reject(new Error("synthetic-voice-secret")),
      report: (event) => events.push(event),
      clock: () => at,
    })

    const snapshot = await service.snapshot()
    expect(snapshot.items.map((item) => [item.id, item.status, item.reason])).toEqual([
      ["runtime", "healthy", "ready"],
      ["sessions", "degraded", "storage-unreadable"],
      ["goals", "unknown", "probe-failed"],
      ["routines", "unknown", "probe-failed"],
      ["organizations", "unknown", "probe-failed"],
      ["scheduler", "unknown", "probe-failed"],
      ["agents", "unknown", "probe-failed"],
      ["skills", "unknown", "probe-failed"],
      ["todos", "unknown", "probe-failed"],
      ["contacts", "unknown", "probe-failed"],
      ["browser", "unknown", "probe-failed"],
      ["computer", "unknown", "not-checked"],
      ["voice", "unknown", "probe-failed"],
      ["memory", "unknown", "probe-failed"],
      ["canvas", "unknown", "probe-failed"],
      ["sync", "unknown", "not-checked"],
      ["updates", "unknown", "not-checked"],
    ])
    expect(JSON.stringify(snapshot)).not.toContain("synthetic")
    expect(JSON.stringify(snapshot)).not.toContain("private")
    expect(
      events
        .filter((event) => event.code === "probe.failed")
        .map((event) => event.subsystem)
        .sort(),
    ).toEqual([
      "agents",
      "browser",
      "canvas",
      "contacts",
      "goals",
      "memory",
      "organizations",
      "routines",
      "scheduler",
      "skills",
      "todos",
      "voice",
    ])
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
      ["goals", "unknown", "not-checked"],
      ["routines", "healthy", "ready"],
      ["organizations", "unknown", "not-checked"],
      ["scheduler", "unknown", "not-checked"],
      ["agents", "healthy", "ready"],
      ["skills", "unknown", "not-checked"],
      ["todos", "unknown", "not-checked"],
      ["contacts", "unknown", "not-checked"],
      ["browser", "unknown", "not-checked"],
      ["computer", "unknown", "not-checked"],
      ["voice", "unknown", "not-checked"],
      ["memory", "unknown", "not-checked"],
      ["canvas", "unknown", "not-checked"],
      ["sync", "unknown", "not-checked"],
      ["updates", "unknown", "not-checked"],
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
          return Effect.die(new Error("C:/private/routines?token=synthetic-history-secret"))
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
