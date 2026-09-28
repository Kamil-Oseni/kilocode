import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { MessageID } from "@/session/schema"
import { ReviewGate } from "@/kilocode/session/review-gate"
import { WorkspaceOccupancy } from "@/kilocode/session/workspace-occupancy"
import { InstanceRef } from "@/effect/instance-ref"
import { Global } from "@opencode-ai/core/global"
import { SessionRevert } from "@/session/revert"
import { provideTmpdirProject } from "../../fixture/fixture"
import { testEffect, pollWithTimeout, awaitWithTimeout } from "../../lib/effect"

const env = LayerNode.compile(
  LayerNode.group([
    Session.node,
    SessionProjector.node,
    SessionRunState.node,
    ReviewGate.node,
    WorkspaceOccupancy.node,
    Global.node,
    SessionRevert.node,
    Database.node,
    CrossSpawnSpawner.node,
  ]),
)
const it = testEffect(env)

const message = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  const info = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    agent: "default",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    time: { created: Date.now() },
  })
  return { info, parts: [] }
})

it.live(
  "replaced occupancy record fails completion explicitly and retains busy ownership",
  provideTmpdirProject(
    () =>
      Effect.gen(function* () {
        const state = yield* SessionRunState.Service
        const global = yield* Global.Service
        const result = yield* message
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const worker = yield* state
          .ensureRunning(
            result.info.sessionID,
            Effect.succeed(result),
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(result)),
          )
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(started), "worker did not start")
        const directory = path.join(global.state, "workspace-occupancy-v1")
        const file = yield* Effect.promise(async () => {
          for (const name of await fs.readdir(directory)) {
            const target = path.join(directory, name)
            const actor = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
              JSON.parse(await fs.readFile(target, "utf8")),
            )
            if (actor.sessionID !== result.info.sessionID) continue
            await fs.writeFile(target, JSON.stringify({ ...actor, backend: "replacement" }))
            return target
          }
          throw new Error("Missing actual occupancy record")
        })
        yield* Effect.gen(function* () {
          yield* Deferred.succeed(release, undefined)
          const exit = yield* awaitWithTimeout(Fiber.await(worker), "failed drain did not complete caller")
          expect(Exit.isFailure(exit)).toBe(true)
          expect(Exit.isFailure(yield* state.assertNotBusy(result.info.sessionID).pipe(Effect.exit))).toBe(true)
          expect(yield* Effect.promise(() => fs.stat(file).then(() => true))).toBe(true)
        }).pipe(Effect.ensuring(Effect.promise(() => fs.unlink(file))))
      }),
    { git: true },
  ),
  60_000,
)

it.live(
  "workspace occupancy rejects an unrelated running session in a nested context",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const state = yield* SessionRunState.Service
        const occupancy = yield* WorkspaceOccupancy.Service
        const ctx = yield* InstanceRef
        if (!ctx) throw new Error("Missing test context")
        const nested = path.join(dir, "nested")
        yield* Effect.promise(() => fs.mkdir(nested))
        const result = yield* message.pipe(Effect.provideService(InstanceRef, { ...ctx, directory: nested }))
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const work = state
          .ensureRunning(
            result.info.sessionID,
            Effect.succeed(result),
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(result)),
          )
          .pipe(Effect.provideService(InstanceRef, { ...ctx, directory: nested }), Effect.forkChild)
        const worker = yield* work
        yield* awaitWithTimeout(Deferred.await(started), "nested worker did not start")
        const other = yield* message
        yield* state.assertNotBusy(other.info.sessionID)
        expect(Exit.isFailure(yield* occupancy.review([dir])(Effect.void).pipe(Effect.exit))).toBe(true)
        const revert = yield* SessionRevert.Service
        const refusal = yield* revert.discardChanges({ sessionID: other.info.sessionID }).pipe(Effect.exit)
        expect(Exit.isFailure(refusal)).toBe(true)
        if (Exit.isFailure(refusal)) expect(Cause.pretty(refusal.cause)).toContain("workspace still")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(worker)
        yield* occupancy.review([dir])(Effect.void)
      }),
    { git: true },
  ),
  60_000,
)

it.live(
  "cancelled work stays busy until its actual late-writing finalizer drains",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const state = yield* SessionRunState.Service
        const gate = yield* ReviewGate.Service
        const result = yield* message
        const id = result.info.sessionID
        const started = yield* Deferred.make<void>()
        const draining = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const file = path.join(dir, "notes.txt")
        yield* Effect.promise(() => fs.writeFile(file, "reviewed"))
        const worker = yield* state
          .ensureRunning(
            id,
            Effect.succeed(result),
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(draining, undefined)
                  yield* Deferred.await(release)
                  yield* Effect.promise(() => fs.writeFile(file, "late finalizer"))
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(Deferred.await(started), "worker did not start")
        const handle = yield* state.inspect(id)
        if (!handle.id) throw new Error("Missing actual execution handle")
        const stop = yield* state.requestCancel(id, handle.id)
        yield* awaitWithTimeout(Deferred.await(draining), "finalizer did not start")
        expect((yield* state.inspect(id)).phase).toBe("idle")
        const refusal = yield* gate.withWorkspace(dir)(Effect.exit(state.assertNotBusy(id)))
        expect(Exit.isFailure(refusal)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("reviewed")
        yield* Deferred.succeed(release, undefined)
        expect(yield* stop).toBe(true)
        yield* Fiber.join(worker)
        yield* state.assertNotBusy(id)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("late finalizer")
      }),
    { git: true },
  ),
  60_000,
)

for (const mode of ["prompt", "shell"]) {
  it.live(
    `review blocks ${mode} admission and cancellation invalidates queued work`,
    provideTmpdirProject(
      (dir) =>
        Effect.gen(function* () {
          const state = yield* SessionRunState.Service
          const gate = yield* ReviewGate.Service
          const result = yield* message
          const id = result.info.sessionID
          const locked = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const entered = yield* Deferred.make<void>()
          const attempted = yield* Deferred.make<void>()
          const review = yield* gate
            .withWorkspace(dir)(Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))))
            .pipe(Effect.forkChild)
          yield* Deferred.await(locked)
          const work = Deferred.succeed(entered, undefined).pipe(Effect.as(result))
          const call =
            mode === "prompt"
              ? state.ensureRunning(id, Effect.succeed(result), work)
              : state.startShell(id, Effect.succeed(result), work)
          const pending = yield* Deferred.succeed(attempted, undefined).pipe(Effect.andThen(call), Effect.forkChild)
          yield* Deferred.await(attempted)
          yield* Effect.sleep(50)
          expect(yield* Deferred.isDone(entered)).toBe(false)
          yield* state.cancel(id)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(review)
          expect((yield* Fiber.join(pending)).info.id).toBe(result.info.id)
          expect(yield* Deferred.isDone(entered)).toBe(false)
          yield* state.assertNotBusy(id)
        }),
      { git: true },
    ),
    60_000,
  )
}

it.live(
  "long-running inference releases admission locks and preserves shell follow-up ownership",
  provideTmpdirProject(
    (dir) =>
      Effect.gen(function* () {
        const state = yield* SessionRunState.Service
        const gate = yield* ReviewGate.Service
        const result = yield* message
        const id = result.info.sessionID
        const shell = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const first = yield* state
          .startShell(id, Effect.succeed(result), Deferred.await(shell).pipe(Effect.as(result)))
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          state.inspect(id).pipe(Effect.map((value) => (value.phase === "shell" ? true : undefined))),
          "shell did not start",
        )
        const next = yield* state
          .ensureRunning(
            id,
            Effect.succeed(result),
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(result)),
          )
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          state.inspect(id).pipe(Effect.map((value) => ("queued" in value && value.queued ? true : undefined))),
          "follow-up did not queue",
        )
        expect(
          yield* awaitWithTimeout(
            gate.withWorkspace(dir)(Effect.succeed("available")),
            "inference retained review lock",
          ),
        ).toBe("available")
        yield* Deferred.succeed(shell, undefined)
        yield* Fiber.join(first)
        yield* awaitWithTimeout(Deferred.await(started), "follow-up did not start")
        expect((yield* state.inspect(id)).phase).toBe("running")
        expect(Exit.isFailure(yield* Effect.exit(state.assertNotBusy(id)))).toBe(true)
        expect(
          yield* awaitWithTimeout(
            gate.withWorkspace(dir)(Effect.succeed("available")),
            "follow-up retained review lock",
          ),
        ).toBe("available")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(next)
        yield* pollWithTimeout(
          state.assertNotBusy(id).pipe(
            Effect.as(true),
            Effect.catchTag("SessionBusyError", () => Effect.succeed(undefined)),
          ),
          "follow-up did not drain",
        )
      }),
    { git: true },
  ),
  60_000,
)
