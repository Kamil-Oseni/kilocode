import { afterAll, describe, expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { hostname } from "node:os"
import path from "node:path"
import { existsSync } from "node:fs"
import { Storage } from "@/storage/storage"
import { Permission } from "@/permission"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { next } from "@/kilocode/task/cron"
import { PlanArtifact } from "@/kilocode/plan-artifact"
import { english } from "@/kilocode/tool/schedule-task"
import { GlobalBus } from "@/bus/global"
import { tmpdir } from "../fixture/fixture"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"

const scope = await Effect.runPromise(Scope.make())
const database = Context.get(
  await Effect.runPromise(
    Layer.build(Database.layerFromPath(":memory:")).pipe(Effect.provideService(Scope.Scope, scope)),
  ),
  Database.Service,
)
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))))

function memory() {
  const data = new Map<string, unknown>()
  return {
    create: (key: string[], value: unknown) =>
      Effect.sync(() => {
        const id = key.join("/")
        if (data.has(id)) return false
        data.set(id, value)
        return true
      }),
    replace: (key: string[], value: unknown) =>
      Effect.sync(() => {
        data.set(key.join("/"), value)
      }),
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
      return Effect.sync(() => [...data.keys()].filter((key) => key.startsWith(start)).map((key) => key.split("/")))
    },
  }
}

describe("RayaTask store", () => {
  test("settled criterion outcomes survive reopening and later goal changes", async () => {
    await using directory = await tmpdir()
    const sid = SessionID.make("ses_criterion_outcomes")
    const now = Date.now()
    const id = await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const runner = RayaTaskRunner.make({
          database,
          storage,
          sessions: {
            create: () => Effect.die("must not create another session"),
            get: () => Effect.die("unused"),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          },
        })
        const agent = yield* runner.tasks.create({ name: "Review", objective: "Work", schedule: { kind: "manual" } })
        const state = {
          objective: "Work",
          status: "complete",
          createdAt: now,
          updatedAt: now,
          usage: { turns: 1, continuations: 0, toolCalls: 1 },
          progress: [],
          criteria: [
            { id: "required", description: "Required output", verification: "Inspect output" },
            { id: "optional", description: "Optional output", verification: "Inspect extra", required: false },
          ],
          audit: {
            summary: "Required output delivered",
            verifiedAt: now,
            requirements: [
              {
                criterionID: "required",
                requirement: "Required output",
                passed: true,
                evidence: [{ callID: "read", summary: "Output inspected" }],
              },
              { criterionID: "optional", requirement: "Optional output", passed: false, evidence: [] },
            ],
          },
        }
        yield* storage.write(["raya", "goal", sid], state)
        yield* runner.tasks.record({ id: "run", agentID: agent.id, sessionID: sid, at: now, status: "running" })
        yield* runner.settle(sid)
        const [saved] = yield* runner.tasks.runsFor(agent.id)
        expect(saved.outcome?.verification).toEqual({
          at: now,
          requirements: [
            {
              criterionID: "required",
              requirement: "Required output",
              verification: "Inspect output",
              required: true,
              passed: true,
              evidence: ["Output inspected"],
            },
            {
              criterionID: "optional",
              requirement: "Optional output",
              verification: "Inspect extra",
              required: false,
              passed: false,
              evidence: [],
            },
          ],
        })
        yield* storage.write(["raya", "goal", sid], { ...state, audit: undefined, criteria: undefined })
        yield* runner.settle(sid)
        expect((yield* runner.tasks.runsFor(agent.id))[0]).toEqual(saved)
        yield* runner.tasks.record({ id: "legacy", agentID: agent.id, sessionID: sid, at: now + 1, status: "running" })
        yield* runner.settle(sid)
        expect((yield* runner.tasks.runsFor(agent.id))[1].outcome?.verification).toBeUndefined()
        return agent.id
      }).pipe(
        Effect.provide(Storage.layerFromDir(directory.path)),
        Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node]))),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const rows = yield* tasks.runsFor(id)
        expect(rows[0].outcome?.verification?.at).toBe(now)
        expect(rows[0].outcome?.verification?.requirements[1]).toMatchObject({
          required: false,
          passed: false,
          evidence: [],
        })
        expect(rows[1].outcome?.verification).toBeUndefined()
      }).pipe(
        Effect.provide(Storage.layerFromDir(directory.path)),
        Effect.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node]))),
      ),
    )
  })

  test("trigger evidence is immutable and survives legacy-style history updates", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Timer", objective: "Work", schedule: { kind: "once", at: 1000 } }),
    )
    const trigger = { kind: "timer" as const, id: "occurrence", scheduledAt: 1000, observedAt: 5000 }
    const run = await Effect.runPromise(
      tasks.record({
        id: "run",
        agentID: agent.id,
        sessionID: SessionID.make("ses_trigger"),
        at: 6000,
        status: "running",
        trigger,
      }),
    )
    expect(await Effect.runPromise(tasks.transition(run, { ...run, trigger: { ...trigger, scheduledAt: 2000 } }))).toBe(
      false,
    )
    expect(
      Exit.isFailure(await Effect.runPromiseExit(tasks.record({ ...run, trigger: { ...trigger, id: "different" } }))),
    ).toBe(true)
    expect((await Effect.runPromise(tasks.record({ ...run, trigger: undefined, status: "complete" }))).trigger).toEqual(
      trigger,
    )
    expect((await Effect.runPromise(tasks.runsFor(agent.id)))[0]?.trigger).toEqual(trigger)
    expect((await Effect.runPromise(tasks.runsFor(agent.id)))[0]?.at).toBe(6000)
    expect(Exit.isFailure(await Effect.runPromiseExit(tasks.record({ ...run, at: 7000 })))).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          tasks.record({ ...run, id: "invalid", trigger: { ...trigger, scheduledAt: Infinity } }),
        ),
      ),
    ).toBe(true)
  })

  test("manual starts do not consume a timer and cannot evict its later consumption evidence", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at: 2000 } }),
    )
    const manual = await Effect.runPromise(
      tasks.record({
        id: "manual",
        agentID: agent.id,
        sessionID: SessionID.make("ses_manual"),
        at: 1000,
        status: "running",
        trigger: { kind: "manual" },
      }),
    )
    expect(await Effect.runPromise(tasks.ready(3000))).toEqual([])
    await Effect.runPromise(tasks.transition(manual, { ...manual, status: "complete" }))
    expect(await Effect.runPromise(tasks.occurrence(agent, 3000))).toBe(2000)
    expect((await Effect.runPromise(tasks.preview(3000)))[0]?.nextRun).toBe(2000)
    expect(RayaTask.due(agent, 3000, { ...manual, status: "complete" })).toBe(2000)
    await Effect.runPromise(
      tasks.record({
        id: "timer",
        agentID: agent.id,
        sessionID: SessionID.make("ses_timer"),
        at: 3000,
        status: "complete",
        trigger: { kind: "timer", id: "timer-occurrence", scheduledAt: 2000, observedAt: 2500 },
      }),
    )
    for (let index = 0; index < 55; index++)
      await Effect.runPromise(tasks.record({ ...manual, id: `manual-${index}`, at: 4000 + index, status: "complete" }))
    expect(await Effect.runPromise(tasks.ready(5000))).toEqual([])
    expect((await Effect.runPromise(tasks.runsFor(agent.id))).some((run) => run.id === "timer")).toBe(true)
  })

  test("calendar consumption uses the scheduled occurrence when the startup clock moved backward", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Calendar", objective: "Work", schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" } }),
    )
    const at = Date.parse("2030-01-01T09:00:00Z")
    const run = await Effect.runPromise(
      tasks.record({
        id: "timer",
        agentID: agent.id,
        sessionID: SessionID.make("ses_clock"),
        at: at - 60_000,
        status: "complete",
        trigger: { kind: "timer", id: "occurrence", scheduledAt: at, observedAt: at + 10_000 },
      }),
    )
    expect(await Effect.runPromise(tasks.occurrence(agent, at + 30_000))).toBeUndefined()
    expect(RayaTask.next(agent, at + 30_000, run)).toBe(at + 60_000)
    expect((await Effect.runPromise(tasks.preview(at + 30_000)))[0]?.nextRun).toBe(at + 60_000)
    expect(await Effect.runPromise(tasks.occurrence(agent, at + 60_000))).toBe(at + 60_000)
    for (let index = 0; index < 55; index++)
      await Effect.runPromise(
        tasks.record({
          ...run,
          id: `older-${index}`,
          at: at - 120_000,
          trigger: {
            kind: "timer",
            id: `older-occurrence-${index}`,
            scheduledAt: at - (index + 1) * 60_000,
            observedAt: at - 120_000,
          },
        }),
      )
    expect((await Effect.runPromise(tasks.runsFor(agent.id))).some((item) => item.id === run.id)).toBe(true)
    expect(await Effect.runPromise(tasks.occurrence(agent, at + 30_000))).toBeUndefined()
    expect((await Effect.runPromise(tasks.preview(at + 30_000)))[0]?.nextRun).toBe(at + 60_000)
  })

  test.each(["once", "cron", "event", "manual"] as const)(
    "persists %s trigger evidence before attempting session creation",
    async (kind) => {
      const storage = memory()
      const metadata: unknown[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: (input?: { metadata?: unknown }) =>
            Effect.sync(() => metadata.push(input?.metadata)).pipe(Effect.andThen(Effect.die("session write failed"))),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const at = Date.parse("2030-01-01T09:00:00Z")
      const observed = at + 30_000
      const schedule: RayaTask.Schedule =
        kind === "once"
          ? { kind, at }
          : kind === "cron"
            ? { kind, expr: "0 9 * * *", tz: "UTC" }
            : kind === "event"
              ? { kind, source: "ci", filter: "Feature/A" }
              : { kind }
      const agent = await Effect.runPromise(runner.tasks.create({ name: "Trigger", objective: "Work", schedule }))
      const before = Date.now()
      await Effect.runPromiseExit(
        kind === "once" || kind === "cron"
          ? runner.tick(observed)
          : kind === "event"
            ? runner.announce("ci", "Feature/A")
            : runner.fire(agent.id),
      )
      const keys = await Effect.runPromise(storage.list(["raya", "agent-claims"]))
      expect(keys).toHaveLength(1)
      const claim = await Effect.runPromise(
        storage.read<{ id: string; at: number; trigger: RayaTask.Trigger }>(keys[0]),
      )
      expect(metadata).toEqual([
        {
          rayaRoutine: {
            version: kind === "once" || kind === "cron" ? 2 : 1,
            agentID: agent.id,
            runID: claim.id,
            scheduleVersion: 1,
            trigger: claim.trigger,
          },
        },
      ])
      if (kind === "once" || kind === "cron") {
        expect(claim.trigger).toEqual({
          kind: "timer",
          id: `timer:${JSON.stringify([agent.id, 1, at])}`,
          scheduledAt: at,
          observedAt: observed,
          ...(kind === "cron" ? { tz: "UTC" } : {}),
        })
        expect(claim.at).not.toBe(at)
      }
      if (kind === "manual") expect(claim.trigger).toEqual({ kind: "manual" })
      if (kind === "event") {
        expect(claim.trigger).toMatchObject({ kind: "event", source: "ci", filter: "Feature/A" })
        if (claim.trigger.kind !== "event") throw new Error("Expected event receipt")
        expect(claim.trigger.receivedAt).toBeGreaterThanOrEqual(before)
        expect(claim.trigger.receivedAt).toBeLessThanOrEqual(Date.now())
      }
    },
  )
  test("schedule version exhaustion rejects a change without publishing it", async () => {
    const storage = memory()
    const tasks = RayaTask.make({ storage })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Full", objective: "Work", schedule: { kind: "manual" } }),
    )
    const prior = { ...agent, scheduleVersion: Number.MAX_SAFE_INTEGER }
    await Effect.runPromise(storage.replace(["raya", "agent"], [prior]))
    const rejected = await Effect.runPromise(
      tasks.update(agent.id, { schedule: { kind: "once", at: 2000 } }).pipe(Effect.flip),
    )
    expect(rejected.message).toContain("version limit")
    expect(await Effect.runPromise(tasks.get(agent.id))).toEqual(prior)
  })

  test("a changed one-shot gets a new occurrence while old unfinished work still excludes overlap", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at: 1000 } }),
    )
    const run = await Effect.runPromise(
      tasks.record({
        id: "old",
        agentID: agent.id,
        at: 1000,
        sessionID: SessionID.make("ses_old"),
        status: "running",
        scheduleVersion: agent.scheduleVersion,
      }),
    )
    const changed = await Effect.runPromise(tasks.update(agent.id, { schedule: { kind: "once", at: 2000 } }))
    expect(changed.scheduleVersion).toBe(2)
    expect(await Effect.runPromise(tasks.ready(2000))).toEqual([])
    expect(await Effect.runPromise(tasks.transition(run, { ...run, status: "complete" }))).toBe(true)
    expect((await Effect.runPromise(tasks.ready(2000))).map((item) => item.id)).toEqual([agent.id])
    expect((await Effect.runPromise(tasks.preview(1500)))[0]?.nextRun).toBe(2000)
    await Effect.runPromise(
      tasks.record({
        id: "new",
        agentID: agent.id,
        at: 2000,
        sessionID: SessionID.make("ses_new"),
        status: "complete",
        scheduleVersion: changed.scheduleVersion,
      }),
    )
    expect(await Effect.runPromise(tasks.ready(3000))).toEqual([])
  })

  test("ordinary edits and identical schedules do not rearm a completed one-shot", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at: 1000 } }),
    )
    await Effect.runPromise(
      tasks.record({
        id: "done",
        agentID: agent.id,
        at: 1000,
        sessionID: SessionID.make("ses_done"),
        status: "complete",
      }),
    )
    await Effect.runPromise(tasks.update(agent.id, { enabled: false }))
    const changed = await Effect.runPromise(
      tasks.update(agent.id, { enabled: true, name: "Renamed", schedule: agent.schedule }),
    )
    expect(changed.scheduleVersion).toBe(1)
    expect(changed.scheduleUpdatedAt).toBe(agent.scheduleUpdatedAt)
    expect(await Effect.runPromise(tasks.ready(3000))).toEqual([])
  })

  test("history retention and late older runs cannot rearm the newest consumed schedule", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at: 1000 } }),
    )
    await Effect.runPromise(tasks.update(agent.id, { schedule: { kind: "once", at: 2000 } }))
    await Effect.runPromise(
      tasks.record({
        id: "latest",
        agentID: agent.id,
        at: 2000,
        sessionID: SessionID.make("ses_latest"),
        status: "complete",
        scheduleVersion: 2,
      }),
    )
    for (const index of Array.from({ length: 55 }, (_, index) => index)) {
      await Effect.runPromise(
        tasks.record({
          id: `older-${index}`,
          agentID: agent.id,
          at: index,
          sessionID: SessionID.make(`ses_older_${index}`),
          status: "complete",
          scheduleVersion: 1,
        }),
      )
    }
    const history = await Effect.runPromise(tasks.runsFor(agent.id))
    expect(history).toHaveLength(51)
    expect(history.some((run) => run.id === "latest")).toBe(true)
    expect(await Effect.runPromise(tasks.ready(3000))).toEqual([])
  })

  test("old schedule failures do not disable a revised routine", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at: 1000 } }),
    )
    await Effect.runPromise(tasks.update(agent.id, { schedule: { kind: "once", at: 2000 } }))
    for (const index of [0, 1, 2]) {
      await Effect.runPromise(
        tasks.record({
          id: `failed-${index}`,
          agentID: agent.id,
          at: index,
          sessionID: SessionID.make(`ses_failed_${index}`),
          status: "blocked",
          blockedReason: "Old failure",
          scheduleVersion: 1,
        }),
      )
    }
    expect((await Effect.runPromise(tasks.get(agent.id))).enabled).toBe(true)
  })

  test("a new calendar version starts after its edit time", async () => {
    const storage = memory()
    const tasks = RayaTask.make({ storage })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Calendar", objective: "Work", schedule: { kind: "manual" } }),
    )
    await Effect.runPromise(storage.replace(["raya", "agent"], [{ ...agent, createdAt: 0 }]))
    const changed = await Effect.runPromise(
      tasks.update(agent.id, { schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" } }),
    )
    expect(await Effect.runPromise(tasks.ready(changed.scheduleUpdatedAt!))).toEqual([])
    expect((await Effect.runPromise(tasks.preview(changed.scheduleUpdatedAt!)))[0]?.nextRun).toBeGreaterThan(
      changed.scheduleUpdatedAt!,
    )
  })

  test("run versions are immutable and version preconditions detect an edit cycle", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Once", objective: "Work", schedule: { kind: "manual" } }),
    )
    await Effect.runPromise(tasks.update(agent.id, { schedule: { kind: "once", at: 2000 } }))
    const changed = await Effect.runPromise(tasks.update(agent.id, { schedule: agent.schedule }))
    expect(changed.scheduleVersion).toBe(3)
    const rejected = await Effect.runPromise(
      tasks.update(agent.id, { expectedScheduleVersion: 1, schedule: { kind: "once", at: 3000 } }).pipe(Effect.flip),
    )
    expect(rejected.message).toContain("version changed")
    const run = await Effect.runPromise(
      tasks.record({
        id: "started",
        agentID: agent.id,
        at: 1000,
        sessionID: SessionID.make("ses_started"),
        status: "running",
        scheduleVersion: 1,
      }),
    )
    expect(await Effect.runPromise(tasks.transition(run, { ...run, scheduleVersion: 3 }))).toBe(false)
    expect(Exit.isFailure(await Effect.runPromiseExit(tasks.record({ ...run, scheduleVersion: 3 })))).toBe(true)
    expect((await Effect.runPromise(tasks.runsFor(agent.id)))[0]).toEqual(run)
  })

  test("schedule preconditions reject stale changes and preserve unrelated edits", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const initial = await Effect.runPromise(
      tasks.create({ name: "Review", objective: "Review changes", schedule: { kind: "manual" } }),
    )
    await Effect.runPromise(tasks.update(initial.id, { name: "Renamed" }))
    const changed = await Effect.runPromise(
      tasks.update(initial.id, {
        expectedSchedule: initial.schedule,
        schedule: { kind: "cron", expr: "0 9 * * 1", tz: "UTC" },
      }),
    )
    expect(changed.name).toBe("Renamed")
    const rejected = await Effect.runPromise(
      tasks
        .update(initial.id, {
          expectedSchedule: initial.schedule,
          schedule: { kind: "manual" },
          name: "Stale name",
        })
        .pipe(Effect.flip),
    )
    expect(rejected.message).toContain("schedule changed")
    expect(await Effect.runPromise(tasks.get(initial.id))).toEqual(changed)
  })

  test("concurrent editors of one schedule have only one publication winner", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const initial = await Effect.runPromise(
      tasks.create({ name: "Review", objective: "Review changes", schedule: { kind: "manual" } }),
    )
    const results = await Promise.all(
      [
        { kind: "cron" as const, expr: "0 9 * * 1", tz: "UTC" },
        { kind: "cron" as const, expr: "0 9 * * 5", tz: "UTC" },
      ].map((schedule) =>
        Effect.runPromiseExit(tasks.update(initial.id, { schedule, expectedSchedule: initial.schedule })),
      ),
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
    const winner = results.find(Exit.isSuccess)
    if (!winner || Exit.isFailure(winner)) throw new Error("Missing successful update")
    expect(await Effect.runPromise(tasks.get(initial.id))).toEqual(winner.value)
  })

  test("missing workspace services reject a folder start before creating the folder", async () => {
    const dir = path.resolve(".tmp", `routine-unavailable-${crypto.randomUUID()}`)
    const attempts: string[] = []
    const storage = memory()
    const runner = RayaTaskRunner.make({
      database,
      storage,
      sessions: {
        create: () => Effect.sync(() => attempts.push("started")).pipe(Effect.andThen(Effect.die("unexpected start"))),
        get: () => Effect.die("unused"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      },
    })
    const agent = await Effect.runPromise(
      runner.tasks.create({ name: "Folder", objective: "Work", dir, schedule: { kind: "manual" } }),
    )
    const result = await Effect.runPromiseExit(runner.fire(agent.id))
    if (Exit.isSuccess(result)) throw new Error("Expected unavailable workspace service")
    expect(String(Cause.squash(result.cause))).toContain("Workspace services are unavailable")
    expect(attempts).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(await Effect.runPromise(storage.list(["raya", "agent-claims"]))).toEqual([])
  })

  test.each(["completed", "rescheduled", "manual", "event", "unchanged"])(
    "timer rechecks a %s routine after selection",
    async (change) => {
      const storage = memory()
      const selected = await Effect.runPromise(Deferred.make<void>())
      const release = await Effect.runPromise(Deferred.make<void>())
      const attempts: string[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage: {
          ...storage,
          create: (key, value) =>
            Effect.gen(function* () {
              if (key[1] === "agent-claims") {
                yield* Deferred.succeed(selected, undefined)
                yield* Deferred.await(release)
              }
              return yield* storage.create(key, value)
            }),
        },
        sessions: {
          create: () =>
            Effect.sync(() => attempts.push("started")).pipe(Effect.andThen(Effect.die("unexpected start"))),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const at = Date.now()
      const agent = await Effect.runPromise(
        runner.tasks.create({ name: "Once", objective: "Work", schedule: { kind: "once", at } }),
      )
      const pending = Effect.runPromiseExit(runner.tick(at))
      try {
        await Effect.runPromise(Deferred.await(selected).pipe(Effect.timeout("5 seconds")))
        if (change === "completed") {
          await Effect.runPromise(
            runner.tasks.record({
              id: "done",
              agentID: agent.id,
              sessionID: SessionID.make("ses_done"),
              at,
              status: "complete",
            }),
          )
        }
        if (change === "rescheduled")
          await Effect.runPromise(runner.tasks.update(agent.id, { schedule: { kind: "once", at: at + 60_000 } }))
        if (change === "manual")
          await Effect.runPromise(runner.tasks.update(agent.id, { schedule: { kind: "manual" } }))
        if (change === "event")
          await Effect.runPromise(runner.tasks.update(agent.id, { schedule: { kind: "event", source: "ci" } }))
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined))
      }
      const result = await pending
      expect(attempts).toEqual(change === "unchanged" ? ["started"] : [])
      expect(Exit.isSuccess(result)).toBe(change !== "unchanged")
      expect(await Effect.runPromise(storage.list(["raya", "agent-claims"]))).toHaveLength(
        change === "unchanged" ? 1 : 0,
      )
    },
  )

  test("a permission event already queued before unsubscribe cannot start work after closure", async () => {
    const storage = memory()
    const prior = GlobalBus.listeners("event")
    const reads: string[][] = []
    const listener = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* RayaTaskRunner.subscribe({
            storage: {
              ...storage,
              read: <T>(key: string[]) => Effect.sync(() => reads.push(key)).pipe(Effect.andThen(storage.read<T>(key))),
            },
            bus: { subscribeCallback: () => Effect.succeed(() => undefined) },
            sessions: {
              create: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              messages: () => Effect.succeed([]),
              children: () => Effect.succeed([]),
            },
          })
          const listener = GlobalBus.listeners("event").find((item) => !prior.includes(item))
          if (!listener) throw new Error("Expected permission listener")
          return listener
        }),
      ),
    )
    const count = reads.length
    listener({ payload: { type: "permission.asked", properties: { sessionID: "ses_late" } } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(reads).toHaveLength(count)
  })

  test("closing a routine subscription interrupts a permission callback already in progress", async () => {
    const storage = memory()
    const polled = await Effect.runPromise(Deferred.make<void>())
    const entered = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const finished = await Effect.runPromise(Deferred.make<void>())
    const interrupted: boolean[] = []
    let reads = 0
    let armed = false
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* RayaTaskRunner.subscribe({
              storage: {
                ...storage,
                read: <T>(key: string[]) =>
                  Effect.gen(function* () {
                    if (key[1] === "agent" && !armed && ++reads === 2) yield* Deferred.succeed(polled, undefined)
                    if (key[1] === "agent" && armed) {
                      yield* Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.onInterrupt(() => Effect.sync(() => interrupted.push(true))),
                        Effect.ensuring(Deferred.succeed(finished, undefined)),
                      )
                    }
                    return yield* storage.read<T>(key)
                  }),
              },
              bus: { subscribeCallback: () => Effect.succeed(() => undefined) },
              sessions: {
                create: () => Effect.die("unused"),
                get: () => Effect.die("unused"),
                messages: () => Effect.succeed([]),
                children: () => Effect.succeed([]),
              },
            })
            yield* Deferred.await(polled).pipe(Effect.timeout("5 seconds"))
            armed = true
            GlobalBus.emit("event", {
              payload: { type: "permission.asked", properties: { sessionID: "ses_callback" } },
            })
            yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
          }),
        ),
      )
      expect(interrupted).toEqual([true])
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await Effect.runPromise(Deferred.await(finished).pipe(Effect.timeout("5 seconds")))
    }
  })

  test("routine subscription removes both event listeners when its scope closes", async () => {
    const listeners = GlobalBus.listenerCount("event")
    const active: number[] = []
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* RayaTaskRunner.subscribe({
            storage: memory(),
            bus: {
              subscribeCallback: () =>
                Effect.sync(() => {
                  active.push(1)
                  return () => {
                    active.pop()
                  }
                }),
            },
            sessions: {
              create: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              messages: () => Effect.succeed([]),
              children: () => Effect.succeed([]),
            },
          })
          expect(GlobalBus.listenerCount("event")).toBe(listeners + 1)
          expect(active).toEqual([1])
        }),
      ),
    )
    expect(GlobalBus.listenerCount("event")).toBe(listeners)
    expect(active).toEqual([])
  })

  test("bounds dispatch workers and cancels queued and active work", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const at = Date.now()
    for (let index = 0; index < 9; index++) {
      await Effect.runPromise(tasks.create({ name: String(index), objective: "Work", schedule: { kind: "once", at } }))
    }
    const full = await Effect.runPromise(Deferred.make<void>())
    const hold = await Effect.runPromise(Deferred.make<void>())
    const started: string[] = []
    const finished: string[] = []
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(
      tasks.dispatch(at, (agent) =>
        Effect.gen(function* () {
          started.push(agent.id)
          if (started.length === 4) yield* Deferred.succeed(full, undefined)
          yield* Deferred.await(hold)
        }).pipe(Effect.ensuring(Effect.sync(() => finished.push(agent.id)))),
      ),
      { signal: controller.signal },
    )
    try {
      await Effect.runPromise(Deferred.await(full).pipe(Effect.timeout("5 seconds")))
      expect(started).toHaveLength(4)
      expect(finished).toHaveLength(0)
    } finally {
      controller.abort()
    }
    const result = await pending
    if (Exit.isSuccess(result)) throw new Error("Expected dispatch interruption")
    expect(Cause.hasInterrupts(result.cause)).toBe(true)
    expect(started).toHaveLength(4)
    expect(finished.sort()).toEqual(started.toSorted())
  })

  test("dispatches an eligible routine without waiting for another routine's history", async () => {
    const storage = memory()
    const blocked = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const delivered = await Effect.runPromise(Deferred.make<void>())
    const tasks = RayaTask.make({ storage })
    const at = Date.now()
    const slow = await Effect.runPromise(
      tasks.create({ name: "Slow", objective: "Work", schedule: { kind: "once", at } }),
    )
    const fast = await Effect.runPromise(
      tasks.create({ name: "Fast", objective: "Work", schedule: { kind: "once", at } }),
    )
    const dispatch = RayaTask.make({
      storage: {
        ...storage,
        read: <T>(key: string[]) =>
          Effect.gen(function* () {
            if (key[1] === "agent-runs" && key[2] === slow.id) {
              yield* Deferred.succeed(blocked, undefined)
              yield* Deferred.await(release)
            }
            return yield* storage.read<T>(key)
          }),
      },
    })
    const ids: string[] = []
    const pending = Effect.runPromise(
      dispatch.dispatch(at, (agent) =>
        Effect.gen(function* () {
          ids.push(agent.id)
          if (agent.id === fast.id) yield* Deferred.succeed(delivered, undefined)
        }),
      ),
    )
    try {
      await Effect.runPromise(Deferred.await(blocked).pipe(Effect.timeout("5 seconds")))
      await Effect.runPromise(Deferred.await(delivered).pipe(Effect.timeout("5 seconds")))
      expect(ids).toEqual([fast.id])
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await pending
    }
    expect(ids).toEqual([fast.id, slow.id])
  })

  test("rejects malformed calendar schedules before creating or changing a routine", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Manual", objective: "Work", schedule: { kind: "manual" } }),
    )
    for (const expr of ["0 25 * * *", "*/0 * * * *", "0 0 * * MON", "0 0 L * *", "0 0 30 2 *"]) {
      const schedule = { kind: "cron" as const, expr, tz: "UTC" }
      expect(
        Exit.isFailure(await Effect.runPromiseExit(tasks.create({ name: "Invalid", objective: "Work", schedule }))),
      ).toBe(true)
      expect(Exit.isFailure(await Effect.runPromiseExit(tasks.update(agent.id, { schedule })))).toBe(true)
      expect(await Effect.runPromise(tasks.list())).toEqual([agent])
    }
  })

  test("persists calendar timezones and rejects invalid zones without changing the roster", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Morning", objective: "Summarize", schedule: { kind: "cron", expr: "0 9 * * *" } }),
    )
    expect(agent.schedule).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    const prior = await Effect.runPromise(tasks.list())
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          tasks.create({
            name: "Invalid",
            objective: "Summarize",
            schedule: { kind: "cron", expr: "0 9 * * *", tz: "Invalid/Timezone" },
          }),
        ),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          tasks.update(agent.id, { schedule: { kind: "cron", expr: "0 9 * * *", tz: "Invalid/Timezone" } }),
        ),
      ),
    ).toBe(true)
    expect(await Effect.runPromise(tasks.list())).toEqual(prior)
    const changed = await Effect.runPromise(
      tasks.update(agent.id, { schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Kathmandu" } }),
    )
    expect(changed.schedule.kind).toBe("cron")
    const schedule = changed.schedule
    if (schedule.kind !== "cron") throw new Error("Expected calendar schedule")
    expect(new Intl.DateTimeFormat("en-US", { timeZone: schedule.tz }).resolvedOptions().timeZone).toBe(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kathmandu" }).resolvedOptions().timeZone,
    )
  })

  test("assigns persisted revisions and rejects counter exhaustion without overwriting history", async () => {
    const storage = memory()
    const tasks = RayaTask.make({ storage })
    const agent = await Effect.runPromise(
      tasks.create({ name: "Routine", objective: "Work", schedule: { kind: "manual" } }),
    )
    const input: RayaTask.Run = {
      id: "revision",
      agentID: agent.id,
      sessionID: SessionID.make("ses_revision"),
      at: 1,
      status: "running",
      revision: 999,
    }
    expect((await Effect.runPromise(tasks.record(input))).revision).toBe(1)
    expect((await Effect.runPromise(tasks.record(input))).revision).toBe(2)
    const exhausted = { ...input, revision: Number.MAX_SAFE_INTEGER }
    await Effect.runPromise(storage.write(["raya", "agent-runs", agent.id], [exhausted]))
    expect((await Effect.runPromiseExit(tasks.record(input)))._tag).toBe("Failure")
    expect(await Effect.runPromise(tasks.runsFor(agent.id))).toEqual([exhausted])
  })

  test.each([true, false])(
    "recovers a stopped startup only when its goal and history are complete: %s",
    async (complete) => {
      const child = await promisify(execFile)(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
        windowsHide: true,
      })
      const storage = memory()
      const attempts: string[] = []
      const runner = RayaTaskRunner.make({
        database,
        storage,
        sessions: {
          create: () =>
            Effect.sync(() => attempts.push("new start")).pipe(
              Effect.andThen(Effect.die("stop before creating test session")),
            ),
          get: () => Effect.die("unused"),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        },
      })
      const agent = await Effect.runPromise(
        runner.tasks.create({ name: "Routine", objective: "Work", schedule: { kind: "manual" } }),
      )
      const sid = SessionID.make("ses_recovered")
      const now = Date.now()
      const key = ["raya", "agent-claims", createHash("sha256").update(agent.id).digest("hex")]
      await Effect.runPromise(
        storage.write(key, {
          version: 1,
          agentID: agent.id,
          id: "prior",
          at: now,
          owner: { host: hostname(), pid: Number(child.stdout) },
          phase: "session-created",
          sessionID: sid,
        }),
      )
      await Effect.runPromise(
        runner.tasks.record({ id: "prior", agentID: agent.id, sessionID: sid, at: now, status: "complete" }),
      )
      await Effect.runPromise(
        storage.write(["raya", "goal", sid], {
          objective: "Work",
          status: complete ? "complete" : "active",
          createdAt: now,
          updatedAt: now,
          usage: { turns: 1, continuations: 0, toolCalls: 1 },
          progress: [],
        }),
      )
      await Effect.runPromiseExit(runner.fire(agent.id))
      expect(attempts).toEqual(complete ? ["new start"] : [])
      const record = await Effect.runPromise(storage.read<{ id: string }>(key))
      expect(record.id === "prior").toBe(!complete)
      expect(await Effect.runPromise(runner.tasks.runsFor(agent.id))).toHaveLength(1)
    },
  )

  test.each([
    ["active", "running"],
    ["paused", "running"],
    ["complete", "complete"],
    ["blocked", "blocked"],
  ] as const)("settlement preserves the meaning of a %s goal", async (status, expected) => {
    const storage = memory()
    const barrier = Deferred.makeUnsafe<void>()
    let calls = 0
    const runner = RayaTaskRunner.make({
      database,
      storage,
      sessions: {
        create: () => Effect.die("must not create another session"),
        get: () => Effect.die("unused"),
        messages: () =>
          Effect.gen(function* () {
            calls++
            if (calls === 2) yield* Deferred.succeed(barrier, undefined)
            yield* Deferred.await(barrier)
            return []
          }),
        children: () => Effect.succeed([]),
      },
    })
    const agent = await Effect.runPromise(
      runner.tasks.create({ name: "Routine", objective: "Work", schedule: { kind: "manual" } }),
    )
    const sid = SessionID.make("ses_settlement")
    const now = Date.now()
    await Effect.runPromise(
      storage.write(["raya", "goal", sid], {
        objective: "Work",
        status,
        createdAt: now,
        updatedAt: now,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [],
        blockedReason: status === "blocked" ? "Needs access" : undefined,
      }),
    )
    await Effect.runPromise(
      runner.tasks.record({ id: "run", agentID: agent.id, sessionID: sid, at: now, status: "running" }),
    )
    await Promise.all([Effect.runPromise(runner.settle(sid)), Effect.runPromise(runner.settle(sid))])
    const history = await Effect.runPromise(runner.tasks.runsFor(agent.id))
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe(expected)
    expect(history[0]?.sessionID).toBe(sid)
    if (expected === "running") {
      expect(history[0]?.outcome).toBeUndefined()
      expect(await Effect.runPromise(runner.tasks.recall(agent.id))).toBe("")
    }
    if (expected !== "running")
      expect(await Effect.runPromise(runner.tasks.recall(agent.id))).toBe(status === "blocked" ? "Needs access" : "")
    if (expected === "complete") expect(history[0]?.outcome?.summary).toBe("")
    await Effect.runPromise(runner.settle(sid))
    expect(await Effect.runPromise(runner.tasks.runsFor(agent.id))).toEqual(history)
  })

  test("independent runners cannot repeat a start after session creation fails", async () => {
    const storage = memory()
    const attempts: string[] = []
    const metadata: unknown[] = []
    const sessions = {
      create: (input?: { metadata?: unknown }) =>
        Effect.sync(() => {
          attempts.push("create")
          metadata.push(input?.metadata)
        }).pipe(Effect.andThen(Effect.die("session write failed"))),
      get: () => Effect.die("unused"),
      messages: () => Effect.succeed([]),
      children: () => Effect.succeed([]),
    }
    const first = RayaTaskRunner.make({ database, storage, sessions })
    const second = RayaTaskRunner.make({ database, storage, sessions })
    const agent = await Effect.runPromise(
      first.tasks.create({ name: "Routine", objective: "Work", schedule: { kind: "manual" } }),
    )
    await Effect.runPromise(first.tasks.update(agent.id, { schedule: { kind: "once", at: Date.now() + 60_000 } }))
    await Promise.all([Effect.runPromiseExit(first.fire(agent.id)), Effect.runPromiseExit(second.fire(agent.id))])
    expect(attempts).toEqual(["create"])
    const keys = await Effect.runPromise(storage.list(["raya", "agent-claims"]))
    const record = await Effect.runPromise(storage.read<{ id: string }>(keys[0]))
    expect(metadata).toEqual([
      {
        rayaRoutine: {
          version: 1,
          agentID: agent.id,
          runID: record.id,
          scheduleVersion: 2,
          trigger: { kind: "manual" },
        },
      },
    ])
    expect(await Effect.runPromise(first.tasks.runsFor(agent.id))).toEqual([])
    const restarted = RayaTaskRunner.make({ database, storage, sessions })
    expect(await Effect.runPromise(restarted.fire(agent.id).pipe(Effect.flip))).toMatchObject({
      _tag: "RayaTask.GuardError",
      message: "This routine has another start in progress or an interrupted start awaiting recovery.",
    })
    expect(attempts).toEqual(["create"])
  })

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
    for (const [index, id] of ["a", "b", "c"].entries()) {
      await Effect.runPromise(
        tasks.record({
          id,
          agentID: agent.id,
          at: running!.at + index + 1,
          sessionID: SessionID.make("ses_test"),
          status: "blocked",
          blockedReason: "Required connection unavailable",
        }),
      )
    }
    const paused = await Effect.runPromise(tasks.get(agent.id))
    expect(paused.enabled).toBe(false)
    expect(paused.note).toContain("Required connection unavailable")
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

  test("inbox jobs require a messages capability", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const exit = await Effect.runPromiseExit(
      tasks.create({
        name: "Mail",
        role: "inbox",
        objective: "triage",
        schedule: { kind: "manual" },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  test("recomputes a one-shot next run from storage after a new process", async () => {
    const store = memory()
    const at = Date.parse("2026-09-06T16:00:00Z")
    const first = RayaTask.make({ storage: store })
    const agent = await Effect.runPromise(
      first.create({
        name: "Briefer",
        role: "briefer",
        objective: "Summarize what changed",
        schedule: { kind: "once", at },
      }),
    )
    const revived = RayaTask.make({ storage: store })
    const listed = await Effect.runPromise(revived.preview(at - 60_000))
    expect(listed.find((item) => item.id === agent.id)?.nextRun).toBe(at)
    expect((await Effect.runPromise(revived.ready(at - 1))).map((item) => item.id)).toEqual([])
    expect((await Effect.runPromise(revived.ready(at))).map((item) => item.id)).toEqual([agent.id])
  })

  test("a two-minute cron fires twice and skips while the prior run is still going", async () => {
    const start = new Date(2026, 8, 6, 12, 0, 0).getTime()
    const created = {
      id: "pulse",
      name: "Pulse",
      role: "reviewer",
      objective: "Check the repo",
      capabilities: [] as string[],
      memoryScope: "role" as const,
      schedule: { kind: "cron" as const, expr: "*/2 * * * *" },
      enabled: true,
      createdAt: start,
      updatedAt: start,
    }
    const first = start + 2 * 60_000
    expect(RayaTask.due(created, first)).toBe(first)
    const running = {
      id: "r1",
      agentID: created.id,
      at: first,
      sessionID: SessionID.make("ses_test"),
      status: "running" as const,
    }
    expect(RayaTask.due(created, first + 30_000, running)).toBeUndefined()
    const done = { ...running, status: "complete" as const }
    const second = start + 4 * 60_000
    expect(RayaTask.due(created, second, done)).toBe(second)
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
    expect(RayaTask.listen(agent, "ci")).toBe(false)
    expect(RayaTask.listen(agent, "ci", "")).toBe(false)
    expect(RayaTask.listen(agent, "other", "main")).toBe(false)
    expect(RayaTask.listen({ ...agent, enabled: false }, "ci", "main")).toBe(false)
    expect(await Effect.runPromise(tasks.listenFor("ci"))).toEqual([])
    expect(await Effect.runPromise(tasks.listenFor("ci", ""))).toEqual([])
    const hit = await Effect.runPromise(tasks.listenFor("ci", "main"))
    expect(hit.map((item) => item.id)).toEqual([agent.id])
    await Effect.runPromise(tasks.update(agent.id, { schedule: { kind: "event", source: "ci" } }))
    expect((await Effect.runPromise(tasks.listenFor("ci"))).map((item) => item.id)).toEqual([agent.id])
    expect((await Effect.runPromise(tasks.listenFor("ci", "develop"))).map((item) => item.id)).toEqual([agent.id])
    await Effect.runPromise(tasks.update(agent.id, { schedule: { kind: "event", source: "ci", filter: "" } }))
    expect(await Effect.runPromise(tasks.listenFor("ci", "develop"))).toEqual([])
    expect(await Effect.runPromise(tasks.listenFor("ci"))).toEqual([])
    expect((await Effect.runPromise(tasks.listenFor("ci", ""))).map((item) => item.id)).toEqual([agent.id])
  })

  test("rechecks an event filter after selection and before starting a session", async () => {
    const storage = memory()
    const selected = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const attempts: string[] = []
    const runner = RayaTaskRunner.make({
      database,
      storage: {
        ...storage,
        read: <T>(key: string[]) =>
          Effect.gen(function* () {
            if (key[1] === "agent-runs") {
              yield* Deferred.succeed(selected, undefined)
              yield* Deferred.await(release)
            }
            return yield* storage.read<T>(key)
          }),
      },
      sessions: {
        create: () =>
          Effect.sync(() => attempts.push("started")).pipe(Effect.andThen(Effect.die("unexpected session start"))),
        get: () => Effect.die("unused"),
        messages: () => Effect.succeed([]),
        children: () => Effect.succeed([]),
      },
    })
    const agent = await Effect.runPromise(
      runner.tasks.create({
        name: "CI",
        objective: "Inspect the failed build",
        schedule: { kind: "event", source: "ci", filter: "main" },
      }),
    )
    const pending = Effect.runPromise(runner.announce("ci", "main").pipe(Effect.exit))
    await Effect.runPromise(Deferred.await(selected).pipe(Effect.timeout("5 seconds")))
    try {
      await Effect.runPromise(
        runner.tasks.update(agent.id, { schedule: { kind: "event", source: "ci", filter: "develop" } }),
      )
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
    }
    const result = await pending
    expect(attempts).toEqual([])
    expect(result).toEqual(Exit.succeed([]))
    expect(await Effect.runPromise(storage.list(["raya", "agent-claims"]))).toEqual([])
  })

  test("parks a running agent as waiting on you", async () => {
    const sid = SessionID.make("ses_test")
    const runner = RayaTaskRunner.make({
      database,
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
    expect(await Effect.runPromise(runner.fire(agent.id).pipe(Effect.flip))).toMatchObject({
      _tag: "RayaTask.GuardError",
      message: "This agent is already running or waiting on you.",
    })
    const scheduled = await Effect.runPromise(
      runner.tasks.update(agent.id, { schedule: { kind: "cron", expr: "* * * * *" } }),
    )
    expect(RayaTask.next(scheduled, Date.now(), last)).toBeUndefined()
    const from = Date.now() + 120_000
    expect(await Effect.runPromise(runner.tasks.ready(from))).toEqual([])
    await Effect.runPromise(
      runner.tasks.record({
        id: "later-history",
        agentID: agent.id,
        at: Date.now(),
        sessionID: SessionID.make("ses_other"),
        status: "complete",
      }),
    )
    expect(await Effect.runPromise(runner.tasks.ready(from))).toEqual([])
    expect((await Effect.runPromise(runner.tasks.preview(from)))[0]?.nextRun).toBeUndefined()
    await Effect.runPromise(runner.tasks.update(agent.id, { schedule: { kind: "event", source: "ci" } }))
    expect(await Effect.runPromise(runner.tasks.listenFor("ci"))).toEqual([])
    expect(await Effect.runPromise(runner.fire(agent.id).pipe(Effect.flip))).toMatchObject({
      _tag: "RayaTask.GuardError",
      message: "This agent is already running or waiting on you.",
    })
    await Effect.runPromise(runner.park(sid, false))
    expect((await Effect.runPromise(runner.tasks.runsFor(agent.id))).at(-1)?.status).toBe("running")
    expect(await Effect.runPromise(runner.tasks.listenFor("ci"))).toEqual([])
    await Effect.runPromise(runner.tasks.record({ ...last!, status: "complete", blockedReason: undefined }))
    expect((await Effect.runPromise(runner.tasks.listenFor("ci"))).map((item) => item.id)).toEqual([agent.id])
  })

  test("retains unfinished runs when completed history reaches its cap", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({
        name: "Watcher",
        objective: "Watch CI",
        schedule: { kind: "event", source: "ci" },
      }),
    )
    const run: RayaTask.Run = {
      id: "waiting",
      agentID: agent.id,
      sessionID: SessionID.make("ses_waiting"),
      at: 0,
      status: "blocked",
      blockedReason: "waiting on you",
    }
    await Effect.runPromise(tasks.record(run))
    for (const at of Array.from({ length: 51 }, (_, index) => index + 1)) {
      await Effect.runPromise(
        tasks.record({
          ...run,
          id: `complete-${at}`,
          at,
          status: "complete",
          blockedReason: undefined,
        }),
      )
    }
    const history = await Effect.runPromise(tasks.runsFor(agent.id))
    expect(history).toHaveLength(51)
    expect(history[0]).toEqual({ ...run, revision: 1, scheduleVersion: 1 })
    expect(history[1]?.id).toBe("complete-2")
    expect(await Effect.runPromise(tasks.listenFor("ci"))).toEqual([])
    await Effect.runPromise(tasks.record({ ...run, status: "complete", blockedReason: undefined }))
    expect(await Effect.runPromise(tasks.runsFor(agent.id))).toHaveLength(50)
    expect((await Effect.runPromise(tasks.listenFor("ci"))).map((item) => item.id)).toEqual([agent.id])
  })

  test("removes a routine from the roster", async () => {
    const tasks = RayaTask.make({ storage: memory(), database })
    const agent = await Effect.runPromise(
      tasks.create({
        name: "Temp",
        role: "coder",
        objective: "ship",
        schedule: { kind: "manual" },
      }),
    )
    const run = await Effect.runPromise(
      tasks.record({
        id: "retained-result",
        agentID: agent.id,
        sessionID: SessionID.make("ses_removed_routine"),
        at: Date.now(),
        status: "complete",
      }),
    )
    await Effect.runPromise(tasks.remember(agent.id, "Retained role context"))
    expect(await Effect.runPromise(tasks.remove(agent.id))).toBe(true)
    expect(await Effect.runPromise(tasks.runsFor(agent.id))).toEqual([run])
    expect(await Effect.runPromise(tasks.recall(agent.id))).toBe("Retained role context")
    const exit = await Effect.runPromiseExit(tasks.get(agent.id))
    expect(exit._tag).toBe("Failure")
  })

  test.each(["generalist", "coder", "reviewer", "accountant", "inbox", "custom"])(
    "new %s routines require an explicit workspace editing choice",
    async (role) => {
      const tasks = RayaTask.make({ storage: memory() })
      const agent = await Effect.runPromise(
        tasks.create({
          name: role,
          role,
          objective: "Work",
          schedule: { kind: "manual" },
          capabilities: ["money", "messages"],
        }),
      )
      expect(agent.access).toBe("brief")
      for (const tools of [undefined, ["*"], ["edit", "write", "bash", "apply_patch", "read"], ["e*"]]) {
        const rules = RayaTask.rules({ ...agent, tools })
        for (const permission of ["edit", "write", "bash", "apply_patch"])
          expect(Permission.evaluate(permission, "file", rules).action).toBe("deny")
      }
      const updated = await Effect.runPromise(tasks.update(agent.id, { access: "full" }))
      expect(Permission.evaluate("edit", "file", RayaTask.rules(updated)).action).toBe("allow")
      expect(Permission.evaluate("edit", "file", RayaTask.rules({ ...updated, tools: ["read"] })).action).toBe("deny")
    },
  )

  test("stores a custom role, model, and full access", async () => {
    const tasks = RayaTask.make({ storage: memory() })
    const agent = await Effect.runPromise(
      tasks.create({
        name: "Ops",
        role: "ops",
        objective: "watch deploys",
        schedule: { kind: "manual" },
        mode: "code",
        dir: "C:/tmp/ops-writes",
        model: { providerID: "anthropic", id: "claude" },
        access: "full",
      }),
    )
    expect(agent.role).toBe("ops")
    expect(agent.mode).toBe("code")
    expect(agent.dir).toBe("C:/tmp/ops-writes")
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
