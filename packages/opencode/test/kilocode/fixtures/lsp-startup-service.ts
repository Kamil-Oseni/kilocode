import assert from "node:assert/strict"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import path from "node:path"
import { Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LSP } from "../../../src/lsp/lsp"
import { InitializeError } from "../../../src/lsp/client"
import { InstanceStore } from "../../../src/project/instance-store"
import { disposeTestRuntime, requireInstance, tmpdir, withTmpdirInstance } from "../../fixture/fixture"
import { withTimeout } from "../../../src/util/timeout"

const mode = process.argv[2]
async function exercise() {
  await using dir = await tmpdir()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const source = await Bun.file(path.join(import.meta.dir, "../../fixture/lsp/fake-lsp-server.js")).text()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      entered.resolve()
      await release.promise
      return new Response(
        mode === "success"
          ? source
          : source.replace(
              'if (data.method === "initialize") {',
              'if (data.method === "initialize") { process.stdout.write(encode({jsonrpc:"2.0",id:data.id,error:{code:-32002,message:"Actual child initialization refusal"}})); return;',
            ),
      )
    },
  })
  const pid = path.join(dir.path, "pid")
  const program = Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const ctx = yield* requireInstance
    const store = yield* InstanceStore.Service
    const file = path.join(ctx.directory, "actual.rayaLsp")
    yield* Effect.promise(() => Bun.write(file, "harmless"))
    const startup = yield* lsp.touchFile(file).pipe(Effect.forkChild)
    yield* Effect.promise(() => withTimeout(entered.promise, 3_000, "actual LSP download did not start"))
    const child = Number(yield* Effect.promise(() => Bun.file(pid).text()))
    process.kill(child, 0)
    yield* Fiber.interrupt(startup)
    let settled = false
    const closing = yield* store.dispose(ctx).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          settled = true
        }),
      ),
      Effect.forkChild,
    )
    yield* Effect.promise(() => Promise.resolve())
    assert.equal(settled, false)
    release.resolve()
    const exit = yield* Fiber.join(closing).pipe(Effect.exit)
    assert.equal(settled, true)
    assert.equal(Exit.isFailure(exit), false)
    assert.equal(absent(child), true)
  }).pipe(
    withTmpdirInstance({
      config: {
        lsp: {
          "raya-held": {
            command: [process.execPath, path.join(import.meta.dir, "lsp-held-download.ts")],
            extensions: [".rayaLsp"],
            env: {
              RAYA_LSP_URL: server.url.href,
              RAYA_LSP_FILE: path.join(dir.path, "actual-lsp.js"),
              RAYA_LSP_PID: pid,
            },
          },
        },
      },
    }),
    Effect.scoped,
    Effect.provide(LayerNode.compile(LSP.node)),
  )
  try {
    await withTimeout(Effect.runPromise(program), 8_000, "actual LSP disposal did not settle")
  } finally {
    release.resolve()
    await server.stop(true)
  }
}

function absent(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ESRCH") return true
    throw err
  }
}

await exercise()
await disposeTestRuntime()
const first = RuntimeRegistry.drain()
assert.equal(RuntimeRegistry.drain(), first)
const result = await first.then(
  () => undefined,
  (err: unknown) => err,
)
if (mode === "failed") {
  assert.ok(result instanceof AggregateError)
  const failures = result.errors.filter(
    (err) => err instanceof AggregateError && err.message === "LSP startup retirement failed",
  )
  assert.equal(failures.length, 1)
  assert.ok(
    failures[0].errors.some(
      (err: unknown) =>
        err instanceof InitializeError &&
        err.cause instanceof Error &&
        err.cause.message === "Actual child initialization refusal",
    ),
  )
  assert.equal(await RuntimeRegistry.drain().catch((err: unknown) => err), result)
}
if (mode === "success") assert.equal(result, undefined)
console.log(JSON.stringify({ mode, registryRefused: result !== undefined }))
