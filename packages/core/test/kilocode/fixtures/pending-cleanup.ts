import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { Effect, Exit, Fiber, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Direct from "@opencode-ai/core/kilocode/direct-attribution"

const node = process.env.RAYA_TEST_NODE
assert(node)
const mode = process.argv[2]
assert(mode === "kill" || mode === "scope")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raya-pending-cleanup-"))
const marker = path.join(dir, "release")
const text = "ORIGINAL_PENDING_EXIT"
const script = `const fs=require('node:fs');const timer=setInterval(()=>{if(!fs.existsSync(process.argv[1]))return;clearInterval(timer);process.stdout.write('${text}',()=>process.exit(0))},10)`
// Native APIs are diagnostic fixture authority only; production code does not use experimental FFI.
const library = dlopen("kernel32.dll", {
  OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
  WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
  GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
})
const api = library.symbols
const live = LayerNode.compile(CrossSpawnSpawner.node)
try {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(node, ["-e", script, marker])
          const fiber = yield* Effect.forkIn(Stream.runCollect(handle.stdout), scope)
          const original = api.OpenProcess(0x101000, 0, handle.pid)
          assert(original !== 0n)
          const code = new Uint32Array(1)
          try {
            assert.equal(api.WaitForSingleObject(original, 0), 258, "owned child must be alive before release")
            fs.writeFileSync(marker, "release", { flag: "wx" })
            assert.equal(api.WaitForSingleObject(original, 2000), 0, "original native handle must reach terminal")
            assert.equal(api.GetExitCodeProcess(original, ptr(code)), 1)
            assert.equal(code[0], 0)
            assert.equal(
              Direct.exits().some((row) => row.pid === handle.pid),
              false,
              "original JS exit must still be pending",
            )
          } finally {
            assert.equal(api.CloseHandle(original), 1)
          }
          const stopped = mode === "kill" ? Exit.isSuccess(yield* Effect.exit(handle.kill())) : true
          return { handle, fiber, stopped, nativeCode: code[0] }
        }),
      )
      const code = yield* result.handle.exitCode
      const chunks = yield* Fiber.join(result.fiber)
      const output = Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))).toString()
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 2000
        while (Direct.footer().pending) {
          assert(Date.now() < deadline, "original cleanup helper close did not join")
          await new Promise((resolve) => setImmediate(resolve))
        }
      })
      const kills = Direct.records().filter((row) => row.operation === "taskkill")
      const packet = {
        mode,
        originalNativeCode: result.nativeCode,
        originalCloseCode: code,
        originalOutputDrained: output === text,
        stopped: result.stopped,
        taskkillCount: kills.length,
        actualTaskkillCodes: kills.map((row) => row.code),
        pending: Direct.footer().pending,
      }
      console.error(JSON.stringify(packet))
      assert.equal(code, 0)
      assert.equal(output, text)
      assert(result.stopped)
      assert.equal(kills.length, 0, "native-terminal original must not launch taskkill before its JS exit callback")
      assert.equal(packet.pending, 0)
      return packet
    }).pipe(Effect.scoped, Effect.provide(live)),
  )
  assert.equal(result.originalCloseCode, 0)
  console.log(JSON.stringify(result))
} finally {
  library.close()
  if (fs.existsSync(marker)) fs.unlinkSync(marker)
  fs.rmdirSync(dir)
}
