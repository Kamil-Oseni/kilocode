import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { admission } from "../../src/kilocode/task/admission"

test("scoped prompt admission reserves before model body and joins its finalizer", async () => {
  const gate = admission()
  const scope = await Effect.runPromise(Scope.make())
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const finalizing = await Effect.runPromise(Deferred.make<void>())
  const finalized = await Effect.runPromise(Deferred.make<void>())
  const fiber = await Effect.runPromise(
    gate.scoped(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.ensuring(Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(finalized)))),
      ),
      scope,
      () => new Error("closed"),
    ),
  )
  await Effect.runPromise(Deferred.await(entered))
  const closed = gate.quiesce()
  expect(gate.snapshot().active).toBe(1)
  expect(
    Exit.isFailure(await Effect.runPromiseExit(gate.scoped(Effect.die("late body ran"), scope, () => "closed"))),
  ).toBe(true)
  await Effect.runPromise(Deferred.succeed(release, undefined))
  await Effect.runPromise(Deferred.await(finalizing))
  expect(gate.snapshot().active).toBe(1)
  await Effect.runPromise(Deferred.succeed(finalized, undefined))
  await closed
  await Effect.runPromise(Fiber.join(fiber))
  expect(gate.snapshot()).toMatchObject({ closed: true, active: 0, failures: 0 })
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

test("already closed real scope cannot leak an async prompt ticket", async () => {
  const gate = admission()
  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(Scope.close(scope, Exit.void))
  const state = { ran: false }
  const fiber = await Effect.runPromise(
    gate.scoped(
      Effect.sync(() => {
        state.ran = true
      }),
      scope,
      () => "closed",
    ),
  )
  expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
  expect(state.ran).toBe(false)
  await expect(gate.quiesce()).rejects.toBeInstanceOf(AggregateError)
  expect(gate.snapshot().active).toBe(0)
})

test("prompt raw failure survives diagnostic conversion to success", async () => {
  const gate = admission()
  const scope = await Effect.runPromise(Scope.make())
  const body = gate.observe(Effect.fail(new Error("transport failed"))).pipe(Effect.catchCause(() => Effect.void))
  const fiber = await Effect.runPromise(gate.scoped(body, scope, () => "closed"))
  await Effect.runPromise(Fiber.join(fiber))
  await expect(gate.quiesce()).rejects.toBeInstanceOf(AggregateError)
  expect(gate.snapshot().active).toBe(0)
  expect(gate.snapshot().failures).toBe(1)
  await Effect.runPromise(Scope.close(scope, Exit.void))
})
