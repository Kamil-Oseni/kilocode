import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { admission } from "@/kilocode/task/admission"

for (const defect of [false, true]) {
  test(`stop joins exact original finalizer${defect ? " defect" : ""}`, async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const port = admission()
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const finalizing = yield* Deferred.make<void>()
        const original = yield* port.fork(
          Effect.succeed(
            port.observe(
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Deferred.succeed(finalizing, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(defect ? Effect.die(new Error("original defect")) : Effect.void),
                  ),
                ),
              ),
            ),
          ),
          () => "refused",
        )
        yield* Deferred.await(entered)
        const stop = yield* port.stop.pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(finalizing)
        expect(port.snapshot().active).toBe(1)
        expect(stop.pollUnsafe()).toBeUndefined()
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isFailure(yield* Fiber.await(stop))).toBe(defect)
        expect(Exit.isFailure(yield* Fiber.await(original))).toBe(true)
        expect(port.snapshot().active).toBe(0)
        expect(port.snapshot().failures > 0).toBe(defect)
      }),
    )
  })
}

test("foreign interruption remains sticky after another admission stops", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const port = admission()
      const foreign = admission()
      const entered = yield* Deferred.make<void>()
      const original = yield* port.fork(
        Effect.succeed(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
        () => "refused",
      )
      yield* Deferred.await(entered)
      yield* foreign.stop
      expect(original.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(original)
      expect(Exit.isFailure(yield* port.stop.pipe(Effect.exit))).toBe(true)
      expect(port.snapshot().failures).toBe(1)
    }),
  )
})

test("reserved preparation cannot launch late work", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const port = admission()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const state = { calls: 0 }
      const preparing = yield* port
        .fork(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(
              Effect.sync(() => {
                state.calls++
              }),
            ),
          ),
          () => "refused",
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const stop = yield* port.stop.pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isFailure(yield* Fiber.await(preparing))).toBe(true)
      yield* Fiber.join(stop)
      expect(state.calls).toBe(0)
      expect(port.snapshot()).toMatchObject({ active: 0, failures: 0, closed: true })
    }),
  )
})

test("self stop refuses without authorizing its own failure", async () => {
  const port = admission()
  expect(Exit.isFailure(await Effect.runPromiseExit(port.track(port.stop, () => "refused")))).toBe(true)
  expect(port.snapshot().failures).toBe(1)
})

test("mixed foreign interruption remains sticky while every original joins", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const port = admission()
      const entered = yield* Deferred.make<void>()
      const original = yield* port.fork(
        Effect.succeed(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Effect.failCause(Cause.interrupt(987654321))),
          ),
        ),
        () => "refused",
      )
      yield* Deferred.await(entered)
      expect(Exit.isFailure(yield* port.stop.pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(original))).toBe(true)
      expect(port.snapshot().active).toBe(0)
      expect(port.snapshot().failures).toBeGreaterThan(0)
    }),
  )
})

test("private original-ticket context cannot authorize another admission observer", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const port = admission()
      const foreign = admission()
      const entered = yield* Deferred.make<void>()
      const original = yield* port.fork(
        Effect.succeed(foreign.observe(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))),
        () => "refused",
      )
      yield* Deferred.await(entered)
      yield* port.stop
      expect(Exit.isFailure(yield* Fiber.await(original))).toBe(true)
      expect(port.snapshot().failures).toBe(0)
      expect(Exit.isFailure(yield* foreign.stop.pipe(Effect.exit))).toBe(true)
      expect(foreign.snapshot().failures).toBe(1)
    }),
  )
})

test("a live original descendant refuses to join its own ancestor stop", async () => {
  const port = admission()
  const result = await Effect.runPromiseExit(
    port.track(
      Effect.gen(function* () {
        const child = yield* port.stop.pipe(Effect.forkChild({ startImmediately: true }))
        const exit = yield* Fiber.await(child)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
      }),
      () => "refused",
    ),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(port.snapshot()).toMatchObject({ closed: false, active: 0, failures: 1 })
})

test("nested foreign context cannot borrow a local ticket on the same original fiber", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const port = admission()
      const foreign = admission()
      const entered = yield* Deferred.make<void>()
      const original = yield* port.fork(
        Effect.succeed(
          foreign.track(
            port.observe(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))),
            () => "refused",
          ),
        ),
        () => "refused",
      )
      yield* Deferred.await(entered)
      expect(Exit.isFailure(yield* port.stop.pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(original))).toBe(true)
      expect(port.snapshot()).toMatchObject({ active: 0, failures: 1 })
      expect(Exit.isFailure(yield* foreign.stop.pipe(Effect.exit))).toBe(true)
      expect(foreign.snapshot()).toMatchObject({ active: 0, failures: 1 })
    }),
  )
})
