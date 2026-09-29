import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import type { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import type { Session } from "@/session/session"
import { SessionID, type MessageID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { ExecutionIdle } from "@/kilocode/task/execution-event"
import { InstanceState } from "@/effect/instance-state"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))

// The session and invocation boundaries are fixtures; subscription, execution,
// goal transitions, task history and SQLite intake use production implementations.
for (const mode of ["same directory", "different directory"] as const)
  it.instance(
    `successful delayed body wakes exact queued routine intake once: ${mode}`,
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const database = yield* Database.Service
          const tasks = RayaTask.make({ storage, database })
          const agent = yield* tasks.create({
            name: "Idle intake",
            objective: "Answer the follow-up",
            schedule: { kind: "manual" },
          })
          const sid = SessionID.make(`ses_idle_${crypto.randomUUID()}`)
          const owner = { id: crypto.randomUUID(), agentID: agent.id, sessionID: sid }
          const trigger = { kind: "manual" as const }
          yield* tasks.record({
            ...owner,
            at: Date.now(),
            status: "running",
            scheduleVersion: agent.scheduleVersion ?? 1,
            trigger,
          })
          const session = {
            id: sid,
            directory: instance.directory,
            metadata: {
              rayaRoutine: {
                version: 2,
                agentID: agent.id,
                runID: owner.id,
                scheduleVersion: agent.scheduleVersion ?? 1,
                trigger,
              },
            },
          }
          const location = { directory: instance.directory }
          const sessions = {
            get: () => Effect.succeed({ ...session, directory: location.directory }),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          } as unknown as Pick<Session.Interface, "get" | "messages" | "children">
          const goals = RayaGoal.make({ storage, sessions })
          const goal = yield* goals.create(
            sid,
            "Fresh follow-up",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            "reply",
          )
          const queued = yield* goals.continued(sid, goal.intent)
          if (!queued?.dispatch) throw new Error("Expected actual queued dispatch")
          const inbox = RayaTaskInbox.make(database)
          yield* inbox.publish({ agentID: agent.id, source: "fresh_followup", kind: "user", body: "Fresh follow-up" })
          yield* inbox.attach(agent.id, "fresh_followup", sid)
          const calls: MessageID[] = []
          const invoked = yield* Deferred.make<void>()
          const bus = { subscribeCallback: () => Effect.succeed(() => {}) } as unknown as Bus.Interface
          const listeners = GlobalBus.listenerCount("event")
          const subscription = yield* InstanceState.make((ctx) =>
            RayaGoalContinuation.subscribe({
              database,
              directory: ctx.directory,
              storage,
              sessions,
              bus,
              enabled: () => Effect.succeed(true),
              idle: () => Effect.succeed(true),
              run: async (_sid, _objective, _directory, id) => {
                calls.push(id)
                await Effect.runPromise(Deferred.succeed(invoked, undefined))
              },
            }),
          )
          yield* InstanceState.get(subscription)
          yield* InstanceState.get(subscription)
          expect(GlobalBus.listenerCount("event")).toBe(listeners + 1)
          const execution = RayaTaskExecution.make(storage)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const body = yield* execution
            .enter(owner, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
            .pipe(Effect.forkChild)
          yield* Effect.gen(function* () {
            yield* Deferred.await(entered)
            const receipt = yield* execution.receipt(owner)
            if (!receipt) throw new Error("Expected actual busy lease")
            expect(yield* execution.enter(owner, Effect.die("Busy body admitted intake"))).toBeUndefined()
            expect((yield* goals.get(sid))?.dispatch?.phase).toBe("queued")
            expect(calls).toHaveLength(0)
            const hint = (token: string) =>
              GlobalBus.emit("event", {
                payload: {
                  type: ExecutionIdle.type,
                  properties: {
                    version: 1,
                    runID: owner.id,
                    agentID: owner.agentID,
                    sessionID: sid,
                    execution: createHash("sha256").update(token).digest("hex"),
                  },
                },
              })
            hint(crypto.randomUUID())
            yield* Effect.sleep("50 millis")
            expect(calls).toHaveLength(0)
            if (mode === "different directory") location.directory = path.join(instance.directory, "other")
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(body)
            if (mode === "different directory") {
              yield* Effect.sleep("100 millis")
              expect(calls).toHaveLength(0)
              location.directory = instance.directory
              hint(receipt.token)
            }
            yield* Deferred.await(invoked).pipe(Effect.timeout("5 seconds"))
            hint(receipt.token)
            hint(crypto.randomUUID())
            yield* Effect.sleep("100 millis")
            expect(calls).toEqual([queued.dispatch!.messageID!])
            expect((yield* goals.get(sid))?.dispatch?.phase).toBe("started")
            expect(yield* tasks.runsFor(agent.id)).toHaveLength(1)
            expect(yield* inbox.stranded(agent.id)).toBeUndefined()
            expect(yield* inbox.delivery(sid, queued.dispatch!.messageID!)).toMatchObject({
              delivered: true,
              record: { source: "fresh_followup", sessionID: sid },
            })
            yield* execution.finish(owner)
            yield* InstanceState.invalidate(subscription)
            expect(GlobalBus.listenerCount("event")).toBe(listeners)
            hint(receipt.token)
            expect(calls).toHaveLength(1)
          }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Storage.layerFromDir(path.join(instance.directory, "idle-storage")),
              Database.layerFromPath(path.join(instance.directory, "idle.sqlite")),
            ),
          ),
        )
      }),
    45_000,
  )
