import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Deferred, Effect, Layer } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/fixture"

const root = LayerNode.group([
  FSUtil.node,
  Git.node,
  Database.node,
  Session.node,
  SessionProjector.node,
  Storage.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
])
const env = AppNodeBuilder.build(root, [
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
])
const it = testEffect(env.pipe(Layer.provide(RuntimeFlags.layer())))

for (const attached of [false, true])
  it.instance(
    `cold ${attached ? "attached queued goal" : "accepted intake"} retains delegation without execution until explicit cancellation`,
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        return yield* Effect.gen(function* () {
          const database = yield* Database.Service
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const calls: string[] = []
          const input = {
            database,
            storage,
            sessions,
            continuation: (
              run: Parameters<NonNullable<Parameters<typeof RayaTaskRunner.make>[0]["continuation"]>>[0],
            ) =>
              Effect.sync(() => {
                calls.push(run.id)
              }),
          }
          const runner = RayaTaskRunner.make(input)
          const sender = yield* runner.tasks.create({
            name: "Cold sender",
            objective: "Coordinate",
            enabled: true,
            schedule: { kind: "manual" },
          })
          const recipient = yield* runner.tasks.create({
            name: "Cold recipient",
            objective: "Retain accepted work",
            enabled: true,
            schedule: { kind: "manual" },
          })
          const errands = RayaTaskDelegation.make(database)
          const admitted = yield* errands.admit(
            {
              source: `cold_${crypto.randomUUID()}`,
              senderID: sender.id,
              recipientID: recipient.id,
              objective: "OLD_ACCEPTED_MUST_NOT_REPLAY",
            },
            sender,
            recipient,
          )
          const taken = yield* errands.take(recipient.id)
          if (!taken?.childRunID) throw new Error("Actual delegation intake did not accept")
          const goals = RayaGoal.make({ storage, sessions })
          const session = attached
            ? yield* sessions.create({
                metadata: {
                  rayaRoutine: {
                    version: 1,
                    agentID: recipient.id,
                    runID: taken.childRunID,
                    scheduleVersion: 1,
                    trigger: { kind: "manual" },
                    delegationID: taken.id,
                  },
                },
              })
            : undefined
          if (session) {
            yield* runner.tasks.record({
              id: taken.childRunID,
              agentID: recipient.id,
              sessionID: session.id,
              at: Date.now(),
              status: "running",
              scheduleVersion: 1,
              trigger: { kind: "manual" },
            })
            yield* goals.create(session.id, "OLD_ACCEPTED_MUST_NOT_REPLAY")
            yield* goals.continued(session.id)
            yield* errands.attach(taken.id, taken.childRunID, session.id)
          }
          const queued = yield* errands.admit(
            {
              source: `queue_${crypto.randomUUID()}`,
              senderID: sender.id,
              recipientID: recipient.id,
              objective: "OLD_QUEUED_MUST_NOT_REPLAY",
            },
            sender,
            recipient,
          )
          const before = yield* errands.get(admitted.record.id)
          const pending = yield* errands.get(queued.record.id)
          const rows = yield* database.db.select().from(SessionTable).all()
          const history = yield* runner.tasks.runsFor(recipient.id)
          const goal = session ? yield* goals.get(session.id) : undefined
          const execution = RayaTaskExecution.make(storage)
          if (session)
            expect(
              yield* execution.receipt({ id: taken.childRunID, agentID: recipient.id, sessionID: session.id }),
            ).toBeUndefined()
          for (const _ of [1, 2]) {
            yield* Effect.gen(function* () {
              const reopened = RayaTaskRunner.make({ ...input, storage: yield* Storage.Service })
              yield* reopened.revive()
              yield* reopened.revive()
              yield* reopened.tick(Date.now())
              expect(calls).toEqual([])
              expect(yield* database.db.select().from(SessionTable).all()).toEqual(rows)
              expect(yield* errands.get(before.id)).toEqual(before)
              expect(yield* errands.get(pending.id)).toEqual(pending)
              expect(yield* reopened.tasks.runsFor(recipient.id)).toEqual(history)
              if (session) expect(yield* goals.get(session.id)).toEqual(goal)
            }).pipe(Effect.provide(Storage.layerFromDir(directory)))
          }
          const reopened = RayaTaskRunner.make(input)
          yield* reopened.revive()
          expect(
            yield* reopened.delegate({
              source: before.source,
              senderID: sender.id,
              recipientID: recipient.id,
              objective: before.objective,
            }),
          ).toEqual(before)
          expect(yield* errands.get(before.id)).toEqual(before)
          expect(calls).toEqual([])
          expect((yield* reopened.stop(before.id)).state).toBe("cancelled")
          expect((yield* errands.get(pending.id)).state).toBe("queued")
          expect(calls).toEqual([])
          const fresh = yield* reopened.delegate({
            source: `fresh_${crypto.randomUUID()}`,
            senderID: sender.id,
            recipientID: recipient.id,
            objective: "EXPLICIT_NEW_GENERATION",
          })
          expect(fresh.childRunID).not.toBe(before.childRunID)
          expect(fresh.state).toBe("running")
          expect(yield* errands.get(pending.id)).toEqual(pending)
          for (const _ of Array.from({ length: 100 })) {
            if (calls.length) break
            yield* Effect.sleep("10 millis")
          }
          expect(calls).toEqual([fresh.childRunID!])
          if (!fresh.sessionID || !fresh.childRunID) throw new Error("Fresh delegation identity absent")
          const owner = { id: fresh.childRunID, agentID: recipient.id, sessionID: fresh.sessionID }
          for (const _ of Array.from({ length: 100 })) {
            if ((yield* execution.receipt(owner))?.state === "idle") break
            yield* Effect.sleep("10 millis")
          }
          expect((yield* execution.receipt(owner))?.state).toBe("idle")
          yield* execution.finish(owner)
          expect((yield* errands.get(before.id)).state).toBe("cancelled")
          expect((yield* reopened.stop(pending.id)).state).toBe("cancelled")
          expect((yield* errands.get(pending.id)).state).toBe("cancelled")
          expect((yield* reopened.stop(fresh.id)).state).toBe("cancelled")
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      }),
    30000,
  )

it.instance(
  "new first-lifecycle delegation enters once before revival and is never mistaken for retained intake",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      return yield* Effect.gen(function* () {
        const database = yield* Database.Service
        const storage = yield* Storage.Service
        const sessions = yield* Session.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const calls: string[] = []
        const runner = RayaTaskRunner.make({
          database,
          storage,
          sessions,
          continuation: (run) =>
            Effect.gen(function* () {
              calls.push(run.id)
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
            }),
        })
        const sender = yield* runner.tasks.create({
          name: "New sender",
          objective: "Coordinate",
          enabled: true,
          schedule: { kind: "manual" },
        })
        const recipient = yield* runner.tasks.create({
          name: "New recipient",
          objective: "Only new authorized work",
          enabled: true,
          schedule: { kind: "manual" },
        })
        return yield* Effect.gen(function* () {
          const row = yield* runner.delegate({
            source: `new_${crypto.randomUUID()}`,
            senderID: sender.id,
            recipientID: recipient.id,
            objective: "NEW_FIRST_LIFECYCLE",
          })
          yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
          const errands = RayaTaskDelegation.make(database)
          const before = yield* errands.get(row.id)
          const next = yield* runner.delegate({
            source: `next_${crypto.randomUUID()}`,
            senderID: sender.id,
            recipientID: recipient.id,
            objective: "NEW_SAME_LIFECYCLE_QUEUE",
          })
          expect(next.state).toBe("queued")
          const second = yield* tmpdirScoped()
          const instances = yield* InstanceStore.Service
          const lazy = RayaTaskRunner.make({
            database,
            storage,
            sessions,
            continuation: (run) =>
              Effect.sync(() => {
                calls.push(run.id)
              }),
          })
          yield* instances.provide({ directory: second }, lazy.revive())
          yield* runner.revive()
          yield* runner.revive()
          expect(yield* errands.get(row.id)).toEqual(before)
          expect(calls).toEqual([row.childRunID!])
          expect(before.state).toBe("running")
          expect((yield* runner.tasks.runsFor(recipient.id)).map((run) => run.id)).toEqual([row.childRunID!])
          yield* Deferred.succeed(release, undefined)
          if (!row.sessionID || !row.childRunID) throw new Error("New delegation identity absent")
          const execution = RayaTaskExecution.make(storage)
          const owner = { id: row.childRunID, agentID: recipient.id, sessionID: row.sessionID }
          for (const _ of Array.from({ length: 100 })) {
            if ((yield* execution.receipt(owner))?.state === "idle") break
            yield* Effect.sleep("10 millis")
          }
          expect((yield* execution.receipt(owner))?.state).toBe("idle")
          yield* execution.finish(owner)
          expect((yield* instances.provide({ directory: second }, lazy.stop(row.id))).state).toBe("cancelled")
          for (const _ of Array.from({ length: 100 })) {
            if (calls.length === 2) break
            yield* Effect.sleep("10 millis")
          }
          const started = yield* errands.get(next.id)
          expect(started.state).toBe("running")
          expect(calls).toEqual([row.childRunID, started.childRunID!])
          if (!started.sessionID || !started.childRunID) throw new Error("Same-lifecycle queued identity absent")
          expect((yield* sessions.get(started.sessionID)).directory).toBe(second)
          const queued = { id: started.childRunID, agentID: recipient.id, sessionID: started.sessionID }
          for (const _ of Array.from({ length: 100 })) {
            if ((yield* execution.receipt(queued))?.state === "idle") break
            yield* Effect.sleep("10 millis")
          }
          expect((yield* execution.receipt(queued))?.state).toBe("idle")
          yield* execution.finish(queued)
          expect((yield* instances.provide({ directory: second }, lazy.stop(started.id))).state).toBe("cancelled")
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      }).pipe(Effect.provide(Storage.layerFromDir(directory)))
    }),
  30000,
)
