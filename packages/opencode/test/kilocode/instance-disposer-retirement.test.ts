import { expect, test } from "bun:test"
import { Effect, Exit, Scope, ScopedCache } from "effect"
import { disposeInstance, registerDisposer } from "../../src/effect/instance-registry"

test("selected retired callback cannot invalidate its released actual scoped cache", async () => {
  const scope = await Effect.runPromise(Scope.make())
  let released = 0
  let called = 0
  const cache = await Effect.runPromise(
    ScopedCache.make({
      capacity: 1,
      lookup: () =>
        Effect.acquireRelease(Effect.succeed("original"), () =>
          Effect.sync(() => {
            released++
          }),
        ),
    }).pipe(Scope.provide(scope)),
  )
  expect(await Effect.runPromise(ScopedCache.get(cache, "synthetic"))).toBe("original")
  const off = registerDisposer(() => {
    called++
    return Effect.runPromise(ScopedCache.invalidate(cache, "synthetic"))
  })
  const pending = disposeInstance("synthetic")
  off()
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await pending
  expect(called).toBe(0)
  expect(released).toBe(1)
  expect(Exit.isFailure(await Effect.runPromise(Effect.exit(ScopedCache.invalidate(cache, "synthetic"))))).toBe(true)
})

test("already started original cleanup remains joined after unregister and retains its error", async () => {
  const start = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const marker = new Error("synthetic original cleanup failure")
  const off = registerDisposer(() => {
    start.resolve()
    return gate.promise
  })
  let joined = false
  const pending = disposeInstance("synthetic").finally(() => {
    joined = true
  })
  const refused = pending.then(
    () => undefined,
    (error) => error,
  )
  await start.promise
  off()
  await Promise.resolve()
  expect(joined).toBe(false)
  gate.reject(marker)
  expect(await refused).toBe(marker)
  expect(joined).toBe(true)
})

test("active scoped finalizer and independent cleanup errors remain aggregated", async () => {
  const scope = await Effect.runPromise(Scope.make())
  const marker = new Error("synthetic cache finalizer failure")
  const other = new Error("synthetic independent cleanup failure")
  const cache = await Effect.runPromise(
    ScopedCache.make({
      capacity: 1,
      lookup: () => Effect.acquireRelease(Effect.succeed("original"), () => Effect.die(marker)),
    }).pipe(Scope.provide(scope)),
  )
  await Effect.runPromise(ScopedCache.get(cache, "synthetic"))
  const off = registerDisposer(() => Effect.runPromise(ScopedCache.invalidate(cache, "synthetic")))
  const second = registerDisposer(() => Promise.reject(other))
  try {
    const error = await disposeInstance("synthetic").then(
      () => undefined,
      (error) => error,
    )
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw new Error("Expected original aggregate")
    expect(error.errors).toContain(marker)
    expect(error.errors).toContain(other)
  } finally {
    off()
    second()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
