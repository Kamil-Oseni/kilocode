import { expect } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import {
  RayaRoutineConversationTable as Conversation,
  RayaRoutineMessageTable as Message,
  RayaRoutineOccurrenceTable as Occurrence,
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationTable as Organization,
  RayaRoutineOrganizationMemberTable as Member,
} from "@opencode-ai/core/kilocode/routine.sql"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { hold } from "@/kilocode/task/hold"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaGoal } from "@/kilocode/goal"
import { ProjectV2 } from "@opencode-ai/core/project"
import type { Session } from "@/session/session"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const input = {
  name: "Saved worker",
  objective: "Retain my work",
  access: "brief" as const,
  schedule: { kind: "manual" as const },
}
const layers = (dir: string) =>
  Layer.mergeAll(
    Storage.layerFromDir(path.join(dir, "storage")),
    Database.layerFromPath(path.join(dir, "profile.sqlite")),
  )
const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("Expected transfer hold refusal")
      expect(Cause.pretty(exit.cause)).toContain("transferred profile")
    }),
  )

it.live(
  "transfer hold survives reopening and requires explicit review of its exact generation",
  () =>
    Effect.gen(function* () {
      const dir = path.join(yield* tmpdirScoped(), "storage")
      const saved = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const gate = hold(storage)
        expect(yield* gate.get()).toBeUndefined()
        yield* gate.check()
        const worker = yield* RayaTask.make({ storage }).create(input)
        const saved = yield* gate.begin()
        expect((yield* gate.begin()).id).toBe(saved.id)
        return { id: saved.id, worker }
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const gate = hold(storage)
        expect(yield* gate.held()).toBe(true)
        yield* refused(gate.check())
        yield* refused(gate.release("obsolete", { reviewed: true }))
        yield* refused(gate.release(saved.id, { reviewed: false }))
        const released = yield* gate.release(saved.id, { reviewed: true })
        expect(released.review?.by).toBe("user")
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        expect(yield* hold(storage).held()).toBe(false)
        const tasks = RayaTask.make({ storage })
        expect(yield* tasks.get(saved.worker.id)).toEqual(saved.worker)
        expect((yield* tasks.create({ ...input, name: "After review" })).name).toBe("After review")
        const next = yield* hold(storage).begin()
        expect(next.id).not.toBe(saved.id)
        yield* refused(hold(storage).release(saved.id, { reviewed: true }))
      }).pipe(Effect.provide(Storage.layerFromDir(dir)))
    }),
  30_000,
)

it.live(
  "held restart leaves inbox, queues, goals, histories and execution effects untouched",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const sid = SessionID.make("ses_transferred_pending")
      const ids = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        const worker = yield* tasks.create({ ...input, schedule: { kind: "once", at: 100 } })
        const event = yield* tasks.create({
          ...input,
          name: "Event worker",
          schedule: { kind: "event", source: "transfer-test" },
        })
        yield* tasks.record({ id: "imported-run", agentID: worker.id, sessionID: sid, at: 100, status: "running" })
        yield* RayaGoal.make({
          storage,
          sessions: { messages: () => Effect.succeed([]), children: () => Effect.succeed([]) },
        }).create(sid, "Retain my saved goal")
        yield* database.db
          .insert(Conversation)
          .values({ agent_id: worker.id, id: "saved-inbox", read_at: 0, draft: "Saved draft", time_updated: 100 })
          .run()
        yield* database.db
          .insert(Message)
          .values({
            id: "pending-note",
            agent_id: worker.id,
            source: "imported-source",
            kind: "user",
            body: "Retain this pending question",
            time_created: 100,
          })
          .run()
        yield* database.db
          .insert(Occurrence)
          .values({
            id: "pending-timer",
            agent_id: worker.id,
            schedule_version: 1,
            scheduled_at: 100,
            observed_at: 100,
            state: "queued",
            time_updated: 100,
          })
          .run()
        yield* database.db
          .insert(Delegation)
          .values({
            id: "pending-work",
            source: "saved-assignment",
            sender_id: event.id,
            recipient_id: worker.id,
            objective: "Retain pending assignment",
            depth: 1,
            state: "queued",
            time_created: 100,
            time_updated: 100,
          })
          .run()
        yield* hold(storage).begin()
        return { worker: worker.id, event: event.id }
      }).pipe(Effect.provide(layers(dir)))
      for (const attempt of [0, 1]) {
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const database = yield* Database.Service
          const calls = { session: 0, turn: 0, halt: 0 }
          // External effect ports are tripwires, not replacements for persistence:
          // all admission/recovery, filesystem and SQLite code below is production.
          const sessions = {
            create: () =>
              Effect.sync(() => {
                calls.session++
                throw new Error("Unexpected session creation")
              }),
            get: () => Effect.die("Unexpected session read during held admission"),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          }
          const runner = RayaTaskRunner.make({
            storage,
            database,
            sessions,
            continuation: () =>
              Effect.sync(() => {
                calls.turn++
                throw new Error("Unexpected model/tool continuation")
              }),
            halt: () =>
              Effect.sync(() => {
                calls.halt++
                throw new Error("Unexpected process halt")
              }),
          })
          const before = {
            roster: yield* runner.tasks.list(),
            history: yield* runner.tasks.runsFor(ids.worker),
            goal: yield* storage.read(["raya", "goal", sid]),
            inbox: yield* database.db.select().from(Message).all(),
            queue: yield* database.db.select().from(Occurrence).all(),
            work: yield* database.db.select().from(Delegation).all(),
          }
          yield* runner.revive()
          yield* runner.recoverStops()
          yield* runner.tick(1000 + attempt)
          yield* runner.settle(sid)
          expect(yield* runner.announce("transfer-test")).toEqual([])
          for (const operation of [
            refused(runner.fire(ids.worker)),
            refused(runner.ask(ids.worker, "New question")),
            refused(runner.dispatch(ids.worker)),
            refused(runner.resume(sid)),
            refused(runner.reviewReply(sid, "old-intent")),
            refused(runner.resolve(ids.worker, "imported-run")),
            refused(
              runner.delegate({
                senderID: ids.event,
                recipientID: ids.worker,
                source: "new-source",
                objective: "New task",
              }),
            ),
            refused(runner.tasks.create(input)),
            refused(runner.tasks.provision(input, "new-worker")),
            refused(runner.tasks.stage(input, "new-stage", "org_fixture")),
            refused(runner.tasks.activate(input, ids.worker, "org_fixture")),
            refused(runner.tasks.update(ids.worker, { enabled: true })),
            refused(runner.tasks.authority(ids.worker, { enabled: true, expected: false }, "user")),
          ])
            yield* operation
          expect(yield* runner.tasks.ready(1000)).toEqual([])
          expect((yield* runner.tasks.recoverStages()).recovered).toBe(0)
          expect(yield* runner.tasks.list()).toEqual(before.roster)
          expect(yield* runner.tasks.runsFor(ids.worker)).toEqual(before.history)
          expect(yield* storage.read(["raya", "goal", sid])).toEqual(before.goal)
          expect(yield* database.db.select().from(Message).all()).toEqual(before.inbox)
          expect(yield* database.db.select().from(Occurrence).all()).toEqual(before.queue)
          expect(yield* database.db.select().from(Delegation).all()).toEqual(before.work)
          expect(yield* storage.list(["raya", "agent-claims"])).toEqual([])
          expect(yield* storage.list(["raya", "agent-executions"])).toEqual([])
          expect(yield* storage.list(["raya", "agent-stage"])).toEqual([])
          expect(calls).toEqual({ session: 0, turn: 0, halt: 0 })
        }).pipe(Effect.provide(layers(dir)))
      }
    }),
  30_000,
)

it.live(
  "a hold armed while session creation is in flight prevents subsequent worker execution",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const entered = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const calls = { session: 0, turn: 0 }
        const rows = new Map<SessionID, Session.Info>()
        const sessions = {
          create: (value?: Parameters<Session.Interface["create"]>[0]) =>
            Effect.gen(function* () {
              calls.session++
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(finish)
              const row = {
                id: SessionID.make("ses_transfer_race"),
                slug: "race",
                title: value?.title ?? "Saved worker",
                projectID: ProjectV2.ID.make("project"),
                directory: dir,
                version: "test",
                time: { created: Date.now(), updated: Date.now() },
                metadata: value?.metadata,
                permission: value?.permission?.map((rule) => ({ ...rule })),
              }
              rows.set(row.id, row)
              return row
            }),
          get: (id: SessionID) =>
            Effect.sync(() => {
              const row = rows.get(id)
              if (!row) throw new Error("Unexpected session read")
              return row
            }),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        }
        const runner = RayaTaskRunner.make({
          storage,
          sessions,
          continuation: () =>
            Effect.sync(() => {
              calls.turn++
            }),
        })
        const worker = yield* runner.tasks.create(input)
        const fiber = yield* runner.fire(worker.id).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* hold(storage).begin()
        yield* Deferred.succeed(finish, undefined)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("transferred profile")
        expect(calls).toEqual({ session: 1, turn: 0 })
        expect(yield* runner.tasks.runsFor(worker.id)).toEqual([])
        expect(yield* storage.list(["raya", "goal"])).toEqual([])
        // The already-entered session port did run; the hold is not cancellation.
        // Source capture must drain and retire that runner before arming the fence.
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(dir, "storage"))))
    }),
  60_000,
)

it.live(
  "corrupt or unreadable transfer holds fail closed instead of appearing absent",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const worker = yield* tasks.create(input)
        for (const record of [
          { version: 2 },
          { version: 1, id: "missing-review", state: "released", createdAt: 100 },
        ]) {
          yield* storage.replace(["raya", "restore-hold"], record)
          const exit = yield* tasks.launchable(worker.id).pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("transfer review state is unreadable")
        }
        yield* storage.remove(["raya", "restore-hold"])
        yield* Effect.promise(() => mkdir(path.join(root, "storage", "raya", "restore-hold.json")))
        expect(Exit.isFailure(yield* tasks.create(input).pipe(Effect.exit))).toBe(true)
        expect(yield* tasks.get(worker.id)).toEqual(worker)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "destination review release does not lift an archived organization's permanent stop fence",
  () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const saved = yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const worker = yield* RayaTask.make({ storage, database }).create({ ...input, enabled: false })
        yield* database.db
          .insert(Organization)
          .values({
            id: "org_archived",
            name: "Archived",
            revision: 1,
            archived_at: 100,
            stopping_at: 100,
            stopped_at: 101,
            time_created: 1,
            time_updated: 101,
          })
          .run()
        yield* database.db
          .insert(Member)
          .values({
            organization_id: "org_archived",
            agent_id: worker.id,
            role: "Worker",
            position: 0,
            time_created: 1,
            time_updated: 1,
          })
          .run()
        const marker = yield* hold(storage).begin()
        return { worker, marker }
      }).pipe(Effect.provide(layers(dir)))
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const database = yield* Database.Service
        const tasks = RayaTask.make({ storage, database })
        yield* hold(storage).release(saved.marker.id, { reviewed: true })
        const exit = yield* tasks.update(saved.worker.id, { enabled: true }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("stopping or archived")
        expect((yield* database.db.select().from(Organization).all())[0].stopped_at).toBe(101)
        expect((yield* tasks.get(saved.worker.id)).enabled).toBe(false)
      }).pipe(Effect.provide(layers(dir)))
    }),
  30_000,
)
