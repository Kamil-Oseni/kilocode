import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { next } from "@/kilocode/task/cron"
import { PlanArtifact } from "@/kilocode/plan-artifact"
import { english } from "@/kilocode/tool/schedule-task"

function memory() {
  const data = new Map<string, unknown>()
  return {
    read<T>(key: string[]) {
      return Effect.gen(function* () {
        const found = data.get(key.join("/"))
        if (found === undefined) return yield* new Storage.NotFoundError({ message: "missing" })
        return found as T
      })
    },
    write(key: string[], value: unknown) {
      return Effect.sync(() => {
        data.set(key.join("/"), value)
      })
    },
    remove(key: string[]) {
      return Effect.sync(() => {
        data.delete(key.join("/"))
      })
    },
    update<T>(key: string[], fn: (draft: T) => void) {
      return Effect.gen(function* () {
        const found = data.get(key.join("/")) as T
        fn(found)
        data.set(key.join("/"), found)
        return found
      })
    },
    list(prefix: string[]) {
      const start = prefix.join("/")
      return Effect.sync(() =>
        [...data.keys()]
          .filter((key) => key.startsWith(start))
          .map((key) => key.split("/")),
      )
    },
  }
}

describe("RayaTask store", () => {
  test("creates a briefer, skips overlapping runs, and auto-disables after repeated blocks", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({
        name: "Briefer",
        role: "briefer",
        objective: "Summarize what changed",
        schedule: { kind: "once", at: Date.now() - 1000 },
      }),
    )
    expect(RayaTask.due(agent, Date.now())).toBe(agent.schedule.kind === "once" ? agent.schedule.at : undefined)
    await Effect.runPromise(
      tasks.record({
        id: "r1",
        agentID: agent.id,
        at: Date.now(),
        sessionID: SessionID.make("ses_test"),
        status: "running",
      }),
    )
    const running = (await Effect.runPromise(tasks.runsFor(agent.id))).at(-1)
    expect(RayaTask.due(agent, Date.now(), running)).toBeUndefined()
    for (const id of ["a", "b", "c"]) {
      await Effect.runPromise(
        tasks.record({
          id,
          agentID: agent.id,
          at: Date.now(),
          sessionID: SessionID.make("ses_test"),
          status: "blocked",
          blockedReason: "waiting on you",
        }),
      )
    }
    const paused = await Effect.runPromise(tasks.get(agent.id))
    expect(paused.enabled).toBe(false)
    expect(paused.note).toContain("waiting on you")
  })

  test("keeps accountant memory off the designer agent", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const books = await Effect.runPromise(
      tasks.create({
        name: "Books",
        role: "accountant",
        objective: "reconcile",
        capabilities: ["money"],
        schedule: { kind: "manual" },
      }),
    )
    const design = await Effect.runPromise(
      tasks.create({
        name: "Look",
        role: "designer",
        objective: "keep the system honest",
        schedule: { kind: "manual" },
      }),
    )
    await Effect.runPromise(tasks.remember(books.id, "Q3 receipts live in ledger.csv"))
    expect(await Effect.runPromise(tasks.recall(books.id))).toContain("ledger.csv")
    expect(await Effect.runPromise(tasks.recall(design.id))).toBe("")
  })

  test("accountant jobs require a money capability", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const exit = await Effect.runPromiseExit(
      tasks.create({
        name: "Books",
        role: "accountant",
        objective: "reconcile",
        schedule: { kind: "manual" },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("event schedules match a CI signal and skip overlap", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({
        name: "CI",
        role: "reviewer",
        objective: "Inspect the failed build",
        schedule: { kind: "event", source: "ci", filter: "main" },
      }),
    )
    expect(RayaTask.listen(agent, "ci", "main")).toBe(true)
    expect(RayaTask.listen(agent, "ci", "develop")).toBe(false)
    const hit = await Effect.runPromise(tasks.listenFor("ci", "main"))
    expect(hit.map((item) => item.id)).toEqual([agent.id])
  })

  test("parks a running agent as waiting on you", async () => {
    const sid = SessionID.make("ses_test")
    const runner = RayaTaskRunner.make({
      storage: memory(),
      sessions: {
        create: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      },
    })
    const agent = await Effect.runPromise(
      runner.tasks.create({
        name: "Briefer",
        role: "briefer",
        objective: "Summarize what changed",
        schedule: { kind: "manual" },
      }),
    )
    await Effect.runPromise(
      runner.tasks.record({
        id: "r1",
        agentID: agent.id,
        at: Date.now(),
        sessionID: sid,
        status: "running",
      }),
    )
    await Effect.runPromise(runner.park(sid, true))
    const last = (await Effect.runPromise(runner.tasks.runsFor(agent.id))).at(-1)
    expect(last?.status).toBe("blocked")
    expect(last?.blockedReason).toBe("waiting on you")
    await Effect.runPromise(runner.park(sid, false))
    expect((await Effect.runPromise(runner.tasks.runsFor(agent.id))).at(-1)?.status).toBe("running")
  })

  test("removes a routine from the roster", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({
        name: "Temp",
        role: "coder",
        objective: "ship",
        schedule: { kind: "manual" },
      }),
    )
    expect(await Effect.runPromise(tasks.remove(agent.id))).toBe(true)
    const exit = await Effect.runPromiseExit(tasks.get(agent.id))
    expect(exit._tag).toBe("Failure")
  })

  test("stores a custom role, model, and full access", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({
        name: "Ops",
        role: "ops",
        objective: "watch deploys",
        schedule: { kind: "manual" },
        model: { providerID: "anthropic", id: "claude" },
        access: "full",
      }),
    )
    expect(agent.role).toBe("ops")
    expect(agent.model?.id).toBe("claude")
    expect(agent.access).toBe("full")
    expect(RayaTask.brief(agent)).toBe(false)
    expect(RayaTask.rules(agent).some((rule) => rule.permission === "edit" && rule.action === "allow")).toBe(true)
  })

  test("briefer sessions deny file edits unless access is full", () => {
    expect(RayaTask.brief({ role: "briefer" })).toBe(true)
    expect(RayaTask.brief({ role: "inbox" })).toBe(false)
    expect(RayaTask.brief({ role: "briefer", access: "full" })).toBe(false)
    const denied = RayaTask.rules({ role: "briefer" })
    expect(denied.some((rule) => rule.permission === "edit" && rule.action === "deny")).toBe(true)
  })
})

describe("cron and plain English schedules", () => {
  test("finds the next weekday 18:00 after a Thursday evening", () => {
    const thursday = Date.parse("2026-09-03T18:01:00Z")
    const at = next("0 18 * * 1-5", thursday)
    expect(new Date(at).getUTCDay()).toBeGreaterThanOrEqual(1)
  })

  test("translates weekday evening English to cron", () => {
    expect(english("every weekday at 6pm")).toEqual({ kind: "cron", expr: "0 18 * * 1-5" })
    expect(english("just when I ask")).toEqual({ kind: "manual" })
    expect(english("every time CI fails on main")).toEqual({ kind: "event", source: "ci", filter: "main" })
  })
})

describe("PlanArtifact", () => {
  test("derives stable step ids from markdown", () => {
    const plan = PlanArtifact.parse("# Fix login\n\nDo the auth flow.\n\n1. Add the form\n2. Wire the API\n")
    expect(plan.title).toBe("Fix login")
    expect(plan.steps.length).toBe(2)
    expect(plan.steps[0]!.id).toBe(PlanArtifact.id("Add the form", 0))
    expect(PlanArtifact.sidecar("foo.md")).toBe("foo.plan.json")
    const marked = PlanArtifact.mark(plan, plan.steps[0]!.id, "done", "shipped")
    expect(marked.steps[0]!.status).toBe("done")
    expect(marked.steps[0]!.note).toBe("shipped")
  })
})
