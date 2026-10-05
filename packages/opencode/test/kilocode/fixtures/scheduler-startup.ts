import assert from "node:assert/strict"
import { join } from "node:path"
import { Effect, Exit, Layer, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { InstanceBootstrap } from "../../../src/project/bootstrap-service"
import { InstanceStore } from "../../../src/project/instance-store"
import { Session } from "../../../src/session/session"
import { Storage } from "../../../src/storage/storage"
import { Bus } from "../../../src/bus"
import { RayaTaskRunner } from "../../../src/kilocode/task/runner"
import { removals } from "../../../src/kilocode/task/removal"
import { scheduler, schedulerQuiesce } from "../../../src/kilocode/task/admission"

const root = process.env.RAYA_SCHEDULER_PROFILE
if (!root) throw new Error("Missing private scheduler profile")
const mode = process.argv[2]
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const state = { held: false, published: false, settled: false }
// Transparent gates retain the original production read/publication. Only unrelated
// bootstrap workers are excluded from this actual SQLite/Storage/Session graph.
const layer = AppNodeBuilder.build(
  LayerNode.group([
    Database.node,
    Session.node,
    SessionProjector.node,
    Storage.node,
    Bus.node,
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
        const bus = yield* Bus.Service
        const runner = RayaTaskRunner.make({ database, storage, sessions })
        yield* runner.tasks.create({
          name: "Native scheduler retirement",
          objective: "No model work",
          access: "brief",
          enabled: false,
          schedule: { kind: "manual" },
        })
        if (mode === "poll") yield* removals(storage).stage("missing-private-agent")
        const pause = Effect.promise(async () => {
          state.held = true
          entered.resolve()
          await release.promise
        })
        const wrapped: Storage.Interface = {
          ...storage,
          read: <T>(key: string[]) =>
            mode === "startup" && !state.held && key.join("/") === "raya/agent"
              ? pause.pipe(
                  Effect.andThen(storage.read<T>(key)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      state.published = true
                    }),
                  ),
                )
              : storage.read<T>(key),
          replace: (key, value) =>
            mode === "poll" &&
            !state.held &&
            key.join("/") === "raya/agent-removals" &&
            Array.isArray(value) &&
            value.length === 0
              ? pause.pipe(
                  Effect.andThen(storage.replace(key, value)),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      state.published = true
                    }),
                  ),
                )
              : storage.replace(key, value),
        }
        const scope = yield* Scope.make()
        yield* RayaTaskRunner.subscribe({ database, storage: wrapped, sessions, bus }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.forkIn(scope),
        )
        yield* Effect.promise(() => entered.promise)
        const closed = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
          state.settled = true
        })
        const outcome = closed.then(
          () => undefined,
          (err: unknown) => err,
        )
        try {
          yield* Effect.sleep("100 millis")
          assert.equal(state.settled, false, "Scope retirement must join the accepted native phase")
          assert.equal(state.published, false)
        } finally {
          release.resolve()
        }
        assert.equal(yield* Effect.promise(() => outcome), undefined)
        assert.equal(state.published, true)
        if (mode === "poll") assert.deepEqual(yield* removals(storage).pending(), [])
        yield* Effect.promise(schedulerQuiesce)
        assert.equal(scheduler.snapshot().active, 0)
        assert.equal(scheduler.snapshot().failures, 0)
        yield* database.db.get("SELECT 1").pipe(Effect.orDie)
        yield* Effect.promise(() =>
          Bun.write(
            join(root, "receipt.json"),
            JSON.stringify({
              passed: true,
              mode,
              published: state.published,
              active: 0,
              failures: 0,
              heldMillis: 100,
              scope:
                "Actual owner Scope joins native Storage startup/read or poll/removal publication; no model transport or portable capture",
            }),
          ),
        )
        yield* store.disposeAll()
      }),
    ),
  ).pipe(Effect.provide(layer), Effect.scoped),
)
