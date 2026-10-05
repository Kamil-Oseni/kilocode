import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { admission } from "../../src/kilocode/task/admission"
import { EffectBridge } from "../../src/effect/bridge"

test("quiesce fences immediately and joins detached preparation, body and finalizer", async () => {
  const gate = admission()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const finalizing = Promise.withResolvers<void>()
  const finalized = Promise.withResolvers<void>()
  const refuse = () => new Error("closed")
  const prepared = Effect.promise(async () => {
    entered.resolve()
    await release.promise
    return Effect.succeed("accepted").pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          finalizing.resolve()
          await finalized.promise
        }),
      ),
    )
  })
  const dispatched = Effect.runPromise(gate.fork(prepared, refuse))
  await entered.promise
  const closed = gate.quiesce()
  expect(gate.quiesce()).toBe(closed)
  expect(gate.snapshot().active).toBe(1)
  expect(Exit.isFailure(await Effect.runPromiseExit(gate.track(Effect.die("late work ran"), refuse)))).toBe(true)
  release.resolve()
  await finalizing.promise
  expect(gate.snapshot().active).toBe(1)
  finalized.resolve()
  await closed
  expect(await Effect.runPromise(Fiber.join(await dispatched))).toBe("accepted")
  expect(gate.snapshot()).toEqual({
    closed: true,
    active: 0,
    failures: 0,
    processLocal: true,
    portableCaptureAuthorized: false,
  })
})

test("ordinary validation failure does not become uncertain dispatch or poison shutdown", async () => {
  const gate = admission()
  const exit = await Effect.runPromiseExit(gate.track(Effect.fail("invalid input"), () => "closed"))
  expect(Exit.isFailure(exit)).toBe(true)
  await gate.quiesce()
  expect(gate.snapshot().failures).toBe(0)
})

test("callback reserves before bridge scheduling and joins its actual body", async () => {
  const gate = admission()
  const scope = Scope.makeUnsafe()
  const bridge = Effect.runSync(EffectBridge.make())
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  expect(
    gate.dispatch(
      Effect.promise(async () => {
        entered.resolve()
        await release.promise
      }),
      scope,
      bridge.fork,
    ),
  ).toBe(true)
  const closed = gate.quiesce()
  expect(gate.snapshot().active).toBe(1)
  expect(gate.dispatch(Effect.die("late callback"), scope, bridge.fork)).toBe(false)
  await entered.promise
  expect(gate.snapshot().active).toBe(1)
  release.resolve()
  await closed
  expect(gate.snapshot().active).toBe(0)
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

test("callback canceled before body execution cannot leak its reserved ticket", async () => {
  const gate = admission()
  const scope = Scope.makeUnsafe()
  const bridge = Effect.runSync(EffectBridge.make())
  await Effect.runPromise(Scope.close(scope, Exit.void))
  const state = { ran: false }
  expect(
    gate.dispatch(
      Effect.sync(() => {
        state.ran = true
      }),
      scope,
      bridge.fork,
    ),
  ).toBe(true)
  await expect(gate.quiesce()).rejects.toThrow("Scheduler work could not be confirmed settled")
  expect(state.ran).toBe(false)
  expect(gate.snapshot().active).toBe(0)
})

test("actual failed dispatch is retained before a logging catch converts it to success", async () => {
  const gate = admission()
  const body = gate.observe(Effect.fail("unknown model outcome")).pipe(Effect.catch(() => Effect.void))
  const fiber = await Effect.runPromise(gate.fork(Effect.succeed(body), () => "closed"))
  await Effect.runPromise(Fiber.join(fiber))
  const closed = gate.quiesce()
  await expect(closed).rejects.toThrow("Scheduler work could not be confirmed settled")
  expect(gate.quiesce()).toBe(closed)
  expect(gate.snapshot().active).toBe(0)
  expect(gate.snapshot().failures).toBe(1)
})

test("an explicitly classified guard refusal does not mask a later unexpected dispatch failure", async () => {
  const gate = admission()
  const known = (err: string) => err === "guard"
  await Effect.runPromise(gate.observe(Effect.fail("guard"), known).pipe(Effect.catch(() => Effect.void)))
  expect(gate.snapshot().failures).toBe(0)
  await Effect.runPromise(gate.observe(Effect.fail("unknown delivery"), known).pipe(Effect.catch(() => Effect.void)))
  expect(gate.snapshot().failures).toBe(1)
  await expect(gate.quiesce()).rejects.toThrow("Scheduler work could not be confirmed settled")
})

test("accepted bodies cannot use inherited context to admit new work after cutoff", async () => {
  const gate = admission()
  const ready = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const fiber = Effect.runFork(
    gate.track(
      Deferred.succeed(ready, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(gate.track(Effect.succeed("late"), () => "closed")),
      ),
      () => "closed",
    ),
  )
  await Effect.runPromise(Deferred.await(ready))
  const closed = gate.quiesce()
  await Effect.runPromise(Deferred.succeed(release, undefined))
  expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
  await closed
  expect(gate.snapshot().active).toBe(0)
})
