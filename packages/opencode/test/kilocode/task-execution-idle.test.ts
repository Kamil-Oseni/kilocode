import { createHash } from "node:crypto"
import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { ExecutionIdle } from "@/kilocode/task/execution-event"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const identity = () => ({
  id: crypto.randomUUID(),
  agentID: crypto.randomUUID(),
  sessionID: SessionID.make("ses_idle"),
})

it.live(
  "notifies after a successful body joins beyond the admission deadline",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const events: GlobalEvent[] = []
        const listener = (event: GlobalEvent) => {
          if (event.payload.type === ExecutionIdle.type && event.payload.properties.runID === owner.id)
            events.push(event)
        }
        GlobalBus.on("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
        const first = yield* execution
          .enter(owner, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* Effect.gen(function* () {
          const receipt = yield* execution.receipt(owner)
          expect(receipt).toBeDefined()
          expect(yield* execution.idle(owner, hash(receipt!.token))).toBe(false)
          expect(
            yield* execution.enter(owner, Effect.die("Busy original body admitted another effect")),
          ).toBeUndefined()
          expect(events).toHaveLength(0)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          expect(events).toHaveLength(1)
          expect(events[0].payload.properties).toEqual({
            version: 1,
            runID: owner.id,
            agentID: owner.agentID,
            sessionID: owner.sessionID,
            execution: hash(receipt!.token),
          })
          expect(yield* execution.idle(owner, hash(receipt!.token))).toBe(true)
          expect(yield* execution.idle(owner, hash(crypto.randomUUID()))).toBe(false)
          const changed = yield* execution
            .idle({ ...owner, agentID: crypto.randomUUID() }, hash(receipt!.token))
            .pipe(Effect.exit)
          expect(Exit.isFailure(changed)).toBe(true)
          expect(yield* execution.enter(owner, Effect.succeed("fresh intake"))).toBe("fresh intake")
          yield* execution.finish(owner)
          expect(yield* execution.idle(owner, hash(receipt!.token))).toBe(false)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

for (const mode of ["failure", "idle failure", "closed"] as const)
  it.live(
    `does not notify successful idle for ${mode}`,
    () =>
      Effect.gen(function* () {
        const root = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const owner = identity()
          const guarded =
            mode === "idle failure"
              ? {
                  ...storage,
                  replace: (key: string[], value: unknown) =>
                    typeof value === "object" && value !== null && "state" in value && value.state === "idle"
                      ? Effect.die("Injected idle receipt failure")
                      : storage.replace(key, value),
                }
              : storage
          const execution = RayaTaskExecution.make(guarded)
          const events: GlobalEvent[] = []
          const listener = (event: GlobalEvent) => {
            if (event.payload.type === ExecutionIdle.type && event.payload.properties.runID === owner.id)
              events.push(event)
          }
          GlobalBus.on("event", listener)
          yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
          const result = yield* execution
            .enter(
              owner,
              mode === "failure"
                ? Effect.fail(new Error("Unknown prior outcome"))
                : mode === "closed"
                  ? execution.finish(owner)
                  : Effect.void,
            )
            .pipe(Effect.exit)
          expect(Exit.isSuccess(result)).toBe(mode === "closed")
          expect(events).toHaveLength(0)
          const receipt = yield* execution.receipt(owner)
          if (mode === "closed") expect(receipt).toBeUndefined()
          if (mode !== "closed") {
            expect(receipt?.state).toBe("active")
            expect(yield* execution.idle(owner, hash(receipt!.token))).toBe(false)
            expect(yield* execution.enter(owner, Effect.die("Uncertain prior action was replayed"))).toBeUndefined()
          }
        }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
      }),
    30_000,
  )
it.live(
  "keeps a joined successful receipt when an idle listener throws",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        const listener = (event: GlobalEvent) => {
          if (event.payload.type === ExecutionIdle.type && event.payload.properties.runID === owner.id)
            throw new Error("Injected local notification failure")
        }
        GlobalBus.prependListener("event", listener)
        yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
        expect(yield* execution.enter(owner, Effect.succeed("joined"))).toBe("joined")
        const receipt = yield* execution.receipt(owner)
        expect(receipt?.state).toBe("idle")
        expect(yield* execution.idle(owner, hash(receipt!.token))).toBe(true)
        GlobalBus.off("event", listener)
        expect(yield* execution.enter(owner, Effect.succeed("fresh"))).toBe("fresh")
        yield* execution.finish(owner)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)
