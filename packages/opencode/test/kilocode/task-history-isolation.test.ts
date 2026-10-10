import { expect } from "bun:test"
import { Effect, Exit, Layer, Schema, Cause, Schedule } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { scheduler } from "@/kilocode/task/scheduler"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaGoal } from "@/kilocode/goal"
import { continuation, owned } from "@/kilocode/task/continuation"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { database as physical } from "./fixtures/effect-profile"

const emit = (sessionID: SessionID, request: string, reply: boolean) =>
  GlobalBus.emit("event", {
    payload: reply
      ? { type: "permission.replied", properties: { sessionID, requestID: request, reply: "once" } }
      : {
          type: "permission.asked",
          properties: { sessionID, id: request, permission: "bash", patterns: ["bun test"] },
        },
  })

const profile = (directory: string) =>
  Storage.layerWithDatabase(path.join(directory, "storage")).pipe(
    Layer.provideMerge(Database.layerFromPath(path.join(directory, "queue.sqlite"))),
  )

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      FSUtil.node,
      Git.node,
      Session.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      Database.node,
      Bus.node,
    ]),
    [[Database.node, physical]],
  ),
)

it.live(
  "unrelated damaged history preserves a real permission receipt and a cold duplicate stays inert",
  () =>
    provideTmpdirInstance((directory) => {
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const database = yield* Database.Service
          const sessions = yield* Session.Service
          const bus = yield* Bus.Service
          const fs = yield* FSUtil.Service
          const input = { storage, database, sessions, bus }
          const runner = RayaTaskRunner.make(input)
          const inbox = RayaTaskInbox.make(database)
          const bad = yield* runner.tasks.create({
            name: "Damaged earlier",
            objective: "Wait",
            schedule: { kind: "manual" },
          })
          const good = yield* runner.tasks.create({
            name: "Healthy approval",
            objective: "Wait",
            schedule: { kind: "manual" },
          })
          const trigger = { kind: "manual" } as const
          const session = yield* sessions.create({
            title: "Recovered permission receipt",
            metadata: {
              rayaRoutine: { version: 2, agentID: good.id, runID: "run_receipt", scheduleVersion: 1, trigger },
            },
          })
          yield* runner.tasks.record({
            id: "run_receipt",
            agentID: good.id,
            sessionID: session.id,
            at: Date.now(),
            status: "blocked",
            blockedReason: "Waiting for an approval",
            scheduleVersion: 1,
            trigger,
          })
          const file = path.join(directory, "storage", "raya", "agent-runs", `${bad.id}.json`)
          yield* fs.writeFileString(file, "{")
          const bytes = yield* fs.readFileString(file)
          const waiting = runner.tasks.runsFor(good.id).pipe(
            Effect.repeat({
              schedule: Schedule.spaced(10),
              until: (rows) => rows.some((row) => row.blockedReason === "waiting on you"),
            }),
            Effect.timeout("5 seconds"),
          )
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* RayaTaskRunner.subscribe(input)
              emit(session.id, "per_recovered_receipt", false)
              yield* waiting
              emit(session.id, "per_recovered_receipt", true)
              const page = yield* inbox.page(good.id).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced(10),
                  until: (page) => page.messages.some((row) => row.source.startsWith("authority:")),
                }),
                Effect.timeout("5 seconds"),
              )
              const receipts = page.messages.filter((row) => row.source.startsWith("authority:"))
              expect(receipts).toHaveLength(1)
              expect(receipts[0].body).toContain("Decision: Approved for this call")
              expect(receipts[0].body).toContain("Run: run_receipt")
              expect(receipts[0].sessionID).toBe(session.id)
            }),
          )
          expect(yield* fs.readFileString(file)).toBe(bytes)
          // Park through the real public lifecycle before reopening its subscription;
          // startup must not dispatch a model to manufacture this permission proof.
          yield* runner.park(session.id, true)
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* RayaTaskRunner.subscribe(input)
              emit(session.id, "per_recovered_receipt", true)
              yield* runner.tasks.runsFor(good.id).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced(10),
                  until: (rows) => rows.some((row) => row.id === "run_receipt" && row.status === "running"),
                }),
                Effect.timeout("5 seconds"),
              )
            }),
          )
          expect(
            (yield* inbox.page(good.id)).messages.filter((row) => row.source.startsWith("authority:")),
          ).toHaveLength(1)
          expect(yield* fs.readFileString(file)).toBe(bytes)
          const rows = yield* runner.tasks.runsFor(good.id)
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: {
              rayaRoutine: { version: 2, agentID: bad.id, runID: "run_receipt", scheduleVersion: 1, trigger },
            },
          })
          const denied = yield* runner.park(session.id, true).pipe(Effect.exit)
          expect(Exit.isFailure(denied)).toBe(true)
          if (Exit.isFailure(denied)) expect(Cause.squash(denied.cause)).toBeInstanceOf(RayaTask.HistoryError)
          expect(yield* runner.tasks.runsFor(good.id)).toEqual(rows)
          expect(yield* fs.readFileString(file)).toBe(bytes)
          for (const raw of [
            { version: 2 },
            { version: 2, agentID: good.id, runID: "foreign", scheduleVersion: 1, trigger },
            { version: 2, agentID: good.id, runID: "run_receipt", scheduleVersion: 2, trigger },
          ]) {
            yield* sessions.setMetadata({ sessionID: session.id, metadata: { rayaRoutine: raw } })
            const refused = yield* runner.park(session.id, true).pipe(Effect.exit)
            expect(Exit.isFailure(refused)).toBe(true)
            if (Exit.isFailure(refused)) expect(Cause.squash(refused.cause)).toBeInstanceOf(RayaTask.GuardError)
            expect(yield* runner.tasks.runsFor(good.id)).toEqual(rows)
          }
          yield* fs.remove(file)
          yield* fs.makeDirectory(file)
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: {
              rayaRoutine: { version: 2, agentID: bad.id, runID: "run_receipt", scheduleVersion: 1, trigger },
            },
          })
          const failure = yield* runner.park(session.id, true).pipe(Effect.exit)
          expect(Exit.isFailure(failure)).toBe(true)
          if (Exit.isFailure(failure)) expect(Cause.squash(failure.cause)).not.toBeInstanceOf(RayaTask.HistoryError)
          expect(
            (yield* inbox.page(good.id)).messages.filter((row) => row.source.startsWith("authority:")),
          ).toHaveLength(1)
        }).pipe(Effect.provide(Storage.layerWithDatabase(path.join(directory, "storage"))))
      })
    }),
  30_000,
)

for (const reason of ["json", "schema", "inconsistent"] as const)
  it.live(`one ${reason} history refuses its routine while other real queued work progresses`, () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const root = path.join(directory, "storage")
      const state = profile(directory)
      const saved = yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const tasks = RayaTask.make(input)
        const at = Date.now() + 60_000
        const bad = yield* tasks.create({
          name: "Affected",
          objective: "Work",
          access: "brief",
          schedule: { kind: "once", at },
        })
        const good = yield* tasks.create({
          name: "Healthy",
          objective: "Work",
          access: "brief",
          schedule: { kind: "once", at },
        })
        yield* tasks.record({
          id: "retained",
          agentID: bad.id,
          at: at - 1000,
          sessionID: SessionID.make("ses_retained"),
          status: "complete",
          trigger: { kind: "manual" },
        })
        const file = path.join(root, "raya", "agent-runs", `${bad.id}.json`)
        const fs = yield* FSUtil.Service
        const original = yield* fs.readFileString(file)
        const history = Schema.decodeUnknownSync(RayaTask.History)(JSON.parse(original))
        const corrupt =
          reason === "json"
            ? "{"
            : reason === "schema"
              ? JSON.stringify({ version: 1 })
              : JSON.stringify({ ...history, events: history.events.map((event) => ({ ...event, stream: "foreign" })) })
        yield* fs.writeFileString(file, corrupt)
        const refused = yield* tasks.runsFor(bad.id).pipe(Effect.flip)
        expect(refused).toBeInstanceOf(RayaTask.HistoryError)
        expect(refused).toBeInstanceOf(RayaTask.GuardError)
        expect(refused.kind).toBe("unavailable")
        expect(refused.field).toBe("history")
        expect(refused.message).not.toContain(corrupt)
        expect(refused.reason).toBe(reason)
        expect(refused.agentID).toBe(bad.id)
        const identity = {
          ...input,
          session: {
            id: "ses_retained",
            metadata: {
              rayaRoutine: {
                version: 2,
                agentID: bad.id,
                runID: "retained",
                scheduleVersion: bad.scheduleVersion ?? 1,
                trigger: { kind: "manual" },
              },
            },
          },
        }
        expect(yield* continuation(identity)).toBe(false)
        let entered = false
        expect(
          yield* owned(
            identity,
            Effect.sync(() => {
              entered = true
            }),
          ),
        ).toBeUndefined()
        expect(entered).toBe(false)
        const listed = yield* tasks.preview(at)
        expect(listed.find((item) => item.id === bad.id)).toMatchObject({ enabled: false })
        expect(listed.find((item) => item.id === bad.id)?.nextRun).toBeUndefined()
        expect(listed.find((item) => item.id === bad.id)?.note).toContain("history needs attention")
        expect(listed.find((item) => item.id === good.id)?.nextRun).toBe(at)
        const unavailable = listed.find((item) => item.id === bad.id)
        if (!unavailable) throw new Error("Affected preview required")
        expect(tasks.unavailable(unavailable)).toBe(reason)
        expect(tasks.unavailable({ ...unavailable })).toBeUndefined()
        expect((yield* tasks.get(bad.id)).enabled).toBe(true)
        const sessions = yield* Session.Service
        const runner = RayaTaskRunner.make({ ...input, sessions })
        const preview = yield* runner.preview(at)
        expect(preview.find((item) => item.id === bad.id)?.nextRun).toBeUndefined()
        expect(preview.find((item) => item.id === bad.id)?.note).toContain("history needs attention")
        expect(preview.find((item) => item.id === good.id)?.nextRun).toBe(at)
        expect((yield* tasks.ready(at)).map((item) => item.id)).toEqual([good.id])
        const schedule = scheduler(input)
        expect(Exit.isFailure(yield* schedule.prepare(bad.id, at).pipe(Effect.exit))).toBe(true)
        const trigger = yield* schedule.prepare(good.id, at)
        if (!trigger) throw new Error("Healthy original occurrence required")
        const queue = RayaTaskQueue.make(input.database)
        expect(yield* queue.pending(bad.id, bad.scheduleVersion ?? 1)).toEqual([])
        expect((yield* queue.get(trigger.id))?.state).toBe("queued")
        const writing = yield* tasks
          .record({
            id: "refused-new-run",
            agentID: bad.id,
            at,
            sessionID: SessionID.make("ses_refused_new_run"),
            status: "complete",
            trigger: { kind: "manual" },
          })
          .pipe(Effect.flip)
        expect(writing).toBeInstanceOf(RayaTask.HistoryError)
        expect(yield* fs.readFileString(file)).toBe(corrupt)
        return { bad, good, at, file, original, corrupt, trigger }
      }).pipe(Effect.provide(state))
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const tasks = RayaTask.make(input)
        const fs = yield* FSUtil.Service
        expect((yield* tasks.ready(saved.at)).map((item) => item.id)).toEqual([saved.good.id])
        expect(yield* scheduler(input).prepare(saved.good.id, saved.at)).toEqual(saved.trigger)
        expect(yield* fs.readFileString(saved.file)).toBe(saved.corrupt)
        yield* fs.writeFileString(saved.file, saved.original)
        expect(yield* tasks.runsFor(saved.bad.id)).toHaveLength(1)
        expect((yield* tasks.ready(saved.at)).map((item) => item.id)).toContain(saved.bad.id)
        expect(yield* fs.readFileString(saved.file)).toBe(saved.original)
      }).pipe(Effect.provide(state))
    }),
  )

it.live(
  "corrupt event history is isolated while missing and valid disabled histories keep their original meaning",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const input = { storage: yield* Storage.Service, database: yield* Database.Service }
        const sessions = yield* Session.Service
        const runner = RayaTaskRunner.make({ ...input, sessions })
        const tasks = runner.tasks
        const bad = yield* tasks.create({
          name: "Affected event",
          objective: "Work",
          access: "brief",
          schedule: { kind: "event", source: "fixture" },
        })
        const good = yield* tasks.create({
          name: "Healthy event",
          objective: "Work",
          access: "brief",
          schedule: { kind: "event", source: "fixture" },
        })
        const disabled = yield* tasks.create({
          name: "Disabled valid",
          objective: "Work",
          enabled: false,
          access: "brief",
          schedule: { kind: "event", source: "fixture" },
        })
        yield* tasks.record({
          id: "disabled-retained",
          agentID: disabled.id,
          at: Date.now(),
          sessionID: SessionID.make("ses_disabled_retained"),
          status: "complete",
          trigger: { kind: "manual" },
        })
        yield* input.storage.write(["raya", "agent-runs", bad.id], { version: 1 })
        expect((yield* tasks.listenFor("fixture")).map((item) => item.id)).toEqual([good.id])
        expect(yield* tasks.runsFor(good.id)).toEqual([])
        expect(yield* tasks.runsFor(disabled.id)).toHaveLength(1)
        const listed = yield* tasks.preview(Date.now())
        const valid = listed.find((item) => item.id === disabled.id)
        if (!valid) throw new Error("Disabled preview required")
        expect(tasks.unavailable(valid)).toBeUndefined()
        const preview = yield* runner.preview(Date.now())
        expect(preview).toHaveLength(3)
        expect(preview.find((item) => item.id === disabled.id)?.enabled).toBe(false)
        expect(preview.find((item) => item.id === disabled.id)?.note ?? "").not.toContain("history needs attention")
        expect(yield* input.storage.read(["raya", "agent-runs", bad.id])).toEqual({ version: 1 })
      }).pipe(Effect.provide(profile(directory)))
    }),
)

it.live("an actual filesystem read failure is not reclassified as damaged routine history", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const root = path.join(directory, "storage")
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const tasks = RayaTask.make({ storage })
      const agent = yield* tasks.create({
        name: "Unavailable file",
        objective: "Work",
        access: "brief",
        schedule: { kind: "manual" },
      })
      const fs = yield* FSUtil.Service
      yield* fs.makeDirectory(path.join(root, "raya", "agent-runs", `${agent.id}.json`), { recursive: true })
      const result = yield* tasks.preview(Date.now()).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).not.toBeInstanceOf(RayaTask.HistoryError)
        expect(Cause.hasDies(result.cause)).toBe(true)
      }
      expect((yield* tasks.get(agent.id)).enabled).toBe(true)
    }).pipe(Effect.provide(profile(directory)))
  }),
)

it.live("ordinary completion isolates only unrelated damaged history and preserves exact original settlement", () =>
  provideTmpdirInstance((directory) =>
    Effect.gen(function* () {
      const root = path.join(directory, "storage")
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const sessions = yield* Session.Service
        const runner = RayaTaskRunner.make({ storage, database, sessions })
        const fs = yield* FSUtil.Service
        const at = Date.now()
        const bad = yield* runner.tasks.create({
          name: "Earlier damaged history",
          objective: "Preserve",
          access: "brief",
          schedule: { kind: "manual" },
        })
        const good = yield* runner.tasks.create({
          name: "Healthy completion",
          objective: "Finish",
          access: "brief",
          schedule: { kind: "once", at },
        })
        const session = yield* sessions.create({ title: "Original routine completion", agent: "auto" })
        const trigger = yield* scheduler({ storage, database }).prepare(good.id, at)
        if (!trigger) throw new Error("Expected actual scheduled occurrence")
        const run = {
          id: "run_history_completion",
          agentID: good.id,
          sessionID: session.id,
          at,
          status: "running" as const,
          scheduleVersion: good.scheduleVersion ?? 1,
          trigger,
        }
        const queue = RayaTaskQueue.make(database)
        yield* queue.claim({
          id: trigger.id,
          claimID: run.id,
          owner: "original-completion",
          now: at,
          until: at + 180_000,
        })
        yield* queue.link({ id: trigger.id, claimID: run.id, sessionID: session.id, now: at })
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: {
            rayaRoutine: { version: 2, agentID: good.id, runID: run.id, scheduleVersion: run.scheduleVersion, trigger },
          },
        })
        yield* runner.tasks.record(run)
        const goals = RayaGoal.make({ storage, sessions })
        yield* goals.create(session.id, "Finish")
        const goal = yield* goals.get(session.id)
        if (!goal) throw new Error("Expected actual retained goal")
        yield* storage.replace(["raya", "goal", session.id], {
          ...goal,
          status: "complete",
          audit: { summary: "Model-free terminal fixture", verifiedAt: at, requirements: [] },
          updatedAt: at,
        })
        yield* storage.write(["raya", "agent-runs", bad.id], { version: 1 })
        const file = path.join(root, "raya", "agent-runs", `${bad.id}.json`)
        const bytes = yield* fs.readFileString(file)
        yield* runner.settle(session.id)
        const history = yield* runner.tasks.runsFor(good.id)
        expect(history.find((item) => item.id === run.id)?.status).toBe("complete")
        expect((yield* queue.get(trigger.id))?.state).toBe("complete")
        const inbox = RayaTaskInbox.make(database)
        const messages = (yield* inbox.page(good.id)).messages
        expect(messages.filter((item) => item.source === `report:${run.id}`)).toHaveLength(1)
        yield* runner.settle(session.id)
        expect(yield* runner.tasks.runsFor(good.id)).toEqual(history)
        expect((yield* inbox.page(good.id)).messages).toEqual(messages)
        expect(yield* fs.readFileString(file)).toBe(bytes)
        expect((yield* runner.tasks.get(bad.id)).enabled).toBe(true)
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: {
            rayaRoutine: { version: 2, agentID: bad.id, runID: "bad", scheduleVersion: 1, trigger: { kind: "manual" } },
          },
        })
        const refused = yield* runner.settle(session.id).pipe(Effect.flip)
        expect(refused).toBeInstanceOf(RayaTask.HistoryError)
        expect(yield* fs.readFileString(file)).toBe(bytes)
        for (const metadata of [{}, { rayaRoutine: { version: 2, agentID: good.id } }]) {
          yield* sessions.setMetadata({ sessionID: session.id, metadata })
          expect((yield* sessions.get(session.id)).metadata).toEqual(metadata)
          const denied = yield* runner.settle(session.id).pipe(Effect.flip)
          expect(denied).toBeInstanceOf(RayaTask.HistoryError)
          if (denied instanceof RayaTask.HistoryError) expect(denied.agentID).toBe(bad.id)
          expect(yield* fs.readFileString(file)).toBe(bytes)
          expect(yield* runner.tasks.runsFor(good.id)).toEqual(history)
          expect((yield* inbox.page(good.id)).messages).toEqual(messages)
          expect((yield* queue.get(trigger.id))?.state).toBe("complete")
        }
        yield* sessions.setMetadata({
          sessionID: session.id,
          metadata: {
            rayaRoutine: { version: 2, agentID: good.id, runID: run.id, scheduleVersion: run.scheduleVersion, trigger },
          },
        })
        yield* fs.remove(file)
        yield* fs.makeDirectory(file)
        const failed = yield* runner.settle(session.id).pipe(Effect.exit)
        expect(Exit.isFailure(failed)).toBe(true)
        if (Exit.isFailure(failed)) {
          expect(Cause.hasDies(failed.cause)).toBe(true)
          expect(Cause.squash(failed.cause)).not.toBeInstanceOf(RayaTask.HistoryError)
        }
        expect(yield* runner.tasks.runsFor(good.id)).toEqual(history)
        expect((yield* inbox.page(good.id)).messages).toEqual(messages)
      }).pipe(Effect.provide(profile(directory)))
    }),
  ),
)
