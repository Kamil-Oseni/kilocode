import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { scheduler } from "@/kilocode/task/scheduler"
import { latest } from "@/kilocode/task/cron"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (directory: string) =>
  Storage.layerFromDir(path.join(directory, "storage")).pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(directory, "queue.sqlite"))),
  )

it.live("latest selection uses the saved timezone and strict consumed boundary", () =>
  Effect.gen(function* () {
    const after = Date.parse("2026-10-11T00:00:00Z")
    const through = Date.parse("2026-10-12T12:00:00Z")
    const at = Date.parse("2026-10-12T03:45:00Z")
    expect(yield* latest("15 9 * * *", after, through, "Asia/Kolkata")).toBe(at)
    expect(yield* latest("15 9 * * *", at, through, "Asia/Kolkata")).toBeUndefined()
  }),
)

it.live("offline catch-up publishes only the latest occurrence or a durable skip", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = yield* Effect.all({ storage: Storage.Service, database: Database.Service })
      const tasks = RayaTask.make(input)
      const queue = RayaTaskQueue.make(input.database)
      const schedule = scheduler(input)
      const from = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 3 * 86_400_000 + 12 * 3_600_000
      for (const missed of ["latest", "skip"] as const) {
        const agent = yield* tasks.create({
          name: missed,
          objective: "Work",
          access: "full",
          missed,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        })
        const trigger = yield* schedule.prepare(agent.id, from)
        const rows = yield* queue.pending(agent.id, 1)
        expect(rows).toHaveLength(missed === "latest" ? 1 : 0)
        expect((yield* queue.cursor(agent.id, 1))?.through).toBe(from - 3 * 3_600_000)
        if (missed === "latest") {
          expect(trigger?.scheduledAt).toBe(from - 3 * 3_600_000)
          expect(yield* schedule.prepare(agent.id, from + 1000)).toEqual(trigger)
        } else {
          expect(trigger).toBeUndefined()
          const row = yield* queue.get(`timer:${JSON.stringify([agent.id, 1, from - 3 * 3_600_000])}`)
          expect(row?.state).toBe("skipped")
          expect(row?.reason).toContain("missed")
          expect(yield* schedule.prepare(agent.id, from + 1000)).toBeUndefined()
        }
      }
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("busy queue retains one occurrence and the original active lease cursor", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = yield* Effect.all({ storage: Storage.Service, database: Database.Service })
      const tasks = RayaTask.make(input)
      const queue = RayaTaskQueue.make(input.database)
      const schedule = scheduler(input)
      const at = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
      const agent = yield* tasks.create({
        name: "Queue",
        objective: "Work",
        access: "full",
        overlap: "queue",
        missed: "latest",
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      })
      const trigger = yield* schedule.prepare(agent.id, at)
      if (!trigger) throw new Error("Expected original occurrence")
      const sid = SessionID.make("ses_policy_original")
      yield* queue.claim({
        id: trigger.id,
        claimID: "original",
        owner: "original-backend",
        now: at,
        until: at + 3_600_000,
      })
      yield* queue.link({ id: trigger.id, claimID: "original", sessionID: sid, now: at })
      const run = {
        id: "original",
        agentID: agent.id,
        sessionID: sid,
        at,
        scheduleVersion: 1,
        trigger,
        status: "running" as const,
      }
      yield* tasks.record(run)
      const original = yield* queue.get(trigger.id)
      expect(yield* schedule.prepare(agent.id, at + 5 * 60_000)).toBeUndefined()
      const deferred = (yield* queue.pending(agent.id, 1))[0]
      expect(deferred?.scheduled_at).toBe(at + 5 * 60_000)
      expect(deferred?.reason).toContain("previous work")
      expect(
        yield* queue.publish({
          agentID: agent.id,
          version: 1,
          expected: at,
          defer: true,
          occurrences: [{ at: at + 18 * 60_000, observedAt: at + 18 * 60_000, tz: "UTC" }],
        }),
      ).toBe(deferred?.scheduled_at)
      expect(yield* schedule.prepare(agent.id, at + 20 * 60_000)).toBeUndefined()
      expect(yield* queue.pending(agent.id, 1)).toEqual([deferred])
      expect(yield* queue.get(trigger.id)).toEqual(original)
      expect((yield* queue.cursor(agent.id, 1))?.through).toBe(at)
      yield* tasks.record({ ...run, status: "complete" })
      yield* queue.settle({ id: trigger.id, claimID: "original", sessionID: sid, now: at + 21 * 60_000 })
      const selected = yield* schedule.prepare(agent.id, at + 22 * 60_000)
      if (!selected) throw new Error("Expected the retained deferred occurrence")
      expect(selected?.id).toBe(deferred?.id)
      expect(selected?.observedAt).toBe(deferred?.observed_at)
      expect(selected?.scheduledAt).toBe(deferred?.scheduled_at)
      expect((yield* queue.cursor(agent.id, 1))?.through).toBe(deferred?.scheduled_at)
      expect(yield* schedule.check(yield* tasks.get(agent.id), selected)).toEqual(selected)
    }).pipe(Effect.provide(state(directory)))
  }),
)

it.live("busy skip records no runnable backlog and preserves legacy undefined policies", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    yield* Effect.gen(function* () {
      const input = yield* Effect.all({ storage: Storage.Service, database: Database.Service })
      const tasks = RayaTask.make(input)
      const queue = RayaTaskQueue.make(input.database)
      const schedule = scheduler(input)
      const at = Math.floor(Date.now() / 60_000) * 60_000 + 60_000
      for (const overlap of ["skip", undefined] as const) {
        const agent = yield* tasks.create({
          name: "Skip",
          objective: "Work",
          access: "full",
          ...(overlap ? { overlap } : {}),
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        })
        yield* tasks.record({
          id: `busy-${agent.id}`,
          agentID: agent.id,
          sessionID: SessionID.make(`ses_${agent.id}`),
          at,
          status: "running",
          trigger: { kind: "manual" },
        })
        expect(yield* schedule.prepare(agent.id, at + 60_000)).toBeUndefined()
        expect(yield* queue.pending(agent.id, 1)).toHaveLength(0)
        const skipped = yield* queue.get(`timer:${JSON.stringify([agent.id, 1, at + 60_000])}`)
        expect(skipped?.state).toBe(overlap === "skip" ? "skipped" : undefined)
        expect((yield* queue.cursor(agent.id, 1))?.through).toBeUndefined()
      }
    }).pipe(Effect.provide(state(directory)))
  }),
)
