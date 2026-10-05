import assert from "node:assert/strict"
import { join } from "node:path"
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { Storage } from "../../../src/storage/storage"
import { RayaTaskRunner } from "../../../src/kilocode/task/runner"
import { RayaTaskDelegation } from "../../../src/kilocode/task/delegation"
import { RayaGoal } from "../../../src/kilocode/goal"
import { scheduler, schedulerQuiesce } from "../../../src/kilocode/task/admission"

const root = process.env.RAYA_SCHEDULER_PROFILE
if (!root) throw new Error("Missing private scheduler profile")
const mode = process.argv[2]
if (mode !== "inline" && mode !== "detached") throw new Error("Expected inline or detached")
const entered = Promise.withResolvers<void>()
const aborted = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const finalizing = Promise.withResolvers<void>()
const finalized = Promise.withResolvers<void>()
const observed = Promise.withResolvers<Fiber.Fiber<unknown, unknown>>()
const state = { requests: 0, aborted: 0, finalizers: 0 }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    state.requests++
    request.signal.addEventListener(
      "abort",
      () => {
        state.aborted++
        aborted.resolve()
      },
      { once: true },
    )
    entered.resolve()
    await release.promise
    return new Response("released fixture transport")
  },
})
// Persistence, Session and runner are production services. Exclude unrelated
// application bootstrap; continuation is an actual abortable native HTTP transport.
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Session.node,
    SessionProjector.node,
    Storage.node,
    CrossSpawnSpawner.node,
    InstanceStore.node,
  ]),
  [
    [
      InstanceStore.bootstrapNode,
      Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
    ],
  ],
)
try {
  await Effect.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: root },
        Effect.gen(function* () {
          const database = yield* Database.Service
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const scope = Scope.makeUnsafe()
          const runner = RayaTaskRunner.make({
            database,
            storage,
            sessions,
            continuation: () =>
              Effect.withFiber((fiber) => Effect.sync(() => observed.resolve(fiber))).pipe(
                Effect.andThen(Effect.promise((signal) => fetch(server.url, { signal }))),
                Effect.asVoid,
                Effect.ensuring(
                  Effect.promise(async () => {
                    state.finalizers++
                    finalizing.resolve()
                    await finalized.promise
                    await Bun.write(join(root, "transport-finalized.txt"), "actual finalizer completed")
                  }),
                ),
              ),
          })
          const chief = yield* runner.tasks.create({
            name: "Cancellation parent",
            objective: "Keep bounded work cancellable",
            access: "brief",
            schedule: { kind: "manual" },
          })
          if (mode === "inline") {
            const worker = yield* runner.tasks.create({
              name: "Overdue child",
              objective: "Expire one budget reservation",
              access: "brief",
              schedule: { kind: "manual" },
            })
            const id = crypto.randomUUID()
            const session = yield* sessions.create({
              title: "Inline cancellation",
              metadata: {
                rayaRoutine: {
                  version: 1,
                  agentID: chief.id,
                  runID: id,
                  scheduleVersion: 1,
                  trigger: { kind: "manual" },
                },
              },
            })
            yield* runner.tasks.record({
              id,
              agentID: chief.id,
              sessionID: session.id,
              at: Date.now(),
              status: "running",
              scheduleVersion: 1,
              trigger: { kind: "manual" },
            })
            const goals = RayaGoal.make({ database, storage, sessions })
            const goal = yield* goals.create(session.id, chief.objective, undefined, undefined, undefined, undefined, {
              modelCost: 10,
            })
            yield* storage.write(["raya", "goal", session.id], { ...goal, usage: { ...goal.usage, cost: 4 } })
            const delegation = RayaTaskDelegation.make(database)
            const deadline = Date.now() + 10_000
            const child = yield* delegation.admit(
              {
                source: "inline-cancellation",
                senderID: chief.id,
                recipientID: worker.id,
                parentRunID: id,
                objective: worker.objective,
                budget: 6,
                deadline,
              },
              chief,
              worker,
            )
            assert.equal((yield* goals.delegated(session.id, id)).state.status, "paused")
            yield* runner
              .tick(deadline + 1)
              .pipe(Effect.uninterruptible, Effect.forkIn(scope, { startImmediately: true }))
            yield* Effect.promise(() => entered.promise)
            assert.equal((yield* delegation.get(child.record.id)).state, "failed")
            assert.equal((yield* goals.get(session.id))?.status, "active")
          } else {
            yield* runner.fire(chief.id).pipe(Effect.uninterruptible)
            yield* Effect.promise(() => entered.promise)
          }
          const child = yield* Effect.promise(() => observed.promise)
          const closed =
            mode === "inline"
              ? Effect.runPromise(Scope.close(scope, Exit.void))
              : Effect.runPromise(Fiber.interrupt(child))
          let joined = false
          const closing = closed.then(() => {
            joined = true
          })
          yield* Effect.promise(() => finalizing.promise)
          yield* Effect.promise(() => aborted.promise)
          assert.equal(joined, false)
          assert.equal(yield* Effect.promise(() => Bun.file(join(root, "transport-finalized.txt")).exists()), false)
          assert.ok(scheduler.snapshot().active > 0)
          finalized.resolve()
          yield* Effect.promise(() => closing)
          const drained = schedulerQuiesce()
          const failure = yield* Effect.promise(() =>
            drained.then(
              () => undefined,
              (err: unknown) => err,
            ),
          )
          assert.ok(failure instanceof AggregateError)
          assert.ok(
            failure.errors.some((err) =>
              Cause.isCause(err) ? Cause.hasInterrupts(err) : String(err).includes("interrupt"),
            ),
          )
          assert.equal(schedulerQuiesce(), drained)
          assert.equal(scheduler.snapshot().active, 0)
          assert.equal(state.requests, 1)
          assert.equal(state.aborted, 1)
          assert.equal(state.finalizers, 1)
          assert.equal(
            yield* Effect.promise(() => Bun.file(join(root, "transport-finalized.txt")).text()),
            "actual finalizer completed",
          )
          assert.ok(Exit.isFailure(yield* runner.tick(Date.now()).pipe(Effect.exit)))
          yield* database.db.get("SELECT 1").pipe(Effect.orDie)
          yield* Effect.promise(() =>
            Bun.write(
              join(root, "receipt.json"),
              JSON.stringify({
                passed: true,
                mode,
                ...state,
                scheduler: scheduler.snapshot(),
                portable: false,
                scope:
                  "Actual private Routine/SQLite/Storage/Session and held native HTTP continuation seam; excludes LLM/GPU and unrelated bootstrap",
              }),
            ),
          )
          yield* store.disposeAll()
        }),
      ),
    ).pipe(Effect.provide(layer), Effect.scoped),
  )
} finally {
  finalized.resolve()
  release.resolve()
  await server.stop(true)
}
