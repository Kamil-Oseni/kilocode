import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { createOwner, cleanup } from "../../src/kilocode/ripgrep-owner"
import { createRegistry } from "../../src/kilocode/runtime-registry"
import { coordinateNativeRoots, resolveProfileRoot } from "../../src/kilocode/profile-maintenance"
import { processProfileSnapshot } from "../../src/kilocode/process-profile"
import { Flock } from "../../src/util/flock"
import { Hash } from "../../src/util/hash"

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

test("cancel lookup before its body under real profile maintenance without poisoning retirement", async () => {
  const bin = await directory()
  const registry = createRegistry()
  const owner = createOwner(registry)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = coordinateNativeRoots([{ kind: "json", path: bin }], async () => {
    entered.resolve()
    await release.promise
  })
  await Promise.race([
    entered.promise,
    held.then(() => {
      throw new Error("Maintenance completed before the held admission barrier")
    }),
  ])
  let called = false
  const fiber = Effect.runFork(
    owner.run(
      () => bin,
      () => {
        called = true
        return Effect.promise(() => writeFile(path.join(bin, "unexpected"), "entered"))
      },
    ),
  )
  try {
    const stop = performance.now() + 2_000
    while (!owner.snapshot().active && performance.now() < stop) await Bun.sleep(5)
    expect(owner.snapshot().active).toBe(1)
    expect(called).toBe(false)
    fiber.interruptUnsafe()
    release.resolve()
    await held
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(called).toBe(false)
    expect(await readdir(bin)).toEqual([])
    const retired = await registry.drain().then(
      () => "success",
      (err: unknown) => err,
    )
    expect(retired).toBe("success")
    expect(owner.snapshot()).toEqual({ installed: true, closed: true, active: 0, failures: 0 })
  } finally {
    fiber.interruptUnsafe()
    release.resolve()
    await Promise.allSettled([held, Effect.runPromise(Fiber.await(fiber)), registry.drain()])
  }
}, 10_000)

test("prebody interruption retains actual owned profile marker release refusal", async () => {
  const bin = await directory()
  const root = await resolveProfileRoot({ kind: "json", path: bin })
  const dir = path.join(path.dirname(root.path), ".raya-profile-locks", Hash.fast(root.id) + ".writers")
  const lock = await Flock.acquire(`ripgrep-bin:${root.id}`, {
    dir: path.join(root.path, ".raya-ripgrep-locks"),
    recover: "dead",
  })
  const registry = createRegistry()
  const owner = createOwner(registry)
  let called = false
  let marker: string | undefined
  let original: string | undefined
  const failures: unknown[] = []
  let released = false
  const fiber = Effect.runFork(
    owner.run(
      () => bin,
      () => {
        called = true
        return Effect.void
      },
    ),
  )
  try {
    const stop = performance.now() + 2_000
    let names: string[] = []
    while (!names.length && performance.now() < stop) {
      names = await readdir(dir).catch((err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return []
        throw err
      })
      if (!names.length) await Bun.sleep(5)
    }
    expect(names).toHaveLength(1)
    const name = names[0]
    expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/)
    const file = path.join(dir, name)
    const bytes = await readFile(file, "utf8")
    const record: unknown = JSON.parse(bytes)
    if (
      !record ||
      typeof record !== "object" ||
      !("pid" in record) ||
      !("hostname" in record) ||
      !("token" in record) ||
      typeof record.token !== "string"
    )
      throw new Error("Expected the actual owned profile operation marker")
    expect(record.pid).toBe(process.pid)
    expect(record.hostname).toBe(os.hostname())
    expect(`${record.token}.json`).toBe(name)
    marker = file
    original = bytes
    expect(called).toBe(false)
    await writeFile(marker, JSON.stringify({ ...record, token: "changed-by-own-fixture" }))
    fiber.interruptUnsafe()
    await lock.release()
    released = true
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(called).toBe(false)
    expect(Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    if (!Exit.isFailure(exit)) throw new Error("Expected actual profile release refusal")
    expect(String(Cause.squash(exit.cause))).toContain("Refusing to release changed profile operation ownership")
    const retired = await registry.drain().then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(retired).toBeInstanceOf(AggregateError)
    expect(owner.snapshot()).toEqual({ installed: true, closed: true, active: 0, failures: 1 })
  } catch (err) {
    failures.push(err)
  } finally {
    fiber.interruptUnsafe()
    if (!released) await lock.release().catch((err: unknown) => failures.push(err))
    // Retirement's expected refusal is asserted above; cleanup still joins that original promise.
    const joins = await Promise.allSettled([Effect.runPromise(Fiber.await(fiber)), registry.drain()])
    if (joins[0].status === "rejected") failures.push(joins[0].reason)
    if (marker && original !== undefined) {
      await (async () => {
        await writeFile(marker, original)
        expect(await readFile(marker, "utf8")).toBe(original)
        await unlink(marker)
      })().catch((err: unknown) => failures.push(err))
    }
  }
  if (failures.length) throw new AggregateError(failures, "Fixture operation or cleanup failed")
}, 10_000)

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
