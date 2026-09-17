import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Bus } from "@/bus"
import { Git } from "@/git"
import { GlobalBus } from "@/bus/global"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { KiloSession } from "@/kilocode/session"
import { RayaTask } from "@/kilocode/task"
import { RayaContactOutbox } from "@/kilocode/contact/outbox"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
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

it.instance("a restarted Routine lifecycle drains retained and newly due Raya Messenger reports", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const bus = yield* Bus.Service
    yield* Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const tasks = RayaTask.make({ storage, database })
      const inbox = RayaTaskInbox.make(database)
      const clock = { now: Date.parse("2026-09-17T05:00:00.000Z") }
      const outbox = RayaContactOutbox.make(database, () => clock.now)
      const agent = yield* tasks.create({
        name: "Books",
        role: "accountant",
        objective: "Review the weekly accounts",
        capabilities: ["accounting"],
        schedule: { kind: "manual" },
      })
      const target = yield* outbox.authorize({
        source: "contact:restart-owner",
        channel: "raya",
        address: "owner",
        scope: { kind: "agent", id: agent.id },
      })
      const delayed = yield* outbox.authorize({
        source: "contact:restart-delayed",
        channel: "raya",
        address: "owner",
        scope: { kind: "global" },
        quiet: { start: 0, end: 1439, timezone: "UTC" },
      })
      const queued = yield* outbox.enqueue({
        source: "message:restart-weekly",
        destinationID: target.id,
        agentID: agent.id,
        body: "Weekly accounts are ready after restart.",
      })
      const deferred = yield* outbox.enqueue({
        source: "message:restart-delayed",
        destinationID: delayed.id,
        agentID: agent.id,
        body: "The deferred report is now due.",
      })
      expect(deferred.availableAt).toBeGreaterThan(clock.now)
      expect((yield* inbox.page(agent.id)).messages).toEqual([])

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* RayaTaskRunner.subscribe({
            bus,
            database,
            storage,
            contact: { clock: () => clock.now, interval: "10 millis" },
            sessions: {
              create: () => Effect.die("unexpected session creation"),
              get: () => Effect.die("unexpected session read"),
              messages: () => Effect.succeed([]),
              children: () => Effect.succeed([]),
            },
          })
          const page = yield* inbox
            .page(agent.id)
            .pipe(Effect.repeat({ until: (value) => value.messages.length === 1 }), Effect.timeout("5 seconds"))
          expect(page.messages[0]).toMatchObject({
            kind: "report",
            source: `contact:${queued.id}`,
            body: "Weekly accounts are ready after restart.",
          })
          expect(yield* outbox.get(deferred.id)).toMatchObject({ state: "queued", attempts: 0 })
          clock.now = deferred.availableAt
          const updated = yield* inbox
            .page(agent.id)
            .pipe(Effect.repeat({ until: (value) => value.messages.length === 2 }), Effect.timeout("5 seconds"))
          expect(updated.messages[1]).toMatchObject({
            kind: "report",
            source: `contact:${deferred.id}`,
            body: "The deferred report is now due.",
          })
        }),
      )
      expect(yield* outbox.get(queued.id)).toMatchObject({
        state: "delivered",
        receipt: { status: "delivered", code: "delivered", attempts: 1 },
      })
      expect(yield* outbox.get(deferred.id)).toMatchObject({
        state: "delivered",
        receipt: { status: "delivered", code: "delivered", attempts: 1 },
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Storage.layerFromDir(path.join(root, "storage")),
          Database.layerFromPath(path.join(root, "routines.sqlite")),
        ),
      ),
    )
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
