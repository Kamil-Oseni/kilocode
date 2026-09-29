import { expect } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { RayaTaskQueue, type Rearm } from "@/kilocode/task/queue"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaGoal } from "@/kilocode/goal"
import { scheduler } from "@/kilocode/task/scheduler"
import { Context, Journal } from "@/kilocode/task/scheduler-review"
import { durable, stopped } from "@/kilocode/task/owner"
import { SessionID } from "@/session/schema"
import {
  RayaRoutineOccurrenceTable as Occurrence,
  RayaRoutineCursorTable as Cursor,
} from "@opencode-ai/core/kilocode/routine.sql"
import { eq } from "drizzle-orm"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const state = (directory: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(directory, "storage")),
    Database.layerFromPath(path.join(directory, "queue.sqlite")),
  )
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const setup = Effect.fn(function* (kind: "once" | "cron" = "once") {
  const input = { storage: yield* Storage.Service, database: yield* Database.Service }
  const tasks = RayaTask.make(input)
  const queue = RayaTaskQueue.make(input.database)
  const schedule = scheduler(input)
  const at = Math.ceil(Date.now() / 60_000) * 60_000 + 60_000
  const agent = yield* tasks.create({
    name: "Reviewed scheduled work",
    objective: "Verify saved evidence",
    schedule: kind === "once" ? { kind, at } : { kind, expr: "* * * * *", tz: "UTC" },
  })
  const trigger = yield* schedule.prepare(agent.id, at)
  if (!trigger) throw new Error("Expected scheduled occurrence")
  const id = crypto.randomUUID()
  const sid = SessionID.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`)
  yield* schedule.reserve(trigger, id)
  yield* schedule.link(trigger, id, sid)
  yield* tasks.record({
    id,
    agentID: agent.id,
    sessionID: sid,
    at,
    status: "blocked",
    blockedReason: "waiting on you",
    scheduleVersion: 1,
    trigger,
  })
  const run = (yield* tasks.runsFor(agent.id))[0]
  if (!run) throw new Error("Expected saved scheduled run")
  const execution = RayaTaskExecution.make(input.storage)
  yield* execution.enter(run, Effect.fail("uncertain outcome")).pipe(Effect.exit)
  const record = yield* execution.receipt(run)
  if (!record) throw new Error("Expected retained actual execution")
  const ctx = { intent: "reviewed-reply", source: "user-reply", execution: hash(record.token) }
  return { input, tasks, queue, schedule, agent, trigger, run, execution, record, ctx }
})

for (const kind of ["once", "cron"] as const) {
  it.live(
    `${kind} reviewed rearm retains exact run/session/occurrence/cursor and immutable retry across reopen`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const saved = yield* Effect.gen(function* () {
          const fixture = yield* setup(kind)
          const before = yield* fixture.queue.get(fixture.trigger.id)
          const cursor = yield* fixture.queue.cursor(fixture.agent.id, 1)
          yield* fixture.schedule.review(fixture.run, fixture.ctx)
          expect(yield* fixture.queue.get(fixture.trigger.id)).toEqual(before)
          yield* fixture.execution.review(fixture.run, fixture.record.token)
          yield* fixture.schedule.review(fixture.run, fixture.ctx)
          const review = yield* fixture.input.storage.read([
            "raya",
            "agent-execution-reviews",
            hash(fixture.run.id),
            fixture.ctx.execution,
          ])
          yield* fixture.schedule.rearm(fixture.run, fixture.ctx)
          const row = yield* fixture.queue.get(fixture.trigger.id)
          expect(row).toMatchObject({
            id: before?.id,
            claim_id: fixture.run.id,
            session_id: fixture.run.sessionID,
            state: "linked",
            scheduled_at: before?.scheduled_at,
            observed_at: before?.observed_at,
          })
          expect(yield* fixture.schedule.owned(fixture.run)).toBe(true)
          expect(yield* fixture.tasks.runsFor(fixture.agent.id)).toEqual([fixture.run])
          expect(yield* fixture.queue.cursor(fixture.agent.id, 1)).toEqual(cursor)
          const journal = yield* fixture.input.storage
            .read(["raya", "scheduler-reviews", hash(fixture.run.id)])
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
          expect(journal).toMatchObject({ phase: "complete", review: fixture.ctx })
          yield* fixture.schedule.rearm(fixture.run, fixture.ctx)
          expect(yield* fixture.queue.get(fixture.trigger.id)).toEqual(row)
          expect(yield* fixture.input.storage.read(["raya", "scheduler-reviews", hash(fixture.run.id)])).toEqual(
            journal,
          )
          return { run: fixture.run, ctx: fixture.ctx, row, cursor, review, journal }
        }).pipe(Effect.provide(state(directory)))
        yield* Effect.gen(function* () {
          const input = { storage: yield* Storage.Service, database: yield* Database.Service }
          const queue = RayaTaskQueue.make(input.database)
          yield* scheduler(input).rearm(saved.run, saved.ctx)
          expect(yield* queue.get(saved.row!.id)).toEqual(saved.row)
          expect(yield* queue.cursor(saved.run.agentID, 1)).toEqual(saved.cursor)
          expect(
            yield* input.storage.read(["raya", "agent-execution-reviews", hash(saved.run.id), saved.ctx.execution]),
          ).toEqual(saved.review)
          expect(yield* input.storage.read(["raya", "scheduler-reviews", hash(saved.run.id)])).toEqual(saved.journal)
        }).pipe(Effect.provide(state(directory)))
      }),
    30_000,
  )
}

for (const expired of [false, true]) {
  it.live(
    `review takes over a proven stopped scheduler ${expired ? "after" : "before"} lease expiry`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const result = path.join(directory, "stopped.json")
          const child = spawnSync(
            process.execPath,
            [fileURLToPath(new URL("./fixtures/task-scheduler-review.ts", import.meta.url)), directory, result],
            {
              encoding: "utf8",
              env: { ...process.env },
              timeout: 30_000,
              windowsHide: true,
            },
          )
          if (child.status !== 0)
            throw new Error(`Scheduler source process exited ${child.status}: ${child.stderr.slice(-8_192)}`)
          expect(child.status).toBe(0)
          const saved = yield* Effect.promise(() => Bun.file(result).json() as Promise<{ run: unknown; ctx: unknown }>)
          const run = yield* Schema.decodeUnknownEffect(RayaTask.Run)(saved.run)
          const ctx = yield* Schema.decodeUnknownEffect(Context)(saved.ctx)
          const input = { storage: yield* Storage.Service, database: yield* Database.Service }
          const schedule = scheduler(input)
          const execution = RayaTaskExecution.make(input.storage)
          const record = yield* execution.receipt(run)
          if (!record || run.trigger?.kind !== "timer") throw new Error("Expected retained stopped execution")
          expect(stopped(record.owner)).toBe(true)
          yield* input.database.db
            .update(Occurrence)
            .set({ lease_until: Date.now() + (expired ? -1 : 180_000) })
            .where(eq(Occurrence.id, run.trigger.id))
            .run()
          yield* schedule.review(run, ctx)
          yield* execution.review(run, record.token)
          yield* schedule.rearm(run, ctx)
          expect(yield* schedule.owned(run)).toBe(true)
          expect(yield* RayaTask.make(input).runsFor(run.agentID)).toEqual([run])
        }).pipe(Effect.provide(state(directory)))
      }),
    30_000,
  )
}

for (const scenario of [
  "live",
  "live-expired",
  "missing",
  "missing-row",
  "cursor",
  "legacy",
  "claim",
  "session",
  "version",
  "trigger",
  "disabled",
  "policy",
  "history",
  "terminal-run",
  "complete",
  "skipped",
  "starting",
  "execution",
  "unreviewed",
] as const) {
  it.live(
    `scheduled review refuses ${scenario} without granting or changing occurrence ownership`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fixture = yield* setup()
          const row = yield* fixture.queue.get(fixture.trigger.id)
          if (!row?.owner) throw new Error("Expected owned occurrence")
          if (scenario === "missing") yield* fixture.input.storage.remove(["raya", "scheduler-owners", hash(row.owner)])
          if (scenario === "missing-row")
            yield* fixture.input.database.db.delete(Occurrence).where(eq(Occurrence.id, row.id)).run()
          if (scenario === "cursor")
            yield* fixture.input.database.db
              .update(Cursor)
              .set({ through: row.scheduled_at + 1 })
              .where(eq(Cursor.agent_id, fixture.agent.id))
              .run()
          if (scenario === "legacy")
            yield* fixture.input.storage.replace(["raya", "scheduler-owners", hash(row.owner)], {
              version: 1,
              id: row.owner,
              owner: { host: durable().host, pid: process.pid },
              at: Date.now(),
            })
          if (scenario === "live" || scenario === "live-expired") {
            const id = crypto.randomUUID()
            yield* fixture.input.storage.replace(["raya", "scheduler-owners", hash(id)], {
              version: 1,
              id,
              owner: durable(),
              at: Date.now(),
            })
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ owner: id, ...(scenario === "live-expired" ? { lease_until: Date.now() - 1 } : {}) })
              .where(eq(Occurrence.id, row.id))
              .run()
          }
          if (scenario === "claim")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ claim_id: "changed" })
              .where(eq(Occurrence.id, row.id))
              .run()
          if (scenario === "session")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ session_id: "ses_changed" })
              .where(eq(Occurrence.id, row.id))
              .run()
          if (scenario === "version")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ schedule_version: 2 })
              .where(eq(Occurrence.id, row.id))
              .run()
          if (scenario === "trigger")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ observed_at: row.observed_at + 1 })
              .where(eq(Occurrence.id, row.id))
              .run()
          if (scenario === "disabled") yield* fixture.tasks.update(fixture.agent.id, { enabled: false })
          if (scenario === "policy") yield* fixture.tasks.update(fixture.agent.id, { schedule: { kind: "manual" } })
          if (scenario === "history")
            yield* fixture.tasks.transition(fixture.run, { ...fixture.run, blockedReason: "changed after review" })
          if (scenario === "terminal-run")
            yield* fixture.tasks.transition(fixture.run, { ...fixture.run, status: "complete" })
          if (scenario === "complete" || scenario === "skipped" || scenario === "starting")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ state: scenario })
              .where(eq(Occurrence.id, row.id))
              .run()
          if (scenario !== "unreviewed") yield* fixture.execution.review(fixture.run, fixture.record.token)
          if (scenario === "execution")
            yield* fixture.input.storage.replace(["raya", "agent-executions", hash(fixture.run.id)], {
              ...fixture.record,
              token: crypto.randomUUID(),
            })
          if (scenario === "execution")
            expect(Exit.isFailure(yield* fixture.schedule.review(fixture.run, fixture.ctx).pipe(Effect.exit))).toBe(
              true,
            )
          const before = yield* fixture.queue.get(row.id)
          const cursor = yield* fixture.queue.cursor(fixture.agent.id, 1)
          const history = yield* fixture.tasks.runsFor(fixture.agent.id)
          expect(Exit.isFailure(yield* fixture.schedule.rearm(fixture.run, fixture.ctx).pipe(Effect.exit))).toBe(true)
          expect(yield* fixture.queue.get(row.id)).toEqual(before)
          expect(yield* fixture.queue.cursor(fixture.agent.id, 1)).toEqual(cursor)
          expect(yield* fixture.tasks.runsFor(fixture.agent.id)).toEqual(history)
          expect(
            (yield* fixture.input.storage.read(["raya", "scheduler-reviews", hash(fixture.run.id)]).pipe(Effect.flip))
              ._tag,
          ).toBe("NotFoundError")
          if (scenario === "execution")
            expect(yield* fixture.execution.receipt(fixture.run)).not.toEqual(fixture.record)
        }).pipe(Effect.provide(state(directory)))
      }),
    30_000,
  )
}

it.live(
  "an expired completed current-owner review renews once without changing saved run or cursor",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fixture = yield* setup()
        yield* fixture.execution.review(fixture.run, fixture.record.token)
        yield* fixture.schedule.rearm(fixture.run, fixture.ctx)
        const cursor = yield* fixture.queue.cursor(fixture.agent.id, 1)
        const key = ["raya", "scheduler-reviews", hash(fixture.run.id)]
        const complete = yield* fixture.input.storage
          .read(key)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
        const expired = Date.now() - 1
        // Seed an internally consistent expired durable state; the row never regresses below its journal target.
        yield* fixture.input.storage.replace(key, {
          ...complete,
          target: { ...complete.target, leaseUntil: expired, updated: expired - 180_000 },
          updatedAt: expired - 180_000,
        })
        yield* fixture.input.database.db
          .update(Occurrence)
          .set({ lease_until: expired, time_updated: expired - 180_000 })
          .where(eq(Occurrence.id, fixture.trigger.id))
          .run()
        expect(yield* fixture.schedule.owned(fixture.run)).toBe(false)
        yield* fixture.schedule.rearm(fixture.run, fixture.ctx)
        expect(yield* fixture.schedule.owned(fixture.run)).toBe(true)
        const row = yield* fixture.queue.get(fixture.trigger.id)
        const journal = yield* fixture.input.storage.read(["raya", "scheduler-reviews", hash(fixture.run.id)])
        yield* fixture.schedule.rearm(fixture.run, fixture.ctx)
        expect(yield* fixture.queue.get(fixture.trigger.id)).toEqual(row)
        expect(yield* fixture.input.storage.read(["raya", "scheduler-reviews", hash(fixture.run.id)])).toEqual(journal)
        expect(yield* fixture.tasks.runsFor(fixture.agent.id)).toEqual([fixture.run])
        expect(yield* fixture.queue.cursor(fixture.agent.id, 1)).toEqual(cursor)
      }).pipe(Effect.provide(state(directory)))
    }),
  30_000,
)

it.live(
  "a prepared review refuses an unrelated stopped third owner with otherwise identical occurrence identity",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const fixture = yield* setup()
        yield* fixture.execution.review(fixture.run, fixture.record.token)
        yield* fixture.input.database.db.run(
          "CREATE TRIGGER interrupt_rearm BEFORE UPDATE ON raya_routine_occurrence BEGIN SELECT RAISE(ABORT, 'retain prepared journal'); END",
        )
        expect(Exit.isFailure(yield* fixture.schedule.rearm(fixture.run, fixture.ctx).pipe(Effect.exit))).toBe(true)
        yield* fixture.input.database.db.run("DROP TRIGGER interrupt_rearm")
        const journal = yield* fixture.input.storage.read(["raya", "scheduler-reviews", hash(fixture.run.id)])
        const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
        })
        expect(child.status).toBe(0)
        const dead = { ...durable(), pid: Number(child.stdout) }
        expect(stopped(dead)).toBe(true)
        const id = crypto.randomUUID()
        yield* fixture.input.storage.replace(["raya", "scheduler-owners", hash(id)], {
          version: 1,
          id,
          owner: dead,
          at: Date.now(),
        })
        yield* fixture.input.database.db
          .update(Occurrence)
          .set({ owner: id })
          .where(eq(Occurrence.id, fixture.trigger.id))
          .run()
        const row = yield* fixture.queue.get(fixture.trigger.id)
        expect(Exit.isFailure(yield* fixture.schedule.rearm(fixture.run, fixture.ctx).pipe(Effect.exit))).toBe(true)
        expect(yield* fixture.queue.get(fixture.trigger.id)).toEqual(row)
        expect(yield* fixture.input.storage.read(["raya", "scheduler-reviews", hash(fixture.run.id)])).toEqual(journal)
        expect(yield* fixture.tasks.runsFor(fixture.agent.id)).toEqual([fixture.run])
      }).pipe(Effect.provide(state(directory)))
    }),
  30_000,
)

for (const scenario of ["linked", "complete", "claim", "session", "starting", "sql-failure", "journal"] as const) {
  it.live(
    `terminal scheduled settlement ${scenario} cleans only exact durable rearm authority`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const fixture = yield* setup()
          yield* fixture.execution.review(fixture.run, fixture.record.token)
          yield* fixture.schedule.rearm(fixture.run, fixture.ctx)
          const goal = yield* Schema.decodeUnknownEffect(RayaGoal.State)({
            objective: "Retain terminal evidence",
            status: "complete",
            createdAt: 1,
            updatedAt: 2,
            usage: { turns: 1, continuations: 0, toolCalls: 1 },
            progress: [],
          })
          const goalKey = ["raya", "goal", fixture.run.sessionID]
          yield* fixture.input.storage.replace(goalKey, goal)
          yield* fixture.tasks.transition(fixture.run, { ...fixture.run, status: "complete" })
          const history = yield* fixture.tasks.runsFor(fixture.agent.id)
          const terminal = history[0]
          if (!terminal) throw new Error("Expected saved terminal history")
          const key = ["raya", "scheduler-reviews", hash(fixture.run.id)]
          const journal = yield* fixture.input.storage
            .read(key)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
          const reviewKey = ["raya", "agent-execution-reviews", hash(fixture.run.id), fixture.ctx.execution]
          const review = yield* fixture.input.storage.read(reviewKey)
          if (scenario === "complete")
            yield* fixture.queue.settle({
              id: fixture.trigger.id,
              claimID: fixture.run.id,
              sessionID: fixture.run.sessionID,
              now: Date.now(),
            })
          if (scenario === "claim")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ claim_id: "changed" })
              .where(eq(Occurrence.id, fixture.trigger.id))
              .run()
          if (scenario === "session")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ session_id: "ses_changed" })
              .where(eq(Occurrence.id, fixture.trigger.id))
              .run()
          if (scenario === "starting")
            yield* fixture.input.database.db
              .update(Occurrence)
              .set({ state: "starting" })
              .where(eq(Occurrence.id, fixture.trigger.id))
              .run()
          if (scenario === "journal")
            yield* fixture.input.storage.replace(key, {
              ...journal,
              identity: { ...journal.identity, observedAt: journal.identity.observedAt + 1 },
            })
          if (scenario === "sql-failure")
            yield* fixture.input.database.db.run(
              "CREATE TRIGGER block_settlement BEFORE UPDATE ON raya_routine_occurrence BEGIN SELECT RAISE(ABORT, 'settlement failed'); END",
            )
          const retained = yield* fixture.input.storage.read(key)
          const row = yield* fixture.queue.get(fixture.trigger.id)
          const result = yield* fixture.schedule.settle(terminal).pipe(Effect.exit)
          if (scenario === "linked" || scenario === "complete") {
            expect(Exit.isSuccess(result)).toBe(true)
            expect((yield* fixture.input.storage.read(key).pipe(Effect.flip))._tag).toBe("NotFoundError")
            expect((yield* fixture.queue.get(fixture.trigger.id))?.state).toBe("complete")
            yield* fixture.schedule.settle(terminal)
          }
          if (scenario !== "linked" && scenario !== "complete") {
            expect(yield* fixture.input.storage.read(key)).toEqual(retained)
            if (scenario !== "journal") expect(yield* fixture.queue.get(fixture.trigger.id)).toEqual(row)
            if (scenario === "sql-failure" || scenario === "journal") expect(Exit.isFailure(result)).toBe(true)
          }
          expect(yield* fixture.input.storage.read(goalKey)).toEqual(goal)
          expect(yield* fixture.tasks.runsFor(fixture.agent.id)).toEqual(history)
          expect(yield* fixture.input.storage.read(reviewKey)).toEqual(review)
        }).pipe(Effect.provide(state(directory)))
      }),
    30_000,
  )
}

for (const stage of ["prepared", "cas"] as const) {
  it.live(
    `scheduled review recovers the ${stage} durable boundary after real SQLite interruption and reopen`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const saved = yield* Effect.gen(function* () {
          const fixture = yield* setup()
          yield* fixture.schedule.review(fixture.run, fixture.ctx)
          yield* fixture.execution.review(fixture.run, fixture.record.token)
          const before = yield* fixture.queue.get(fixture.trigger.id)
          const cursor = yield* fixture.queue.cursor(fixture.agent.id, 1)
          yield* fixture.input.database.db.run(
            stage === "prepared"
              ? "CREATE TRIGGER interrupt_rearm BEFORE UPDATE ON raya_routine_occurrence BEGIN SELECT RAISE(ABORT, 'interrupt before CAS'); END"
              : "CREATE TRIGGER interrupt_rearm AFTER UPDATE ON raya_routine_occurrence BEGIN SELECT RAISE(FAIL, 'interrupt after CAS'); END",
          )
          expect(Exit.isFailure(yield* fixture.schedule.rearm(fixture.run, fixture.ctx).pipe(Effect.exit))).toBe(true)
          const journal = yield* fixture.input.storage
            .read(["raya", "scheduler-reviews", hash(fixture.run.id)])
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Journal)))
          expect(journal).toMatchObject({ phase: "prepared", review: fixture.ctx })
          const row = yield* fixture.queue.get(fixture.trigger.id)
          if (stage === "prepared") expect(row).toEqual(before)
          if (stage === "cas")
            expect(row).toMatchObject({
              owner: journal.target.id,
              lease_until: journal.target.leaseUntil,
              time_updated: journal.target.updated,
            })
          expect(
            Exit.isFailure(
              yield* fixture.schedule
                .rearm(fixture.run, { ...fixture.ctx, source: "different-reply" })
                .pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(yield* fixture.queue.get(fixture.trigger.id)).toEqual(row)
          expect(yield* fixture.input.storage.read(["raya", "scheduler-reviews", hash(fixture.run.id)])).toEqual(
            journal,
          )
          return { run: fixture.run, ctx: fixture.ctx, row, cursor }
        }).pipe(Effect.provide(state(directory)))
        yield* Effect.gen(function* () {
          const input = { storage: yield* Storage.Service, database: yield* Database.Service }
          yield* input.database.db.run("DROP TRIGGER interrupt_rearm")
          yield* scheduler(input).rearm(saved.run, saved.ctx)
          const queue = RayaTaskQueue.make(input.database)
          expect(yield* scheduler(input).owned(saved.run)).toBe(true)
          expect(yield* queue.cursor(saved.run.agentID, 1)).toEqual(saved.cursor)
          expect(yield* input.storage.read(["raya", "scheduler-reviews", hash(saved.run.id)])).toMatchObject({
            phase: "complete",
            review: saved.ctx,
          })
          expect(yield* RayaTask.make(input).runsFor(saved.run.agentID)).toEqual([saved.run])
          if (stage === "cas") expect(yield* queue.get(saved.row!.id)).toEqual(saved.row)
        }).pipe(Effect.provide(state(directory)))
      }),
    30_000,
  )
}

it.live(
  "scheduled review queue CAS preserves occurrence and cursor identity across reopening",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const saved = yield* Effect.gen(function* () {
        const queue = RayaTaskQueue.make(yield* Database.Service)
        yield* queue.publish({ agentID: "agent", version: 1, occurrences: [{ at: 1, observedAt: 2 }] })
        const row = (yield* queue.pending("agent", 1))[0]
        if (!row) throw new Error("Expected published occurrence")
        yield* queue.claim({ id: row.id, claimID: "run", owner: "prior", now: 3, until: 100 })
        expect(yield* queue.link({ id: row.id, claimID: "run", sessionID: "ses_review", now: 4 })).toBe(true)
        const linked = yield* queue.get(row.id)
        if (!linked) throw new Error("Expected linked occurrence")
        const request: Rearm = {
          id: linked.id,
          agentID: linked.agent_id,
          version: linked.schedule_version,
          scheduledAt: linked.scheduled_at,
          observedAt: linked.observed_at,
          timezone: linked.timezone,
          claimID: "run",
          sessionID: "ses_review",
          owner: "prior",
          leaseUntil: linked.lease_until,
          updated: linked.time_updated,
          nextOwner: "next",
          now: 5,
          until: 200,
        }
        const cursor = yield* queue.cursor("agent", 1)
        expect(yield* queue.rearm(request)).toEqual({ ...linked, owner: "next", lease_until: 200, time_updated: 5 })
        expect(yield* queue.rearm(request)).toBeUndefined()
        expect(yield* queue.cursor("agent", 1)).toEqual(cursor)
        return { id: linked.id, cursor, row: yield* queue.get(linked.id) }
      }).pipe(Effect.provide(state(directory)))
      yield* Effect.gen(function* () {
        const queue = RayaTaskQueue.make(yield* Database.Service)
        expect(yield* queue.get(saved.id)).toEqual(saved.row)
        expect(yield* queue.cursor("agent", 1)).toEqual(saved.cursor)
        expect(yield* queue.pending("agent", 1)).toEqual([])
      }).pipe(Effect.provide(state(directory)))
    }),
  30_000,
)

for (const field of [
  "agentID",
  "version",
  "scheduledAt",
  "observedAt",
  "timezone",
  "claimID",
  "sessionID",
  "owner",
  "leaseUntil",
  "updated",
  "complete",
  "skipped",
  "starting",
] as const) {
  it.live(
    `scheduled review queue CAS refuses changed ${field} without changing durable state`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const database = yield* Database.Service
          const queue = RayaTaskQueue.make(database)
          yield* queue.publish({ agentID: "agent", version: 1, occurrences: [{ at: 1, observedAt: 2 }] })
          const row = (yield* queue.pending("agent", 1))[0]
          if (!row) throw new Error("Expected published occurrence")
          yield* queue.claim({ id: row.id, claimID: "run", owner: "prior", now: 3, until: 100 })
          yield* queue.link({ id: row.id, claimID: "run", sessionID: "ses_review", now: 4 })
          const linked = yield* queue.get(row.id)
          if (!linked) throw new Error("Expected linked occurrence")
          const request: Rearm = {
            id: linked.id,
            agentID: "agent",
            version: 1,
            scheduledAt: 1,
            observedAt: 2,
            timezone: null,
            claimID: "run",
            sessionID: "ses_review",
            owner: "prior",
            leaseUntil: 100,
            updated: 4,
            nextOwner: "next",
            now: 5,
            until: 200,
          }
          const terminal = field === "complete" || field === "skipped" || field === "starting"
          if (terminal)
            yield* database.db.update(Occurrence).set({ state: field }).where(eq(Occurrence.id, row.id)).run()
          const changed = terminal
            ? request
            : { ...request, [field]: typeof request[field] === "number" ? request[field] + 1 : "changed" }
          const before = yield* queue.get(row.id)
          const cursor = yield* queue.cursor("agent", 1)
          expect(yield* queue.rearm(changed)).toBeUndefined()
          expect(yield* queue.get(row.id)).toEqual(before)
          expect(yield* queue.cursor("agent", 1)).toEqual(cursor)
        }).pipe(Effect.provide(state(directory)))
      }),
    30_000,
  )
}
