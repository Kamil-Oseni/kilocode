import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { SessionRetirement } from "../../src/kilocode/session/retirement"
import { Runner } from "../../src/effect/runner"
import { observe } from "../../src/kilocode/effect/observation"
import { KiloRunner } from "../../src/kilocode/effect/runner"

async function git(dir: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code) throw new Error(`Git failed: ${err}`)
  return out.trim()
}

test("unused shared port realizes no runtime in an actual fresh process", async () => {
  const file = new URL("../../src/kilocode/session/retirement.ts", import.meta.url).href
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const {SessionRetirement}=await import(${JSON.stringify(file)}); const {Effect}=await import("effect"); console.log(JSON.stringify([SessionRetirement.snapshot(), await Effect.runPromise(SessionRetirement.accepted), SessionRetirement.snapshot()]));`,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(err).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(out)).toEqual([{ installed: false }, false, { installed: false }])
})

test("context queries authenticate the live child independently of its returned foreground", async () => {
  const before = SessionRetirement.snapshot()
  const controller = SessionRetirement.make()
  const other = SessionRetirement.make()
  const start = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  const fiber = await Effect.runPromise(
    controller.run(() =>
      controller.fork((token) =>
        Effect.gen(function* () {
          expect(yield* controller.current).toBe(token)
          expect(yield* controller.accepted).toBe(true)
          expect(yield* other.accepted).toBe(false)
          yield* Deferred.succeed(start, undefined)
          yield* Deferred.await(end)
          expect(yield* controller.accepted).toBe(true)
          yield* controller.run(() =>
            Effect.gen(function* () {
              expect(yield* controller.accepted).toBe(true)
            }),
          )
        }),
      ),
    ),
  )
  await Effect.runPromise(Deferred.await(start))
  controller.fence()
  expect(await Effect.runPromise(controller.accepted)).toBe(false)
  await Effect.runPromise(Deferred.succeed(end, undefined))
  await Effect.runPromise(Fiber.join(fiber))
  await Effect.runPromise(controller.drain)
  expect(controller.snapshot().active).toBe(0)
  expect(await Effect.runPromise(SessionRetirement.accepted)).toBe(false)
  expect(SessionRetirement.snapshot()).toEqual(before)
})

test("detached child's actual failing finalizer remains sticky after foreground success", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-session-child-failure-"))
  const controller = SessionRetirement.make()
  const end = Deferred.makeUnsafe<void>()
  try {
    const fiber = await Effect.runPromise(
      controller.run(() =>
        controller.fork(() =>
          Deferred.await(end).pipe(
            Effect.ensuring(Effect.promise(() => readFile(path.join(dir, "missing.txt"))).pipe(Effect.asVoid)),
          ),
        ),
      ),
    )
    controller.fence()
    expect(controller.snapshot().active).toBe(1)
    await Effect.runPromise(Deferred.succeed(end, undefined))
    expect((await Effect.runPromise(Fiber.await(fiber)))._tag).toBe("Failure")
    await rejects(Effect.runPromise(controller.drain), /ENOENT/)
    expect(controller.snapshot().failures).toBe(1)
  } finally {
    await Effect.runPromise(Deferred.succeed(end, undefined))
    await rm(dir, { recursive: true, force: true })
  }
})

test("foreground returns while genuine child and Git finalizer remain owned; descendants survive cutoff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-session-retirement-"))
  const controller = SessionRetirement.make()
  const start = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  const finish = Deferred.makeUnsafe<void>()
  try {
    await git(dir, "init")
    const fiber = await Effect.runPromise(
      controller.run(() =>
        controller.fork(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(start, undefined)
            yield* Deferred.await(end)
            yield* controller.run(() =>
              Effect.promise(() => writeFile(path.join(dir, "child.txt"), "accepted descendant")),
            )
          }).pipe(
            Effect.ensuring(
              Deferred.await(finish).pipe(
                Effect.andThen(
                  controller.run(() =>
                    Effect.promise(async () => {
                      await git(dir, "add", "child.txt")
                      await writeFile(path.join(dir, "tree.txt"), await git(dir, "write-tree"))
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    )
    await Effect.runPromise(Deferred.await(start))
    expect(controller.snapshot().active).toBe(1)
    controller.fence()
    await rejects(Effect.runPromise(controller.run(() => Effect.void)), /intake is closed/)
    const drain = Effect.runPromise(controller.drain)
    const observed = drain.then(() => "done")
    expect(await Promise.race([observed, Bun.sleep(20).then(() => "pending")])).toBe("pending")
    await Effect.runPromise(Deferred.succeed(end, undefined))
    expect(await Promise.race([observed, Bun.sleep(20).then(() => "pending")])).toBe("pending")
    await Effect.runPromise(Deferred.succeed(finish, undefined))
    await Effect.runPromise(Fiber.join(fiber))
    await drain
    expect(await git(dir, "ls-files")).toBe("child.txt")
    expect(await readFile(path.join(dir, "tree.txt"), "utf8")).toMatch(/^[a-f0-9]{40}$/)
    expect(controller.snapshot()).toEqual({
      closing: true,
      active: 0,
      accepted: 4,
      settled: 4,
      failures: 0,
      cancelled: 0,
    })
  } finally {
    await Effect.runPromise(Deferred.succeed(end, undefined))
    await Effect.runPromise(Deferred.succeed(finish, undefined))
    await Effect.runPromise(controller.drain)
    await rm(dir, { recursive: true, force: true })
  }
})

test("expired and foreign parent/context cannot admit work", async () => {
  const controller = SessionRetirement.make()
  const other = SessionRetirement.make()
  const parent = await Effect.runPromise(controller.run((token) => Effect.succeed(token)))
  await rejects(Effect.runPromise(controller.run(() => Effect.void, parent)), /parent is unavailable/)
  await rejects(Effect.runPromise(other.run(() => Effect.void, parent)), /parent is unavailable/)
  await rejects(Effect.runPromise(controller.run(() => other.run(() => Effect.void))), /context is foreign/)
  expect(controller.snapshot().failures).toBe(1)
  expect(other.snapshot().accepted).toBe(0)
})

test("copied capabilities and an expired inherited context cannot authorize descendants", async () => {
  const controller = SessionRetirement.make()
  const end = Deferred.makeUnsafe<void>()
  const fiber = await Effect.runPromise(
    controller.run((token) =>
      Effect.gen(function* () {
        const copied = { ...token }
        const exit = yield* Effect.exit(controller.run(() => Effect.void, copied))
        expect(exit._tag).toBe("Failure")
        return yield* Effect.forkDetach(
          Deferred.await(end).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                expect(yield* controller.accepted).toBe(false)
                expect(yield* controller.current).toBeUndefined()
                expect((yield* Effect.exit(controller.run(() => Effect.void)))._tag).toBe("Failure")
              }),
            ),
          ),
          { startImmediately: true },
        )
      }),
    ),
  )
  controller.fence()
  await Effect.runPromise(Deferred.succeed(end, undefined))
  await Effect.runPromise(Fiber.join(fiber))
  await Effect.runPromise(controller.drain)
  expect(controller.snapshot().accepted).toBe(1)
  expect(controller.snapshot().failures).toBe(0)
})

test("actual Fail, Die and finalizer filesystem errors remain sticky after callers observe them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-session-failure-"))
  const controller = SessionRetirement.make()
  try {
    await Effect.runPromise(Effect.exit(controller.run(() => Effect.fail(new Error("typed failure")))))
    await Effect.runPromise(Effect.exit(controller.run(() => Effect.die(new Error("defect")))))
    await Effect.runPromise(
      Effect.exit(
        controller.run(() =>
          Effect.void.pipe(
            Effect.ensuring(Effect.promise(() => readFile(path.join(dir, "missing.txt"))).pipe(Effect.asVoid)),
          ),
        ),
      ),
    )
    expect(controller.snapshot().failures).toBe(3)
    for (const _ of [0, 1]) await rejects(Effect.runPromise(controller.drain), /retirement failed/)
    expect(controller.snapshot().active).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("unrequested interruption is retained; explicit cancellation joins actual finalizers", async () => {
  for (const requested of [false, true]) {
    const controller = SessionRetirement.make()
    const start = Deferred.makeUnsafe<void>()
    const finish = Deferred.makeUnsafe<void>()
    const end = Deferred.makeUnsafe<void>()
    const fiber = await Effect.runPromise(
      controller.fork(() =>
        Deferred.succeed(start, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(end, undefined).pipe(Effect.andThen(Deferred.await(finish)))),
        ),
      ),
    )
    await Effect.runPromise(Deferred.await(start))
    if (requested) await Effect.runPromise(controller.cancel(fiber))
    if (!requested)
      await Effect.runPromise(Effect.withFiber((caller) => Effect.sync(() => fiber.interruptUnsafe(caller.id))))
    await Effect.runPromise(Deferred.await(end))
    expect(controller.snapshot().active).toBe(1)
    await Effect.runPromise(Deferred.succeed(finish, undefined))
    await Effect.runPromise(Fiber.await(fiber))
    expect(controller.snapshot().cancelled).toBe(requested ? 1 : 0)
    expect(controller.snapshot().failures).toBe(requested ? 0 : 1)
    const exit = await Effect.runPromise(Effect.exit(controller.drain))
    expect(exit._tag).toBe(requested ? "Success" : "Failure")
  }
})

test("scoped child reserves before foreground returns and retains raw failure through the availability fallback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-session-scoped-"))
  const controller = SessionRetirement.make()
  const scope = await Effect.runPromise(Scope.make())
  const start = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  const fallback = Deferred.makeUnsafe<void>()
  try {
    const fiber = await Effect.runPromise(
      controller.run(() =>
        controller.scoped(
          Deferred.await(end).pipe(
            Effect.andThen(Effect.promise(() => readFile(path.join(dir, "missing.txt")))),
            Effect.ensuring(Effect.promise(() => writeFile(path.join(dir, "finalizer.txt"), "completed"))),
          ),
          scope,
          () =>
            Deferred.succeed(start, undefined).pipe(Effect.andThen(Deferred.await(fallback)), Effect.as("available")),
        ),
      ),
    )
    controller.fence()
    expect(controller.snapshot().active).toBe(1)
    await Effect.runPromise(Deferred.succeed(end, undefined))
    await Effect.runPromise(Deferred.await(start))
    expect(controller.snapshot().failures).toBe(1)
    expect(controller.snapshot().active).toBe(1)
    expect(await readFile(path.join(dir, "finalizer.txt"), "utf8")).toBe("completed")
    const drain = Effect.runPromise(Effect.exit(controller.drain))
    expect(await Promise.race([drain.then(() => "done"), Bun.sleep(20).then(() => "pending")])).toBe("pending")
    await Effect.runPromise(Deferred.succeed(fallback, undefined))
    expect(await Effect.runPromise(Fiber.join(fiber))).toBe("available")
    expect((await drain)._tag).toBe("Failure")
  } finally {
    await Effect.runPromise(Deferred.succeed(end, undefined))
    await Effect.runPromise(Deferred.succeed(fallback, undefined))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(dir, { recursive: true, force: true })
  }
})

test("selected interruption authorizes only the selected live fiber and never a failing finalizer or detached sibling", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-session-selected-"))
  try {
    for (const broken of [false, true]) {
      const controller = SessionRetirement.make()
      const start = Deferred.makeUnsafe<void>()
      const scope = await Effect.runPromise(Scope.make())
      const fiber = await Effect.runPromise(
        controller.scoped(
          controller.run(() =>
            Deferred.succeed(start, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.promise(async () => {
                  await (broken
                    ? readFile(path.join(dir, "missing.txt"))
                    : writeFile(path.join(dir, "cancelled.txt"), "actual cleanup"))
                }),
              ),
            ),
          ),
          scope,
          () => Effect.void,
        ),
      )
      await Effect.runPromise(Deferred.await(start))
      await Effect.runPromise(controller.interrupt(fiber))
      await Effect.runPromise(Scope.close(scope, Exit.void))
      expect(controller.snapshot().failures > 0).toBe(broken)
      expect(controller.snapshot().cancelled > 0).toBe(!broken)
      expect(controller.snapshot().active).toBe(0)
    }
    const controller = SessionRetirement.make()
    const start = Deferred.makeUnsafe<void>()
    const sibling = await Effect.runPromise(controller.fork(() => Effect.never))
    const selected = await Effect.runPromise(
      controller.fork(() => Deferred.succeed(start, undefined).pipe(Effect.andThen(Effect.never))),
    )
    await Effect.runPromise(Deferred.await(start))
    await Effect.runPromise(controller.interrupt(selected))
    await Effect.runPromise(Fiber.interrupt(sibling))
    expect(controller.snapshot().cancelled).toBe(1)
    expect(controller.snapshot().failures).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("actual Runner user, exact-execution and shell cancellation join real producer finalizers without retirement failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-session-runner-"))
  try {
    for (const mode of ["run", "exact", "shell"]) {
      const before = SessionRetirement.snapshot()
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            const runner = Runner.make(scope, { onInterrupt: Effect.succeed("cancelled") })
            const start = yield* Deferred.make<void>()
            const end = yield* Deferred.make<void>()
            const finish = yield* Deferred.make<void>()
            const body = SessionRetirement.entry(
              Deferred.succeed(start, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(end, undefined).pipe(
                    Effect.andThen(Deferred.await(finish)),
                    Effect.andThen(
                      Effect.promise(() => writeFile(path.join(dir, mode), "actual cancellation cleanup")),
                    ),
                  ),
                ),
              ),
            )
            const worker = yield* (mode === "shell" ? runner.startShell(body) : runner.ensureRunning(body)).pipe(
              Effect.forkChild,
            )
            yield* Deferred.await(start)
            const id = observe(runner).id
            if (mode === "exact" && !id) yield* Effect.die(new Error("Actual runner has no execution identity"))
            const stop = yield* (mode === "exact" && id ? runner.cancelRun(id) : runner.cancel).pipe(Effect.forkChild)
            yield* Deferred.await(end)
            expect(SessionRetirement.snapshot().active).toBe(1)
            yield* Deferred.succeed(finish, undefined)
            yield* Fiber.join(stop)
            expect(yield* Fiber.join(worker)).toBe("cancelled")
          }),
        ),
      )
      expect(await readFile(path.join(dir, mode), "utf8")).toBe("actual cancellation cleanup")
      expect(SessionRetirement.snapshot().failures).toBe(before.failures ?? 0)
      expect(SessionRetirement.snapshot().active).toBe(0)
      expect(SessionRetirement.snapshot().cancelled).toBe((before.cancelled ?? 0) + 1)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("actual committed Runner child retains its ticket when the first producer caller is interrupted before ready opens", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raya-session-ready-"))
  const scope = await Effect.runPromise(Scope.make())
  const selected = Deferred.makeUnsafe<{ run: Fiber.Fiber<string>; ready: { open: Effect.Effect<void> } }>()
  const start = Deferred.makeUnsafe<void>()
  const end = Deferred.makeUnsafe<void>()
  const before = SessionRetirement.snapshot()
  try {
    const caller = Effect.runFork(
      SessionRetirement.run(() =>
        Effect.gen(function* () {
          const committed = yield* KiloRunner.start({
            scope,
            work: SessionRetirement.entry(
              Effect.gen(function* () {
                expect(yield* SessionRetirement.accepted).toBe(true)
                yield* Deferred.succeed(start, undefined)
                yield* Deferred.await(end)
                yield* Effect.promise(() => writeFile(path.join(dir, "child.txt"), "accepted committed child"))
                return "done"
              }),
            ),
            finish: () => Effect.promise(() => writeFile(path.join(dir, "finalizer.txt"), "actual runner finalizer")),
            handle: (fiber) => fiber,
          })
          yield* Deferred.succeed(selected, committed)
          yield* Effect.never
        }),
      ),
    )
    const committed = await Effect.runPromise(Deferred.await(selected))
    expect(SessionRetirement.snapshot().active).toBe(2)
    await Effect.runPromise(SessionRetirement.interrupt(caller))
    expect(SessionRetirement.snapshot().active).toBe(1)
    expect(committed.run.pollUnsafe()).toBeUndefined()
    await Effect.runPromise(committed.ready.open)
    await Effect.runPromise(Deferred.await(start))
    await Effect.runPromise(Deferred.succeed(end, undefined))
    expect(await Effect.runPromise(Fiber.join(committed.run))).toBe("done")
    expect(await readFile(path.join(dir, "finalizer.txt"), "utf8")).toBe("actual runner finalizer")
    expect(SessionRetirement.snapshot().active).toBe(0)
    expect(SessionRetirement.snapshot().failures).toBe(before.failures)
  } finally {
    await Effect.runPromise(Deferred.succeed(end, undefined))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(dir, { recursive: true, force: true })
  }
})
