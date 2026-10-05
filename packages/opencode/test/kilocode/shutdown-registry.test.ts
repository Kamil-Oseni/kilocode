import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { createShutdown } from "../../src/kilocode/cli/shutdown"

test("process shutdown joins concurrent callers until actual scope finalization completes", async () => {
  const registry = createShutdown()
  const scope = Scope.makeUnsafe()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  await Effect.runPromise(
    Scope.addFinalizer(
      scope,
      Effect.promise(async () => {
        events.push("started")
        started.resolve()
        await release.promise
        events.push("closed")
      }),
    ),
  )
  registry.register(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const removed = registry.register(() => {
    events.push("removed")
  })
  removed()
  const first = registry.run()
  expect(registry.run()).toBe(first)
  expect(() => registry.register(() => undefined)).toThrow("registration is closed")
  await started.promise
  expect(events).toEqual(["started"])
  expect(registry.run()).toBe(first)
  release.resolve()
  await first
  expect(registry.run()).toBe(first)
  expect(events).toEqual(["started", "closed"])
})

test("failed finalizers and synchronous callbacks do not skip cleanup or erase refusal", async () => {
  const registry = createShutdown()
  const scope = Scope.makeUnsafe()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  const failure = new Error("synchronous cleanup failed")
  registry.register(() => {
    events.push("synchronous")
    throw failure
  })
  await Effect.runPromise(Scope.addFinalizer(scope, Effect.die(new Error("scope cleanup failed"))))
  registry.register(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  registry.register(async () => {
    events.push("held")
    started.resolve()
    await release.promise
    events.push("closed")
  })
  const first = registry.run()
  const observed = Promise.allSettled([first])
  await started.promise
  expect(events).toEqual(["synchronous", "held"])
  expect(registry.run()).toBe(first)
  expect(() => registry.register(() => undefined)).toThrow("registration is closed")
  release.resolve()
  const results = await observed
  expect(results[0].status).toBe("rejected")
  if (results[0].status === "rejected") {
    expect(results[0].reason).toBeInstanceOf(AggregateError)
    const error: unknown = results[0].reason
    if (error instanceof AggregateError) {
      expect(error.errors).toHaveLength(2)
      expect(error.errors[0]).toBe(failure)
      expect(String(error.errors[1])).toContain("scope cleanup failed")
    }
  }
  expect(events).toEqual(["synchronous", "held", "closed"])
  expect(registry.run()).toBe(first)
  expect((await Promise.allSettled([registry.run()]))[0]).toEqual(results[0])
})
