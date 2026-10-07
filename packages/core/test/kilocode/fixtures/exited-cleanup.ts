import assert from "node:assert/strict"
import { Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Direct from "@opencode-ai/core/kilocode/direct-attribution"

const node = process.env.RAYA_TEST_NODE
assert(node)
const mode = process.argv[2]
assert(mode === "kill" || mode === "scope")
const bytes = 96 * 1024
const script = `process.stdout.write('x'.repeat(${bytes}), () => process.exit(0))`
const live = LayerNode.compile(CrossSpawnSpawner.node)
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(node, ["-e", script])
        yield* Effect.promise(async () => {
          const deadline = Date.now() + 2000
          while (!Direct.exits().some((row) => row.pid === handle.pid && row.code === 0)) {
            assert(Date.now() < deadline, "original child did not exit before buffered pipes drained")
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        })
        assert.equal(yield* handle.isRunning, true, "original close must still be pending")
        // Retain backpressure until cleanup starts; collect through the outer scope.
        const fiber = yield* Effect.forkIn(
          Effect.sleep("25 millis").pipe(Effect.andThen(Stream.runCollect(handle.stdout))),
          scope,
        )
        if (mode === "kill") yield* handle.kill()
        return { handle, fiber }
      }),
    )
    const code = yield* result.handle.exitCode
    const chunks = yield* Fiber.join(result.fiber)
    const output = Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))).toString()
    assert.equal(code, 0)
    assert.equal(output, "x".repeat(bytes))
    const records = Direct.records()
    const kills = records.filter((row) => row.operation === "taskkill")
    assert.equal(kills.length, 0, "an exited original child must not launch taskkill")
    assert(records.some((row) => row.operation === "spawn" && row.pid === result.handle.pid && row.code === 0))
    assert.equal(Direct.footer().pending, 0)
    return { passed: true, mode, originalClose: true, code, bufferedOutputDrained: true, taskkillCount: kills.length }
  }).pipe(Effect.scoped, Effect.provide(live)),
)
console.log(JSON.stringify(result))
