import assert from "node:assert/strict"
import { join } from "node:path"
import { Effect, Exit, Layer } from "effect"
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
import { RayaTaskExecution } from "../../../src/kilocode/task/execution"
import { RayaContactMessenger } from "../../../src/kilocode/contact/raya"
import { scheduler, schedulerQuiesce } from "../../../src/kilocode/task/admission"

const root = process.env.RAYA_SCHEDULER_PROFILE
if (!root) throw new Error("Missing private scheduler profile")
const mode = process.argv[2]
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const finalizing = Promise.withResolvers<void>()
const finalized = Promise.withResolvers<void>()
// Exclude unrelated full-application bootstrap workers; all exercised persistence,
// Session, runner, execution and Messenger services are the production implementations.
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
await Effect.runPromise(
  InstanceStore.Service.use((store) =>
    store.provide(
      { directory: root },
      Effect.gen(function* () {
        const database = yield* Database.Service
        const storage = yield* Storage.Service
        const sessions = yield* Session.Service
        const runner = RayaTaskRunner.make({
          database,
          storage,
          sessions,
          continuation: () =>
            Effect.promise(async () => {
              entered.resolve()
              await release.promise
              if (mode === "failed") throw new Error("uncertain fixture transport outcome")
            }).pipe(
              Effect.ensuring(
                Effect.promise(async () => {
                  finalizing.resolve()
                  await finalized.promise
                }),
              ),
            ),
        })
        const agent = yield* runner.tasks.create({
          name: "Scheduler drain fixture",
          objective: "Join one accepted private continuation",
          access: "brief",
          enabled: true,
          schedule: { kind: "manual" },
        })
        const run = yield* runner.fire(agent.id)
        yield* Effect.promise(() => entered.promise)
        const execution = RayaTaskExecution.make(storage)
        const before = yield* execution.receipt(run)
        assert.ok(before)
        const closed = schedulerQuiesce()
        const outcome = closed.then(
          () => undefined,
          (err: unknown) => err,
        )
        assert.equal(schedulerQuiesce(), closed)
        assert.equal(scheduler.snapshot().closed, true)
        assert.ok(scheduler.snapshot().active > 0)
        for (const effect of [
          runner.fire(agent.id),
          runner.tick(Date.now()),
          runner.dispatch(agent.id),
          runner.revive(),
        ])
          assert.ok(Exit.isFailure(yield* effect.pipe(Effect.exit)))
        const messenger = RayaContactMessenger.make(database)
        assert.ok(Exit.isFailure(yield* messenger.drain().pipe(Effect.exit)))
        assert.ok(Exit.isFailure(yield* messenger.reconcile(Date.now()).pipe(Effect.exit)))
        release.resolve()
        yield* Effect.promise(() => finalizing.promise)
        assert.ok(scheduler.snapshot().active > 0)
        assert.equal((yield* execution.receipt(run))?.token, before.token)
        finalized.resolve()
        const failure = yield* Effect.promise(() => outcome)
        assert.equal(failure instanceof AggregateError, mode === "failed")
        assert.equal(scheduler.snapshot().active, 0)
        const after = yield* execution.receipt(run)
        assert.equal(after?.token, before.token)
        assert.equal(after?.state, mode === "failed" ? "active" : "idle")
        assert.equal((yield* runner.tasks.runsFor(agent.id)).length, 1)
        assert.equal((yield* runner.tasks.runsFor(agent.id))[0]?.sessionID, run.sessionID)
        assert.ok(Exit.isFailure(yield* runner.ask(agent.id, "Do not replay").pipe(Effect.exit)))
        yield* database.db.get("SELECT 1").pipe(Effect.orDie)
        yield* Effect.promise(() =>
          Bun.write(
            join(root, "receipt.json"),
            JSON.stringify({
              passed: true,
              mode,
              run: run.id,
              session: run.sessionID,
              state: after?.state,
              active: scheduler.snapshot().active,
              uncertain: mode === "failed",
              processLocal: true,
              scope:
                "Actual SQLite/Storage/Session/Routine runner with held continuation seam; excludes production LLM/tool transport and portable capture",
            }),
          ),
        )
        yield* store.disposeAll()
      }),
    ),
  ).pipe(Effect.provide(layer), Effect.scoped),
)
