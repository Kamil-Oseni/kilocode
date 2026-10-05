import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { coordinateNativeRoots } from "@opencode-ai/core/kilocode/profile-maintenance"
import { SnapshotAdmission } from "../../src/kilocode/snapshot/admission"
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

async function gate(file: string) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const done = coordinateNativeRoots([{ kind: "json", path: file }], async () => {
    entered.resolve()
    await released.promise
  })
  const settled = done.then(
    () => undefined,
    (err) => err,
  )
  await entered.promise
  return { release: released.resolve, done: settled }
}

test("actual namespace and exact Git index gates retain accepted work and finalizers through drain", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, ".git", "index")
  for (const selected of [tmp.path, file]) {
    const held = await gate(selected)
    const controller = SnapshotAdmission.make()
    const end = Deferred.makeUnsafe<void>()
    const state = { started: false }
    const input = { namespaces: [tmp.path], targets: [file] }
    const work = Effect.runPromise(
      controller.run(input, () =>
        Effect.promise(async () => {
          state.started = true
          await writeFile(path.join(tmp.path, "tracked.txt"), selected)
          await git(tmp.path, "add", "tracked.txt")
          return git(tmp.path, "write-tree")
        }).pipe(
          Effect.ensuring(
            Deferred.await(end).pipe(
              Effect.andThen(
                Effect.promise(() =>
                  writeFile(path.join(tmp.path, "finalized.txt"), "actual filesystem finalizer completed"),
                ),
              ),
            ),
          ),
        ),
      ),
    )
    const settled = work.then(
      () => undefined,
      (err) => err,
    )
    await Bun.sleep(100)
    expect(controller.snapshot().active).toBe(1)
    expect(state.started).toBe(false)
    // The accepted invocation retains its selection even if the caller mutates its input during the gate wait.
    input.namespaces[0] = path.join(tmp.path, "changed-selection")
    input.targets[0] = path.join(tmp.path, "changed-target")
    controller.fence()
    const drain = Effect.runPromise(controller.drain)
    const checked = drain.then(
      () => "done",
      () => "failed",
    )
    expect(await Promise.race([checked, Bun.sleep(20).then(() => "pending")])).toBe("pending")
    held.release()
    expect(await held.done).toBeUndefined()
    await Bun.sleep(50)
    expect(controller.snapshot().active).toBe(1)
    await Effect.runPromise(Deferred.succeed(end, undefined))
    expect(await settled).toBeUndefined()
    await drain
    expect(controller.snapshot().active).toBe(0)
    expect(await Bun.file(path.join(tmp.path, "finalized.txt")).text()).toBe("actual filesystem finalizer completed")
    expect(await git(tmp.path, "ls-files", "tracked.txt")).toBe("tracked.txt")
  }
})

test("optional caller timeout leaves owned fork and actual finalizer counted; accepted nested work survives fence", async () => {
  await using tmp = await tmpdir({ git: true })
  const controller = SnapshotAdmission.make()
  const start = Deferred.makeUnsafe<void>()
  const finish = Deferred.makeUnsafe<void>()
  const input = { namespaces: [tmp.path] }
  const fiber = Effect.runFork(
    controller.run(input, (parent) =>
      Effect.gen(function* () {
        yield* controller.fork(parent, input, (child) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(start, undefined)
            yield* Deferred.await(finish)
            yield* controller.run(
              { namespaces: [tmp.path], targets: [path.join(tmp.path, ".git", "index")] },
              () =>
                Effect.promise(async () => {
                  await writeFile(path.join(tmp.path, "nested.txt"), "genuine accepted child")
                  await git(tmp.path, "add", "nested.txt")
                }),
              child,
            )
          }),
        )
        return "optional result"
      }),
    ),
  )
  await Effect.runPromise(Deferred.await(start))
  expect(await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeoutOption("10 millis")))).toMatchObject({
    _tag: "None",
  })
  controller.fence()
  expect(controller.snapshot().active).toBe(2)
  await rejects(Effect.runPromise(controller.run(input, () => Effect.void)), /closed/)
  const drain = Effect.runPromise(controller.drain)
  await Effect.runPromise(Deferred.succeed(finish, undefined))
  await drain
  expect(await Effect.runPromise(Fiber.join(fiber))).toBe("optional result")
  expect(controller.snapshot().active).toBe(0)
  expect(await git(tmp.path, "ls-files", "nested.txt")).toBe("nested.txt")
})

test("real Git failure and finalizer failure remain sticky; forged and expired parents cannot acquire", async () => {
  await using tmp = await tmpdir({ git: true })
  const controller = SnapshotAdmission.make()
  const input = { namespaces: [tmp.path] }
  const parent = { value: undefined as SnapshotAdmission.Parent | undefined }
  await Effect.runPromise(
    controller.run(input, (token) =>
      Effect.sync(() => {
        parent.value = token
      }),
    ),
  )
  await rejects(Effect.runPromise(controller.run(input, () => Effect.void, parent.value)), /parent/)
  const forged: SnapshotAdmission.Parent = Object.create(null)
  await rejects(Effect.runPromise(controller.run(input, () => Effect.void, forged)), /parent/)
  await rejects(
    Effect.runPromise(controller.run(input, () => Effect.promise(() => git(tmp.path, "not-a-real-command")))),
    /Actual Git failed/,
  )
  const error = new Error("Actual finalizer failed")
  await rejects(
    Effect.runPromise(controller.run(input, () => Effect.void.pipe(Effect.ensuring(Effect.die(error))))),
    /Actual finalizer failed/,
  )
  expect(controller.snapshot().failures).toBe(2)
  await rejects(Effect.runPromise(controller.drain), /Snapshot retirement failed/)
})

test("real canonical alias is admitted and detected directory rebind refuses retirement", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "repository")
  const other = path.join(tmp.path, "foreign")
  const alias = path.join(tmp.path, "alias")
  await mkdir(root)
  await mkdir(other)
  await git(root, "init")
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
  const controller = SnapshotAdmission.make()
  await Effect.runPromise(
    controller.run({ namespaces: [alias], targets: [path.join(alias, ".git", "index")] }, () =>
      Effect.promise(() => git(root, "status", "--porcelain")),
    ),
  )
  await rejects(
    Effect.runPromise(
      controller.run({ namespaces: [alias] }, () =>
        Effect.promise(async () => {
          await unlink(alias)
          await symlink(other, alias, process.platform === "win32" ? "junction" : "dir")
        }),
      ),
    ),
    /binding changed/,
  )
  expect(await Bun.file(path.join(other, ".git", "index")).exists()).toBe(false)
  await unlink(alias)
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir")
  await rejects(Effect.runPromise(controller.drain), /binding changed/)
})

test("missing namespace cannot acquire body authority; explicit parent bootstrap pins before Git mutations", async () => {
  await using tmp = await tmpdir()
  const missing = path.join(tmp.path, "new-repository")
  const refused = SnapshotAdmission.make()
  const state = { entered: false }
  await rejects(
    Effect.runPromise(
      refused.run({ namespaces: [missing] }, () =>
        Effect.sync(() => {
          state.entered = true
        }),
      ),
    ),
    /ENOENT/,
  )
  expect(state.entered).toBe(false)
  const controller = SnapshotAdmission.make()
  await Effect.runPromise(
    controller.run({ namespaces: [tmp.path], targets: [missing] }, (parent) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => mkdir(missing, { recursive: true }))
        yield* controller.run(
          { namespaces: [missing], targets: [path.join(missing, ".git")] },
          () => Effect.promise(() => git(missing, "init")),
          parent,
        )
      }),
    ),
  )
  expect(await git(missing, "rev-parse", "--git-dir")).toBe(".git")
  await rejects(
    Effect.runPromise(
      controller.run({ namespaces: [missing] }, () =>
        Effect.promise(async () => {
          await rename(missing, path.join(tmp.path, "original-repository"))
          await mkdir(missing)
        }),
      ),
    ),
    /identity changed/,
  )
  expect(await Bun.file(path.join(missing, ".git", "config")).exists()).toBe(false)
})

test("external launch returns optionally while exact cancelled fiber retains real gated filesystem finalizer", async () => {
  await using tmp = await tmpdir({ git: true })
  const file = path.join(tmp.path, "cancel-finalizer.txt")
  const held = await gate(file)
  const started = Deferred.makeUnsafe<void>()
  const controller = SnapshotAdmission.make()
  const fiber = await Effect.runPromise(
    controller.launch({ namespaces: [tmp.path] }, (parent) =>
      Effect.promise(async () => {
        await writeFile(path.join(tmp.path, "launch.txt"), "actual launched Git mutation")
        await git(tmp.path, "add", "launch.txt")
      }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
        Effect.ensuring(
          controller
            .run(
              { namespaces: [tmp.path], targets: [file] },
              () => Effect.promise(() => writeFile(file, "joined actual finalizer")),
              parent,
            )
            .pipe(Effect.orDie),
        ),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(started))
  expect(await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeoutOption("10 millis")))).toMatchObject({
    _tag: "None",
  })
  controller.fence()
  await Effect.runPromise(controller.cancel(fiber))
  const drain = Effect.runPromise(controller.drain)
  const settled = drain.then(
    () => "done",
    () => "failed",
  )
  await Bun.sleep(50)
  expect(controller.snapshot().active).toBe(2)
  expect(await Bun.file(file).exists()).toBe(false)
  expect(await Promise.race([settled, Bun.sleep(20).then(() => "pending")])).toBe("pending")
  held.release()
  expect(await held.done).toBeUndefined()
  await drain
  expect(controller.snapshot()).toMatchObject({ active: 0, failures: 0, cancelled: 1 })
  expect(await Bun.file(file).text()).toBe("joined actual finalizer")
  expect(await git(tmp.path, "ls-files", "launch.txt")).toBe("launch.txt")
  await Effect.runPromise(controller.cancel(fiber))
  expect(controller.snapshot()).toMatchObject({ active: 0, failures: 0, cancelled: 1 })
  await rejects(Effect.runPromise(controller.launch({ namespaces: [tmp.path] }, () => Effect.void)), /closed/)
})

test("requested cancellation never hides real typed filesystem failure or finalizer defect", async () => {
  await using tmp = await tmpdir({ git: true })
  for (const typed of [true, false]) {
    const controller = SnapshotAdmission.make()
    const started = Deferred.makeUnsafe<void>()
    const resume = Deferred.makeUnsafe<void>()
    const missing = path.join(tmp.path, typed ? "typed" : "defect", "missing", "finalizer.txt")
    const body = typed
      ? Effect.gen(function* () {
          yield* Effect.promise(() => git(tmp.path, "status", "--porcelain"))
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(resume)
          yield* Effect.tryPromise({ try: () => writeFile(missing, "must refuse"), catch: (err) => err })
        }).pipe(Effect.uninterruptible)
      : Effect.promise(() => git(tmp.path, "status", "--porcelain")).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.promise(() => writeFile(missing, "must refuse"))),
        )
    const fiber = await Effect.runPromise(controller.launch({ namespaces: [tmp.path] }, () => body))
    await Effect.runPromise(Deferred.await(started))
    await Effect.runPromise(controller.cancel(fiber))
    await Effect.runPromise(Deferred.succeed(resume, undefined))
    await Effect.runPromise(Fiber.await(fiber))
    expect(controller.snapshot()).toMatchObject({ active: 0, failures: 1, cancelled: 0 })
    await rejects(Effect.runPromise(controller.drain), /ENOENT/)
  }
})

test("foreign cancellation cannot grant authority and unrequested owned interruption stays sticky", async () => {
  await using tmp = await tmpdir({ git: true })
  const controller = SnapshotAdmission.make()
  const other = SnapshotAdmission.make()
  const started = Deferred.makeUnsafe<void>()
  const fiber = await Effect.runPromise(
    controller.launch({ namespaces: [tmp.path] }, () =>
      Effect.promise(() => git(tmp.path, "status", "--porcelain")).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(started))
  await rejects(Effect.runPromise(other.cancel(fiber)), /foreign/)
  expect(controller.snapshot().active).toBe(1)
  await Effect.runPromise(Fiber.interrupt(fiber))
  expect(controller.snapshot()).toMatchObject({ active: 0, failures: 1, cancelled: 0 })
  await rejects(Effect.runPromise(controller.drain))
})

test("actual Git body failure and physical lease retirement failure retain both original causes", async () => {
  await using tmp = await tmpdir({ git: true })
  const dir = path.join(tmp.path, "owned-repository")
  await mkdir(dir)
  await git(dir, "init")
  const controller = SnapshotAdmission.make()
  const error = new Error("Actual Snapshot body failed")
  await rejects(
    Effect.runPromise(
      controller.run({ namespaces: [dir] }, () =>
        Effect.promise(async () => {
          await git(dir, "write-tree")
          await rename(dir, `${dir}.original`)
          await mkdir(dir)
          throw error
        }),
      ),
    ),
    (err: unknown) => {
      expect(err).toBeInstanceOf(AggregateError)
      if (!(err instanceof AggregateError)) return false
      expect(err.errors).toContain(error)
      expect(
        err.errors.some(
          (cause: unknown) => cause instanceof Error && cause.message.includes("physical identity changed"),
        ),
      ).toBe(true)
      return true
    },
  )
  await rejects(
    Effect.runPromise(controller.drain),
    (err: unknown) => err instanceof AggregateError && err.errors.includes(error),
  )
})

test("owned ancestor cancellation never qualifies a separately detached descendant interruption", async () => {
  await using tmp = await tmpdir({ git: true })
  const controller = SnapshotAdmission.make()
  const ready = Deferred.makeUnsafe<Fiber.Fiber<void, unknown>>()
  const entered = Deferred.makeUnsafe<void>()
  const parent = await Effect.runPromise(
    controller.launch({ namespaces: [tmp.path] }, (token) =>
      Effect.gen(function* () {
        const child = yield* controller.fork(token, { namespaces: [tmp.path] }, () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => git(tmp.path, "config", "test.actual", "detached"))
            yield* Deferred.succeed(entered, undefined)
            yield* Effect.never
          }),
        )
        yield* Deferred.succeed(ready, child)
        yield* Effect.never
      }),
    ),
  )
  const child = await Effect.runPromise(Deferred.await(ready))
  await Effect.runPromise(Deferred.await(entered))
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* controller.cancel(parent)
      // The same caller ID is an authorized parent signal, not authority to cancel this detached child.
      yield* Fiber.interrupt(child)
    }),
  )
  await Effect.runPromise(Fiber.await(parent))
  expect(controller.snapshot()).toMatchObject({ active: 0, failures: 1, cancelled: 1 })
  await rejects(Effect.runPromise(controller.drain), /interrupted/)
})
