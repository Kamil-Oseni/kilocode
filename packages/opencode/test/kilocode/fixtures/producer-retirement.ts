import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { Deferred, Effect, Fiber } from "effect"
import { drain } from "../../../src/kilocode/cli/producer-retirement"
import { KiloShutdown } from "../../../src/kilocode/cli/shutdown"
import { SessionRetirement } from "../../../src/kilocode/session/retirement"
import { SnapshotRuntime } from "../../../src/kilocode/snapshot/runtime"

const base = path.resolve(os.tmpdir())
const tmp = { path: await mkdtemp(path.join(base, "raya-producer-retirement-")) }
const init = Bun.spawn(["git", "init", tmp.path], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "pipe",
  windowsHide: true,
})
const stderr = new Response(init.stderr).text()
assert.equal(await init.exited, 0, await stderr)
const port = SnapshotRuntime.install()
const entered = Deferred.makeUnsafe<void>()
const release = Deferred.makeUnsafe<void>()
const written = Deferred.makeUnsafe<void>()
const finalizer = Deferred.makeUnsafe<void>()
const producer = await Effect.runPromise(
  SessionRetirement.fork(() =>
    Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(
        port
          .run(
            { namespaces: [tmp.path] },
            Effect.promise(async () => {
              await Bun.write(path.join(tmp.path, "accepted.txt"), "accepted producer after external cutoff")
              const child = Bun.spawn(["git", "add", "accepted.txt"], {
                cwd: tmp.path,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "pipe",
                windowsHide: true,
              })
              const stderr = new Response(child.stderr).text()
              assert.equal(await child.exited, 0, await stderr)
            }),
          )
          .pipe(Effect.orDie),
      ),
      Effect.andThen(Deferred.succeed(written, undefined)),
      Effect.ensuring(Deferred.await(finalizer)),
    ),
  ),
)
await Effect.runPromise(Deferred.await(entered))
const stopping = Effect.runPromise(drain)
const observed = stopping.then(() => "done")
assert.equal(await Promise.race([observed, Bun.sleep(25).then(() => "pending")]), "pending")
assert.equal(SessionRetirement.snapshot().closing, true)
assert.equal(SnapshotRuntime.snapshot().paused, true)
await assert.rejects(Effect.runPromise(SessionRetirement.run(() => Effect.void)), /intake is closed/)
await assert.rejects(
  Effect.runPromise(
    port.run(
      { namespaces: [tmp.path] },
      Effect.promise(() => Bun.write(path.join(tmp.path, "late.txt"), "late")),
    ),
  ),
  /external intake is closed/,
)
await Effect.runPromise(Deferred.succeed(release, undefined))
await Effect.runPromise(Deferred.await(written))
assert.equal(await Bun.file(path.join(tmp.path, "accepted.txt")).text(), "accepted producer after external cutoff")
assert.equal(await Promise.race([observed, Bun.sleep(25).then(() => "pending")]), "pending")
await Effect.runPromise(Deferred.succeed(finalizer, undefined))
await stopping
await Effect.runPromise(Fiber.join(producer))
await KiloShutdown.run()
assert.equal(await Bun.file(path.join(tmp.path, "late.txt")).exists(), false)
assert.equal(SessionRetirement.snapshot().active, 0)
assert.equal(SnapshotRuntime.snapshot().controller?.active, 0)
assert.equal(SnapshotRuntime.snapshot().failures, 0)
assert.equal(path.dirname(path.resolve(tmp.path)), base)
assert.ok(path.basename(tmp.path).startsWith("raya-producer-retirement-"))
await rm(tmp.path, { recursive: true })
process.stdout.write("producer-retirement actual Git and finalizers passed\n")
