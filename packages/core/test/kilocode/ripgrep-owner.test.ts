import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { createOwner, cleanup } from "../../src/kilocode/ripgrep-owner"
import { createRegistry } from "../../src/kilocode/runtime-registry"
import { coordinateNativeRoots } from "../../src/kilocode/profile-maintenance"
import { processProfileSnapshot } from "../../src/kilocode/process-profile"

async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "raya-ripgrep-owner-"))
  const bin = path.join(root, "bin")
  await mkdir(bin)
  return bin
}

test("independent processes serialize admitted bin writes", async () => {
  const bin = await directory()
  await writeFile(path.join(bin, "count"), "0")
  const children = [0, 1].map(() =>
    Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "fixture/ripgrep-contention.ts"), bin], {
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  const output = children.map((child) =>
    Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]),
  )
  const codes = await Promise.all(children.map((child) => child.exited))
  const logs = await Promise.all(output)
  expect(codes, logs.flat().join("\n")).toEqual([0, 0])
  expect(await readFile(path.join(bin, "count"), "utf8")).toBe("2")
}, 10_000)

test("unused and invalid selection do not install a participant", async () => {
  const registry = createRegistry()
  const owner = createOwner(registry)
  const exit = await Effect.runPromiseExit(
    owner.run(
      () => "relative",
      () => Effect.void,
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(owner.snapshot()).toEqual({ installed: false, closed: false, active: 0, failures: 0 })
  await registry.drain()
})

test("canonical admission precedes effects and retirement joins publication", async () => {
  const bin = await directory()
  const registry = createRegistry()
  const owner = createOwner(registry)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = coordinateNativeRoots([{ kind: "json", path: bin }], async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const work = Effect.runPromise(
    owner.run(
      () => bin,
      (root) =>
        Effect.promise(async () => {
          await writeFile(path.join(root, "accepted"), "complete")
          started.resolve()
          await finish.promise
          await writeFile(path.join(root, "finalized"), "complete")
        }),
    ),
  )
  await Bun.sleep(100)
  expect(await readdir(bin)).toEqual([])
  release.resolve()
  await held
  await started.promise
  const closing = registry.drain()
  expect(owner.snapshot().active).toBe(1)
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        owner.run(
          () => bin,
          () => Effect.void,
        ),
      ),
    ),
  ).toBe(true)
  finish.resolve()
  await work
  await closing
  expect(await readFile(path.join(bin, "finalized"), "utf8")).toBe("complete")
  expect(owner.snapshot().active).toBe(0)
})

test("interrupt stalled real child but join its held exit and finalizer before retirement", async () => {
  const bin = await directory()
  const registry = createRegistry()
  const owner = createOwner(registry)
  const started = Promise.withResolvers<void>()
  const finalizing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const fiber = Effect.runFork(
    owner.run(
      () => bin,
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => child),
          () => Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
          (owned) =>
            Effect.promise(async () => {
              owned.kill()
              await owned.exited
              finalizing.resolve()
              await release.promise
              await writeFile(path.join(bin, "finalized"), "joined")
            }),
        ),
    ),
  )
  await started.promise
  const interrupt = Effect.runPromise(Fiber.interrupt(fiber))
  await finalizing.promise
  const closing = registry.drain().then(
    () => "success",
    () => "failure",
  )
  expect(owner.snapshot().active).toBe(1)
  release.resolve()
  await interrupt
  expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
  expect(await closing).toBe("failure")
  expect(owner.snapshot()).toEqual({ installed: true, closed: true, active: 0, failures: 1 })
  expect(await readFile(path.join(bin, "finalized"), "utf8")).toBe("joined")
  expect(processProfileSnapshot().roots).toContain(bin)
}, 10_000)

test("retain original and actual filesystem cleanup failure", async () => {
  const bin = await directory()
  const registry = createRegistry()
  const owner = createOwner(registry)
  const exit = await Effect.runPromiseExit(
    owner.run(
      () => bin,
      () =>
        cleanup(
          Effect.fail(new Error("original extraction failed")),
          Effect.promise(async () => {
            await readFile(path.join(bin, "absent-cleanup-file"))
          }),
        ),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) throw new Error("Expected failed operation")
  const failure = Cause.squash(exit.cause)
  if (!(failure instanceof AggregateError)) throw new Error("Expected both actual failures")
  const errors = failure.errors
  expect(String(errors[0])).toContain("original extraction failed")
  expect(String(errors[1])).toContain("ENOENT")
  const retired = await registry.drain().then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(retired).toBeInstanceOf(AggregateError)
})

test("accepted missing root is sticky and subsequent selected root is revalidated", async () => {
  const bin = await directory()
  const registry = createRegistry()
  const owner = createOwner(registry)
  await Effect.runPromise(
    owner.run(
      () => bin,
      (root) => Effect.promise(() => writeFile(path.join(root, "first"), "one")),
    ),
  )
  const absent = path.join(bin, "missing")
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        owner.run(
          () => absent,
          () => Effect.void,
        ),
      ),
    ),
  ).toBe(true)
  expect(owner.snapshot().failures).toBe(1)
  const retired = await registry.drain().then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(retired).toBeInstanceOf(AggregateError)
})

test("root binding is checked after actual scoped finalizers", async () => {
  const bin = await directory()
  const registry = createRegistry()
  const owner = createOwner(registry)
  const exit = await Effect.runPromiseExit(
    owner.run(
      () => bin,
      () =>
        Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await rename(bin, bin + "-prior")
            await mkdir(bin)
          }),
        ),
    ),
  )
  if (!Exit.isFailure(exit)) throw new Error("Expected replaced finalizer root refusal")
  const error = Cause.squash(exit.cause)
  expect(error).toBeInstanceOf(AggregateError)
  if (!(error instanceof AggregateError)) throw new Error("Expected scope and postcheck failures")
  expect(error.errors.some((err) => String(err).includes("Ripgrep bin root binding changed"))).toBe(true)
  const retired = await registry.drain().then(
    () => undefined,
    (err: unknown) => err,
  )
  expect(retired).toBeInstanceOf(AggregateError)
})
