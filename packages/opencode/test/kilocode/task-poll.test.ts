import { expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { poll } from "@/kilocode/task/poll"

test("polling recovers from failures and defects, then stops with its scope", async () => {
  const attempts: number[] = []
  const errors: string[] = []
  const finalized: number[] = []
  const entered = await Effect.runPromise(Deferred.make<void>())
  const tick = Effect.suspend(() => {
    attempts.push(attempts.length + 1)
    if (attempts.length === 1) return Effect.fail(new Error("read failed"))
    if (attempts.length === 2) return Effect.die(new Error("unexpected failure"))
    return Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => finalized.push(attempts.length))),
    )
  })
  const fiber = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* poll(tick, (cause) => errors.push(String(Cause.squash(cause))), "1 millis").pipe(
          Effect.forkScoped,
        )
        yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
        return fiber
      }),
    ),
  )
  expect(attempts).toEqual([1, 2, 3])
  expect(errors).toEqual(["Error: read failed", "Error: unexpected failure"])
  expect(finalized).toEqual([3])
  const result = await Effect.runPromise(Fiber.await(fiber))
  if (Exit.isSuccess(result)) throw new Error("Expected stopped polling fiber")
  expect(Cause.hasInterrupts(result.cause)).toBe(true)
})

test("explicit interruption is not reported or retried as a poll failure", async () => {
  const errors: unknown[] = []
  const result = await Effect.runPromiseExit(poll(Effect.interrupt, (cause) => errors.push(cause), "1 millis"))
  if (Exit.isSuccess(result)) throw new Error("Expected interruption")
  expect(Cause.hasInterrupts(result.cause)).toBe(true)
  expect(errors).toEqual([])
})
