import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Bus } from "@/bus"
import { Git } from "@/git"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { KiloSession } from "@/kilocode/session"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { InstanceState } from "@/effect/instance-state"
import { disposeInstance } from "@/effect/instance-registry"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Bus.node, FSUtil.node, Git.node, CrossSpawnSpawner.node])))

it.instance("repeated concurrent initialization shares one routine subscription per instance", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* tmpdirScoped(), "storage")
    const bus = yield* Bus.Service
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const listeners = GlobalBus.listenerCount("event")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const initialize = yield* RayaTaskRunner.lifecycle({
            bus,
            storage,
            sessions: {
              create: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              messages: () => Effect.succeed([]),
              children: () => Effect.succeed([]),
            },
          })
          yield* Effect.all([initialize(), initialize(), initialize()], { concurrency: 3 })
          expect(GlobalBus.listenerCount("event")).toBe(listeners + 1)
          yield* initialize()
          expect(GlobalBus.listenerCount("event")).toBe(listeners + 1)
          const context = yield* InstanceState.context
          yield* Effect.promise(() => disposeInstance(context.directory))
          expect(GlobalBus.listenerCount("event")).toBe(listeners)
          yield* initialize()
          expect(GlobalBus.listenerCount("event")).toBe(listeners + 1)
        }),
      )
      expect(GlobalBus.listenerCount("event")).toBe(listeners)
    }).pipe(Effect.provide(Storage.layerFromDir(directory)))
  }),
)

it.instance(
  "real turn-close delivery is interrupted without publishing a terminal run when the subscription closes",
  () =>
    Effect.gen(function* () {
      const directory = path.join(yield* tmpdirScoped(), "storage")
      const bus = yield* Bus.Service
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const tasks = RayaTask.make({ storage })
        const entered = yield* Deferred.make<void>()
        const interrupted: boolean[] = []
        const agent = yield* tasks.create({ name: "Routine", objective: "Work", schedule: { kind: "manual" } })
        const sid = SessionID.make("ses_subscription")
        const listeners = GlobalBus.listenerCount("event")
        const expected = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* RayaTaskRunner.subscribe({
              bus,
              storage,
              sessions: {
                create: () => Effect.die("unexpected session creation"),
                get: () => Effect.die("unexpected session read"),
                children: () => Effect.succeed([]),
                messages: () =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Effect.sync(() => interrupted.push(true))),
                  ),
              },
            })
            const run = yield* tasks.record({
              id: "run",
              agentID: agent.id,
              sessionID: sid,
              at: Date.now(),
              status: "running",
            })
            yield* bus.publish(KiloSession.Event.TurnClose, { sessionID: sid, reason: "completed" })
            yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
            return run
          }),
        )
        expect(interrupted).toEqual([true])
        expect(GlobalBus.listenerCount("event")).toBe(listeners)
        expect(yield* tasks.runsFor(agent.id)).toEqual([expected])
        expect(yield* tasks.recall(agent.id)).toBe("")

        const delivered = yield* Deferred.make<void>()
        yield* Effect.acquireRelease(
          bus.subscribeCallback(KiloSession.Event.TurnClose, () =>
            Effect.runFork(Deferred.succeed(delivered, undefined)),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        )
        yield* bus.publish(KiloSession.Event.TurnClose, { sessionID: sid, reason: "completed" })
        yield* Deferred.await(delivered).pipe(Effect.timeout("5 seconds"))
        expect(interrupted).toEqual([true])
        expect(yield* tasks.runsFor(agent.id)).toEqual([expected])
      }).pipe(Effect.provide(Storage.layerFromDir(directory)))
    }),
)
