import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SessionRetirement } from "../../src/kilocode/session/retirement"
import { SnapshotRuntime } from "../../src/kilocode/snapshot/runtime"
import { createShutdown } from "../../src/kilocode/cli/shutdown"
import { ProfileWriterRegistry } from "../../src/kilocode/migration/writer-registry"
import { ProfileWriterLive } from "../../src/kilocode/migration/writer-live"
import { tmpdir } from "../fixture/fixture"

async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`Actual Git failed: ${err}`)
  return out.trim()
}

async function registry() {
  const value = ProfileWriterRegistry.make(["profile.data.snapshots"])
  await Effect.runPromise(value.register("profile.data.snapshots"))
  return { value, admission: ProfileWriterLive.from(value, "profile.data.snapshots") }
}

test("unused shutdown does not install Snapshot; lazy independent ports share cutoff and full actual registry lifetime", async () => {
  const unused = SnapshotRuntime.make(createShutdown())
  await Effect.runPromise(unused.close())
  expect(unused.snapshot().installed).toBe(false)
  expect(() => unused.install()).toThrow("closed")
  await using tmp = await tmpdir({ git: true })
  const shutdown = createShutdown()
  const runtime = SnapshotRuntime.make(shutdown)
  const writer = await registry()
  const one = runtime.install(writer.admission)
  const two = runtime.install(writer.admission)
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const finished = Deferred.makeUnsafe<void>()
  const index = path.join(tmp.path, ".git", "index")
  const gate = coordinateNativeRoots([{ kind: "json", path: index }], async () => {
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
  })
  const held = gate.then(
    () => undefined,
    (err) => err,
  )
  await Effect.runPromise(Deferred.await(entered))
  const fiber = await Effect.runPromise(
    one.launch(
      { namespaces: [tmp.path], targets: [index] },
      Effect.promise(async () => {
        await writeFile(path.join(tmp.path, "outer.txt"), "actual shared runtime Git mutation")
        await git(tmp.path, "add", "outer.txt")
      }).pipe(
        Effect.andThen(
          two.run(
            { namespaces: [tmp.path] },
            Effect.promise(() => git(tmp.path, "write-tree")),
          ),
        ),
        Effect.ensuring(Deferred.await(finished)),
      ),
    ),
  )
  expect((await Effect.runPromise(writer.value.snapshot)).active).toEqual([{ id: "profile.data.snapshots", count: 1 }])
  const drain = Effect.runPromise(runtime.close())
  const settled = drain.then(
    () => "done",
    () => "failed",
  )
  await rejects(Effect.runPromise(two.run({ namespaces: [tmp.path] }, Effect.void)), /closed/)
  expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await held).toBeUndefined()
  await Bun.sleep(50)
  expect((await Effect.runPromise(writer.value.snapshot)).active).toHaveLength(1)
  await Effect.runPromise(Deferred.succeed(finished, undefined))
  await drain
  await Effect.runPromise(Fiber.join(fiber))
  await Effect.runPromise(two.cancel(fiber))
  expect((await Effect.runPromise(writer.value.snapshot)).active).toEqual([])
  expect(runtime.snapshot()).toMatchObject({ installed: true, closing: true, carriers: 0, controller: { active: 0 } })
  expect(await git(tmp.path, "ls-files", "outer.txt")).toBe("outer.txt")
  await shutdown.run()
})

test("owned optional cancellation keeps accepted children and full carrier count through gated cleanup", async () => {
  await using tmp = await tmpdir({ git: true })
  const runtime = SnapshotRuntime.make(createShutdown())
  const writer = await registry()
  const one = runtime.install(writer.admission)
  const two = runtime.install(writer.admission)
  const started = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  const fiber = await Effect.runPromise(
    one.launch(
      { namespaces: [tmp.path] },
      Effect.promise(() => git(tmp.path, "status", "--porcelain")).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
        Effect.ensuring(
          two
            .run(
              { namespaces: [tmp.path], targets: [path.join(tmp.path, "final.txt")] },
              Deferred.await(end).pipe(
                Effect.andThen(
                  Effect.promise(() => writeFile(path.join(tmp.path, "final.txt"), "actual joined cleanup")),
                ),
              ),
            )
            .pipe(Effect.orDie),
        ),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(started))
  await Effect.runPromise(two.cancel(fiber))
  const drain = Effect.runPromise(runtime.close())
  const settled = drain.then(
    () => "done",
    () => "failed",
  )
  await Bun.sleep(30)
  expect(runtime.snapshot().controller?.active).toBe(2)
  expect((await Effect.runPromise(writer.value.snapshot)).active).toEqual([{ id: "profile.data.snapshots", count: 1 }])
  expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  await Effect.runPromise(Deferred.succeed(end, undefined))
  await drain
  expect(await Bun.file(path.join(tmp.path, "final.txt")).text()).toBe("actual joined cleanup")
  expect(runtime.snapshot().controller).toMatchObject({ active: 0, failures: 0, cancelled: 1 })
  expect((await Effect.runPromise(writer.value.snapshot)).active).toEqual([])
})

test("periodic producer clears initialization parent and joins real accepted tick finalizer before drain", async () => {
  await using tmp = await tmpdir({ git: true })
  const shutdown = createShutdown()
  const runtime = SnapshotRuntime.make(shutdown)
  const one = runtime.install()
  const two = runtime.install()
  const ready = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  await Effect.runPromise(
    one.run(
      { namespaces: [tmp.path] },
      one.periodic(
        Effect.sleep("20 millis").pipe(
          Effect.andThen(
            two.run(
              { namespaces: [tmp.path] },
              Effect.promise(() => git(tmp.path, "status", "--porcelain")).pipe(
                Effect.andThen(Deferred.succeed(ready, undefined)),
                Effect.andThen(Deferred.await(end)),
                Effect.ensuring(
                  Effect.promise(() => writeFile(path.join(tmp.path, "periodic.txt"), "actual periodic finalizer")),
                ),
              ),
            ),
          ),
          Effect.andThen(Effect.never),
        ),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(ready))
  const closing = shutdown.run()
  const settled = closing.then(
    () => "done",
    () => "failed",
  )
  expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  expect(runtime.snapshot().loops).toBe(1)
  await Effect.runPromise(Deferred.succeed(end, undefined))
  await closing
  expect(runtime.snapshot()).toMatchObject({
    closing: true,
    loops: 0,
    failures: 0,
    controller: { active: 0, failures: 0 },
  })
  expect(await Bun.file(path.join(tmp.path, "periodic.txt")).text()).toBe("actual periodic finalizer")
})

test("actual filesystem error observed before fallback remains sticky with original error identity", async () => {
  await using tmp = await tmpdir({ git: true })
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const error = { value: undefined as unknown }
  const result = await Effect.runPromise(
    port.run(
      { namespaces: [tmp.path] },
      port
        .observe(
          Effect.tryPromise({
            try: () => writeFile(path.join(tmp.path, "missing", "file.txt"), "actual error"),
            catch: (err) => {
              error.value = err
              return err
            },
          }),
        )
        .pipe(Effect.catch(() => Effect.succeed("compatibility fallback"))),
    ),
  )
  expect(result).toBe("compatibility fallback")
  await rejects(Effect.runPromise(runtime.close()), (err) => err === error.value)
  expect(runtime.snapshot().failures).toBe(1)
})

test("actual registry refusal wakes launch rather than hanging and records carrier failure before any Git body", async () => {
  await using tmp = await tmpdir({ git: true })
  const writer = await registry()
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install(writer.admission)
  const ready = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  const closed = Effect.runPromise(
    writer.value.quiesce(Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(end)))),
  )
  await Effect.runPromise(Deferred.await(ready))
  const state = { entered: false }
  await rejects(
    Effect.runPromise(
      port.launch(
        { namespaces: [tmp.path] },
        Effect.sync(() => {
          state.entered = true
        }),
      ),
    ),
    /admission is closed/,
  )
  expect(state.entered).toBe(false)
  expect(runtime.snapshot().controller?.active).toBe(0)
  await Effect.runPromise(Deferred.succeed(end, undefined))
  await closed
  await rejects(Effect.runPromise(runtime.close()), /admission is closed/)
})

test("actual nonzero Git result is retained before compatibility fallback", async () => {
  await using tmp = await tmpdir({ git: true })
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const err = new Error("Snapshot Git mutation refused")
  const result = await Effect.runPromise(
    port.run(
      { namespaces: [tmp.path] },
      Effect.gen(function* () {
        const code = yield* Effect.promise(async () => {
          const child = Bun.spawn(["git", "-C", tmp.path, "update-ref", "refs/kilo/missing", "not-a-real-object"], {
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          })
          return child.exited
        })
        expect(code).not.toBe(0)
        yield* port.failed(err)
        return "optional fallback"
      }),
    ),
  )
  expect(result).toBe("optional fallback")
  await rejects(Effect.runPromise(runtime.close()), (failure) => failure === err)
})

test("instance periodic stop joins actual gated Git cleanup while another instance loop remains live", async () => {
  await using tmp = await tmpdir({ git: true })
  const runtime = SnapshotRuntime.make(createShutdown())
  const one = runtime.install()
  const two = runtime.install()
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const cleaning = Deferred.makeUnsafe<void>()
  const next = Deferred.makeUnsafe<void>()
  const finished = Deferred.makeUnsafe<void>()
  const index = path.join(tmp.path, ".git", "index")
  const gate = coordinateNativeRoots([{ kind: "json", path: index }], async () => {
    await Effect.runPromise(Deferred.succeed(entered, undefined))
    await Effect.runPromise(Deferred.await(release))
  })
  const held = gate.then(
    () => undefined,
    (err) => err,
  )
  await Effect.runPromise(Deferred.await(entered))
  const first = await Effect.runPromise(
    one.periodic(
      one
        .run(
          { namespaces: [tmp.path] },
          Effect.promise(() => git(tmp.path, "status", "--porcelain")).pipe(
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(
                  one
                    .run(
                      { namespaces: [tmp.path], targets: [index] },
                      Effect.promise(async () => {
                        await writeFile(path.join(tmp.path, "stopped.txt"), "actual instance cleanup")
                        await git(tmp.path, "add", "stopped.txt")
                      }),
                    )
                    .pipe(Effect.orDie),
                ),
              ),
            ),
          ),
        )
        .pipe(Effect.andThen(Effect.never)),
    ),
  )
  const second = await Effect.runPromise(
    two.periodic(
      Deferred.await(next).pipe(
        Effect.andThen(
          two.run(
            { namespaces: [tmp.path] },
            Effect.promise(() => writeFile(path.join(tmp.path, "survived.txt"), "second instance remains active")),
          ),
        ),
        Effect.andThen(Deferred.succeed(finished, undefined)),
        Effect.andThen(Effect.never),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(cleaning))
  const stop = Effect.runPromise(one.stop(first))
  const settled = stop.then(
    () => "done",
    () => "failed",
  )
  expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  expect(runtime.snapshot().loops).toBe(2)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await held).toBeUndefined()
  await stop
  await Effect.runPromise(two.stop(first))
  expect(runtime.snapshot()).toMatchObject({ closing: false, loops: 1, failures: 0 })
  expect(await git(tmp.path, "ls-files", "stopped.txt")).toBe("stopped.txt")
  await Effect.runPromise(Deferred.succeed(next, undefined))
  await Effect.runPromise(Deferred.await(finished))
  expect(await Bun.file(path.join(tmp.path, "survived.txt")).text()).toBe("second instance remains active")
  await Effect.runPromise(two.stop(second))
  await Effect.runPromise(runtime.close())
  expect(runtime.snapshot()).toMatchObject({ loops: 0, failures: 0, controller: { active: 0, failures: 0 } })
})

test("periodic stop refuses foreign fibers and self join while successful settled ownership stays harmless", async () => {
  await using tmp = await tmpdir({ git: true })
  const runtime = SnapshotRuntime.make(createShutdown())
  const port = runtime.install()
  const foreign = await Effect.runPromise(Effect.forkDetach(Effect.void))
  await rejects(Effect.runPromise(port.stop(foreign)), /foreign/)
  const done = await Effect.runPromise(
    port.periodic(Effect.promise(() => writeFile(path.join(tmp.path, "done.txt"), "actual completed loop"))),
  )
  await Effect.runPromise(Fiber.join(done))
  await Effect.runPromise(port.stop(done))
  const ready = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const self = await Effect.runPromise(
    port.periodic(
      Deferred.succeed(ready, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(Effect.withFiber((fiber) => port.stop(fiber))),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(ready))
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await rejects(Effect.runPromise(Fiber.join(self)), /cannot stop itself/)
  await rejects(Effect.runPromise(runtime.close()), /cannot stop itself/)
  expect(runtime.snapshot().loops).toBe(0)
})

test("soft quiescence joins old periodic work and permits fresh Git only for authentic still-live Session producers", async () => {
  await using tmp = await tmpdir({ git: true })
  const unused = SnapshotRuntime.make(createShutdown())
  await Effect.runPromise(unused.quiesce())
  expect(unused.snapshot().installed).toBe(false)
  const runtime = SnapshotRuntime.make(createShutdown())
  const writer = await registry()
  const port = runtime.install(writer.admission)
  const producer = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const expired = Deferred.makeUnsafe<void>()
  const old = await Effect.runPromise(
    SessionRetirement.run(() =>
      Effect.forkDetach(
        Deferred.await(expired).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              expect(yield* SessionRetirement.accepted).toBe(false)
              const result = yield* Effect.exit(
                port.run(
                  { namespaces: [tmp.path] },
                  Effect.promise(() => writeFile(path.join(tmp.path, "expired.txt"), "must not write")),
                ),
              )
              expect(result._tag).toBe("Failure")
            }),
          ),
        ),
      ),
    ),
  )
  const foreground = Effect.runPromise(
    SessionRetirement.run(() =>
      Deferred.succeed(producer, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          port.launch(
            { namespaces: [tmp.path] },
            Effect.promise(async () => {
              await writeFile(path.join(tmp.path, "producer.txt"), "accepted producer final Snapshot")
              await git(tmp.path, "add", "producer.txt")
              return git(tmp.path, "write-tree")
            }),
          ),
        ),
        Effect.flatMap(Fiber.join),
      ),
    ),
  )
  const observed = foreground.then(
    () => "done",
    () => "failed",
  )
  await Effect.runPromise(Deferred.await(producer))
  const started = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  await Effect.runPromise(
    port.periodic(
      port
        .run(
          { namespaces: [tmp.path] },
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(end)),
            Effect.ensuring(
              port
                .run(
                  { namespaces: [tmp.path] },
                  Effect.promise(() =>
                    writeFile(path.join(tmp.path, "periodic-retired.txt"), "real accepted tick finalizer"),
                  ),
                )
                .pipe(Effect.orDie),
            ),
          ),
        )
        .pipe(Effect.andThen(Effect.never)),
    ),
  )
  await Effect.runPromise(Deferred.await(started))
  SessionRetirement.fence()
  const quiet = Effect.runPromise(runtime.quiesce())
  const settled = quiet.then(
    () => "done",
    () => "failed",
  )
  await rejects(
    Effect.runPromise(
      port.run(
        { namespaces: [tmp.path] },
        Effect.promise(() => writeFile(path.join(tmp.path, "late.txt"), "must not write")),
      ),
    ),
    /external intake is closed/,
  )
  await rejects(Effect.runPromise(port.periodic(Effect.void)), /periodic intake is closed/)
  expect(await Promise.race([settled, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  expect(await Promise.race([observed, Bun.sleep(30).then(() => "pending")])).toBe("pending")
  await Effect.runPromise(Deferred.succeed(end, undefined))
  await quiet
  expect(runtime.snapshot()).toMatchObject({ paused: true, closing: false, loops: 0, controller: { active: 0 } })
  expect(await Bun.file(path.join(tmp.path, "periodic-retired.txt")).text()).toBe("real accepted tick finalizer")
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(await foreground).toMatch(/^[0-9a-f]{40}$/)
  await Effect.runPromise(Deferred.succeed(expired, undefined))
  await Effect.runPromise(Fiber.join(old))
  await Effect.runPromise(SessionRetirement.drain)
  await Effect.runPromise(runtime.close())
  expect(await Bun.file(path.join(tmp.path, "late.txt")).exists()).toBe(false)
  expect(await Bun.file(path.join(tmp.path, "expired.txt")).exists()).toBe(false)
  expect(runtime.snapshot()).toMatchObject({
    paused: true,
    closing: true,
    loops: 0,
    failures: 0,
    controller: { active: 0, failures: 0 },
  })
  expect((await Effect.runPromise(writer.value.snapshot)).active).toEqual([])
})
