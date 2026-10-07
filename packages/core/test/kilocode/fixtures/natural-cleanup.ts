import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Direct from "@opencode-ai/core/kilocode/direct-attribution"

const node = process.env.RAYA_TEST_NODE
assert(node)
const mode = process.argv[2]
assert(mode === "kill" || mode === "scope")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raya-natural-cleanup-"))
const marker = path.join(dir, "release")
const ready = path.join(dir, "ready")
const text = "ORIGINAL_NATURAL_EXIT"
const script = `const fs=require('node:fs');fs.writeFileSync(process.argv[2],'ready');const timer=setInterval(()=>{if(!fs.existsSync(process.argv[1]))return;clearInterval(timer);process.stdout.write('${text}',()=>process.exit(0))},10)`
const live = LayerNode.compile(CrossSpawnSpawner.node)
try {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(node, ["-e", script, marker, ready])
          const fiber = yield* Effect.forkIn(Stream.runCollect(handle.stdout), scope)
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 2000
            while (!fs.existsSync(ready)) {
              assert(Date.now() < deadline, "original child never became ready")
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          })
          assert(!Direct.exits().some((row) => row.pid === handle.pid))
          fs.writeFileSync(marker, "release", { flag: "wx" })
          if (mode === "kill") yield* handle.kill()
          return { handle, fiber }
        }),
      )
      const code = yield* result.handle.exitCode
      const chunks = yield* Fiber.join(result.fiber)
      const output = Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))).toString()
      assert.equal(code, 0)
      assert.equal(output, text)
      assert.equal(Direct.records().filter((row) => row.operation === "taskkill").length, 0)
      assert.equal(Direct.footer().pending, 0)
      return { mode, code, originalOutputDrained: true, taskkillCount: 0 }
    }).pipe(Effect.scoped, Effect.provide(live)),
  )
  console.log(JSON.stringify(result))
} finally {
  for (const file of [marker, ready]) if (fs.existsSync(file)) fs.unlinkSync(file)
  fs.rmdirSync(dir)
}
