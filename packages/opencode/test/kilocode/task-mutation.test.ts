import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Deferred, Effect, Exit, Fiber } from "effect"
import * as PlatformError from "effect/PlatformError"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { mutate } from "@/kilocode/task/mutation"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const claim = ["raya", "mutation-agent-claims", createHash("sha256").update("routines").digest("hex")]

function denial() {
  const cause = Object.assign(new Error("claim file is temporarily locked"), { code: "EPERM" })
  return PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "readFileString",
    cause,
  })
}

it.live(
  "retries transient Windows claim-read contention without replaying the mutation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const state = { reads: 0, calls: 0 }
        const contested = {
          ...storage,
          read: <T>(key: string[]) => {
            if (key.join("/") !== claim.join("/") || state.reads >= 2) return storage.read<T>(key)
            state.reads++
            return Effect.fail(denial())
          },
        }
        const result = yield* mutate(
          contested,
          Effect.sync(() => {
            state.calls++
            return "saved"
          }),
        )
        expect(result).toBe("saved")
        expect(state.reads).toBe(2)
        expect(state.calls).toBe(1)
        expect(yield* storage.read(claim).pipe(Effect.flip)).toBeInstanceOf(Storage.NotFoundError)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "surfaces persistent claim-read denial without executing the mutation",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const state = { reads: 0, calls: 0 }
        const denied = {
          ...storage,
          read: <T>(key: string[]) => {
            if (key.join("/") !== claim.join("/")) return storage.read<T>(key)
            state.reads++
            return Effect.fail(denial())
          },
        }
        const result = yield* mutate(
          denied,
          Effect.sync(() => state.calls++),
        ).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
        expect(state.reads).toBe(8)
        expect(state.calls).toBe(0)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "concurrent routine mutations finish cleanup without starving the claim owner",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const key = ["raya", "counter"]
        yield* storage.replace(key, 0)
        yield* Effect.forEach(
          Array.from({ length: 32 }),
          () =>
            mutate(
              storage,
              Effect.gen(function* () {
                const count = yield* storage.read<number>(key)
                yield* Effect.yieldNow
                yield* storage.replace(key, count + 1)
              }),
            ),
          { concurrency: 8 },
        )
        expect(yield* storage.read(key)).toBe(32)
        expect(yield* storage.read(claim).pipe(Effect.flip)).toBeInstanceOf(Storage.NotFoundError)
        expect(Exit.isFailure(yield* mutate(storage, Effect.fail("rejected")).pipe(Effect.exit))).toBe(true)
        expect(yield* mutate(storage, Effect.succeed("next"))).toBe("next")
        expect(yield* storage.read(claim).pipe(Effect.flip)).toBeInstanceOf(Storage.NotFoundError)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "cancelled local waiters do not execute and unrelated storage services remain independent",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const first = yield* mutate(
          storage,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        const calls: string[] = []
        const waiter = yield* mutate(
          storage,
          Effect.sync(() => calls.push("unexpected")),
        ).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(waiter)
        expect(calls).toEqual([])
        yield* Effect.gen(function* () {
          const other = yield* Storage.Service
          expect(yield* mutate(other, Effect.succeed("independent"))).toBe("independent")
        }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "other"))))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        expect(yield* mutate(storage, Effect.succeed("released"))).toBe("released")
        expect(yield* storage.read(claim).pipe(Effect.flip)).toBeInstanceOf(Storage.NotFoundError)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)
