import { expect } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node])))
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const identity = () => ({
  id: crypto.randomUUID(),
  agentID: crypto.randomUUID(),
  sessionID: SessionID.make("ses_review"),
})

it.live(
  "explicit review refuses a busy body and retains its complete failed receipt without replay",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const count = { value: 0 }
        const body = yield* execution
          .enter(
            owner,
            Effect.gen(function* () {
              count.value++
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return yield* Effect.fail("unknown effect")
            }),
          )
          .pipe(Effect.forkChild)
        yield* Effect.gen(function* () {
          yield* Deferred.await(entered)
          const receipt = yield* execution.receipt(owner)
          if (!receipt) throw new Error("Expected exact execution receipt")
          expect(Exit.isFailure(yield* execution.review(owner, receipt.token).pipe(Effect.exit))).toBe(true)
          expect(yield* execution.receipt(owner)).toEqual(receipt)
          expect(yield* execution.reviewed(owner, hash(receipt.token))).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isFailure(yield* Fiber.await(body))).toBe(true)
          const stopped = yield* execution.receipt(owner)
          expect(stopped).toEqual(receipt)
          yield* execution.review(owner, receipt.token)
          expect(yield* execution.receipt(owner)).toBeUndefined()
          expect(yield* execution.reviewed(owner, hash(receipt.token))).toEqual(receipt)
          yield* execution.review(owner, receipt.token)
          expect(yield* execution.reviewed(owner, hash(receipt.token))).toEqual(receipt)
          expect(count.value).toBe(1)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "review refuses wrong digest, scope, corrupt saved receipts and changed tokens",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        yield* execution.enter(owner, Effect.fail("unknown")).pipe(Effect.exit)
        const receipt = yield* execution.receipt(owner)
        if (!receipt) throw new Error("Expected exact execution receipt")
        expect(Exit.isFailure(yield* execution.reviewed(owner, "wrong").pipe(Effect.exit))).toBe(true)
        expect(Exit.isFailure(yield* execution.review(owner, crypto.randomUUID()).pipe(Effect.exit))).toBe(true)
        expect(yield* execution.receipt(owner)).toEqual(receipt)
        yield* execution.review(owner, receipt.token)
        expect(
          Exit.isFailure(
            yield* execution
              .reviewed({ ...owner, agentID: crypto.randomUUID() }, hash(receipt.token))
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        const key = ["raya", "agent-execution-reviews", hash(owner.id), hash(receipt.token)]
        yield* storage.replace(key, {
          version: 1,
          actor: "user",
          at: Date.now(),
          record: { ...receipt, token: crypto.randomUUID() },
        })
        expect(Exit.isFailure(yield* execution.reviewed(owner, hash(receipt.token)).pipe(Effect.exit))).toBe(true)
        yield* storage.replace(key, { version: 1, actor: "user" })
        expect(Exit.isFailure(yield* execution.review(owner, receipt.token).pipe(Effect.exit))).toBe(true)
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)

it.live(
  "saved review survives failed lease removal and permits an exact immutable retry",
  () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      yield* Effect.gen(function* () {
        const storage = yield* Storage.Service
        const execution = RayaTaskExecution.make(storage)
        const owner = identity()
        yield* execution.enter(owner, Effect.fail("unknown")).pipe(Effect.exit)
        const receipt = yield* execution.receipt(owner)
        if (!receipt) throw new Error("Expected exact execution receipt")
        const gate = { failed: false }
        const guarded: Storage.Interface = {
          ...storage,
          remove: (key) => {
            if (!gate.failed && key[1] === "agent-executions") {
              gate.failed = true
              return Effect.die(new Error("injected removal failure"))
            }
            return storage.remove(key)
          },
        }
        expect(
          Exit.isFailure(yield* RayaTaskExecution.make(guarded).review(owner, receipt.token).pipe(Effect.exit)),
        ).toBe(true)
        const key = ["raya", "agent-execution-reviews", hash(owner.id), hash(receipt.token)]
        const saved = yield* storage.read(key)
        expect(yield* execution.receipt(owner)).toEqual(receipt)
        expect(yield* execution.reviewed(owner, hash(receipt.token))).toEqual(receipt)
        const lease = ["raya", "agent-executions", hash(owner.id)]
        const changed = { ...receipt, token: crypto.randomUUID() }
        yield* storage.replace(lease, changed)
        expect(Exit.isFailure(yield* execution.review(owner, receipt.token).pipe(Effect.exit))).toBe(true)
        expect(yield* execution.receipt(owner)).toEqual(changed)
        expect(yield* storage.read(key)).toEqual(saved)
        yield* storage.replace(lease, receipt)
        yield* execution.review(owner, receipt.token)
        expect(yield* storage.read(key)).toEqual(saved)
        expect(yield* execution.receipt(owner)).toBeUndefined()
      }).pipe(Effect.provide(Storage.layerFromDir(path.join(root, "storage"))))
    }),
  30_000,
)
