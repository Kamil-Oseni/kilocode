import assert from "node:assert/strict"
import { appendFileSync, existsSync, watch } from "node:fs"
import { join } from "node:path"
import { Effect, Deferred } from "effect"
import { parentLifecycle } from "../../../src/kilocode/cli/cmd/tui/parent-lifecycle"
import { parentStop } from "../../../src/kilocode/cli/cmd/tui/parent-stop"
import { Rpc } from "../../../src/util/rpc"
import * as WorkerIdentity from "../../../src/kilocode/cli/cmd/tui/worker-identity"
import type { rpc } from "./parent-stop-worker"

const dir = process.argv[2]
const mode = process.argv[3]
const env = { ...process.env, KILO_RUN_ID: crypto.randomUUID(), [WorkerIdentity.GENERATION]: crypto.randomUUID() }
const request = WorkerIdentity.request(WorkerIdentity.identity(env))
const worker = new Worker(new URL("./parent-stop-worker.ts", import.meta.url).href, { env })
const client = Rpc.client<typeof rpc>(worker)
const ready = Promise.withResolvers<void>()
const released = Promise.withResolvers<void>()
const held = Promise.withResolvers<void>()
const published = Promise.withResolvers<void>()
const counts = { shutdown: 0, close: 0, disposed: 0, upgrade: 0 }
client.on("ready", () => ready.resolve())
client.on("requested", () => {
  counts.shutdown += 1
})
client.on("held", () => worker.postMessage("fixture.release"))
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
const listeners = signals.map((signal) => process.listenerCount(signal))
const stop = parentStop({ worker, request, shutdown: () => client.call("shutdown", request), detach: () => undefined })
const lifecycle = parentLifecycle({ stop })
const timer = setTimeout(() => {
  counts.upgrade += 1
}, 60_000)
lifecycle.defer(() => {
  clearTimeout(timer)
  counts.disposed += 1
})
await ready.promise
await client.call("init", { file: join(dir, "worker.db"), mode: mode === "combined" ? "failed" : "held" })
await new Promise<void>((resolve, reject) => {
  const file = join(dir, "release")
  if (existsSync(file)) return resolve()
  const watcher = watch(dir, () => {
    if (!existsSync(file)) return
    clearTimeout(timer)
    watcher.close()
    resolve()
  })
  const timer = setTimeout(() => {
    watcher.close()
    reject(new Error("Parent identity admission did not release"))
  }, 10_000)
})
if (mode === "startup") {
  const failure = new Error("Actual startup body rejected")
  const result = await lifecycle.use(() => Promise.reject(failure)).catch((err) => err)
  assert(result instanceof AggregateError)
  assert.equal(result.cause, failure)
} else {
  const done = lifecycle.render(async (publish) => {
    if (mode === "publication") await published.promise
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => setInterval(() => undefined, 60_000)),
            (timer) => Effect.sync(() => clearInterval(timer)),
          )
          const gate = yield* Deferred.make<void>()
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              held.resolve()
              await released.promise
              appendFileSync(join(dir, "renderer.txt"), "scope-finalized\n")
              if (mode === "failure" || mode === "combined") throw new Error("Actual renderer finalizer failed")
            }),
          )
          publish(() => {
            counts.close += 1
            Deferred.doneUnsafe(gate, Effect.void)
          })
          published.resolve()
          yield* Deferred.await(gate)
        }),
      ),
    )
  })
  if (mode === "publication") {
    await Promise.resolve()
    process.emit("SIGINT")
    published.resolve()
  } else {
    await published.promise
    process.emit(mode === "failure" || mode === "combined" ? "SIGINT" : (mode as NodeJS.Signals))
  }
  const first = lifecycle.finish()
  const result = first.catch((err) => err)
  assert.equal(lifecycle.finish(), first)
  await held.promise
  await Promise.resolve()
  assert.equal(counts.shutdown, 0)
  assert.equal(counts.disposed, 1)
  process.emit("SIGINT")
  released.resolve()
  await done.catch(() => undefined)
  const failure = await result
  if (mode === "failure" || mode === "combined") {
    assert(failure instanceof AggregateError)
    assert(String(failure.errors[0]).includes("Actual renderer finalizer failed"))
    if (mode === "combined") {
      assert.equal(failure.errors.length, 2)
      assert(String(failure.errors[1]).includes("TUI worker shutdown failed"))
    }
    assert.equal(await lifecycle.finish().catch((err) => err), failure)
  } else assert.equal(failure, undefined)
  assert.equal(counts.close, 1)
}
assert.equal(counts.shutdown, 1)
assert.equal(counts.upgrade, 0)
assert.deepEqual(
  signals.map((signal) => process.listenerCount(signal)),
  listeners,
)
const result = {
  ok: true,
  mode,
  counts,
  platform: process.platform,
  evidence:
    "Actual isolated Bun process signal-listener dispatch via process.emit, scoped finalizer and correlated real Worker natural exit; not OS signal delivery or a Windows Ctrl-C keypress",
}
console.log(JSON.stringify(result))
