import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { lifecycle } from "../../src/kilocode/cli/lifecycle"
import { createShutdown } from "../../src/kilocode/cli/shutdown"

test("CLI cleanup joins held real scope finalizers and keeps terminal initialization fenced", async () => {
  const scope = Scope.makeUnsafe()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const events: string[] = []
  await Effect.runPromise(
    Scope.addFinalizer(
      scope,
      Effect.promise(async () => {
        started.resolve()
        await release.promise
        events.push("scope")
      }),
    ),
  )
  const cleanup = lifecycle([
    () => {
      events.push("export")
    },
    () => Effect.runPromise(Scope.close(scope, Exit.void)),
    () => {
      events.push("instances")
    },
  ])
  cleanup.check()
  expect(cleanup.started).toBe(false)
  const first = cleanup.run()
  expect(cleanup.started).toBe(true)
  expect(cleanup.run()).toBe(first)
  expect(() => cleanup.check()).toThrow("CLI lifecycle is closing or closed")
  await started.promise
  expect(events).toEqual(["export"])
  release.resolve()
  await first
  expect(events).toEqual(["export", "scope", "instances"])
  expect(cleanup.run()).toBe(first)
  expect(() => cleanup.check()).toThrow("CLI lifecycle is closing or closed")
})

test("failed export and real registered finalizers still reach instance cleanup and retain all causes", async () => {
  const registry = createShutdown()
  const scope = Scope.makeUnsafe()
  const instances = Scope.makeUnsafe()
  const events: string[] = []
  const failure = new Error("export cleanup failed")
  await Effect.runPromise(Scope.addFinalizer(scope, Effect.die(new Error("registered scope failed"))))
  await Effect.runPromise(
    Scope.addFinalizer(
      instances,
      Effect.sync(() => {
        events.push("instances")
      }),
    ),
  )
  registry.register(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const cleanup = lifecycle([
    () => {
      events.push("export")
      throw failure
    },
    () => {
      events.push("telemetry")
    },
    () => {
      events.push("callbacks")
      return registry.run()
    },
    () => Effect.runPromise(Scope.close(instances, Exit.void)),
  ])
  const first = cleanup.run()
  const results = await Promise.allSettled([first])
  expect(events).toEqual(["export", "telemetry", "callbacks", "instances"])
  expect(results[0].status).toBe("rejected")
  if (results[0].status === "rejected") {
    const error: unknown = results[0].reason
    expect(error).toBeInstanceOf(AggregateError)
    if (error instanceof AggregateError) {
      expect(error.errors).toHaveLength(2)
      expect(error.errors[0]).toBe(failure)
      expect(String(error.errors[1])).toContain("registered scope failed")
    }
  }
  expect(cleanup.run()).toBe(first)
  expect((await Promise.allSettled([cleanup.run()]))[0]).toEqual(results[0])
  expect(() => cleanup.check()).toThrow("CLI lifecycle is closing or closed")
})
