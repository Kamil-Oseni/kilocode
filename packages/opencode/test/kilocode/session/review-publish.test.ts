import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { publish } from "@/kilocode/session/review-publish"
import { tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { fileURLToPath } from "node:url"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))

describe("atomic review receipt publication", () => {
  it.live(
    "separate OS processes cannot both claim the same receipt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const directory = yield* tmpdirScoped()
        const file = path.join(directory, "receipt.json")
        const fixture = fileURLToPath(new URL("./fixtures/review-claim.ts", import.meta.url))
        const results = yield* Effect.all(
          Array.from({ length: 4 }, (_, owner) =>
            spawner.exitCode(
              ChildProcess.make(process.execPath, [fixture, file, String(owner)], { stdin: "ignore", detached: false }),
            ),
          ),
          { concurrency: 4 },
        )
        expect(results.filter((code) => code === 0)).toHaveLength(1)
        expect(results.every((code) => code === 0 || code === 10)).toBe(true)
        expect(yield* fs.readJson(file)).toEqual({ owner: String(results.findIndex((code) => code === 0)) })
      }),
    30_000,
  )

  it.live(
    "independent writers claim a receipt exactly once without a shared semaphore",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        const file = path.join(directory, "receipt.json")
        const results = yield* Effect.all(
          Array.from({ length: 16 }, (_, owner) => publish(fs, file, { owner })),
          { concurrency: 16 },
        )
        expect(results.filter(Boolean)).toHaveLength(1)
        expect(yield* fs.readJson(file)).toEqual({ owner: results.indexOf(true) })
        expect(yield* fs.readDirectory(directory)).toEqual(["receipt.json"])
      }),
    30_000,
  )

  it.live(
    "readers see complete JSON while completion replaces a pending receipt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        const file = path.join(directory, "receipt.json")
        const padding = "x".repeat(128 * 1024)
        yield* publish(fs, file, { complete: false, padding })
        const writer = Effect.gen(function* () {
          for (let index = 0; index < 20; index++) yield* publish(fs, file, { complete: true, padding }, true)
        })
        const reader = Effect.gen(function* () {
          for (let index = 0; index < 60; index++) {
            const value = Schema.decodeUnknownSync(Schema.Struct({ complete: Schema.Boolean, padding: Schema.String }))(
              yield* fs.readJson(file),
            )
            expect(value.padding).toBe(padding)
          }
        })
        yield* Effect.all([writer, reader], { concurrency: 2 })
        expect(yield* fs.readJson(file)).toEqual({ complete: true, padding })
        expect(yield* fs.readDirectory(directory)).toEqual(["receipt.json"])
      }),
    30_000,
  )
})
