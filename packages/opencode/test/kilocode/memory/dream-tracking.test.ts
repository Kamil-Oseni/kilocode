import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { inspect, track, type Records } from "../../../src/kilocode/memory/dream-tracking"

async function denied(effect: Effect.Effect<unknown, unknown>, reason: string) {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(reason)
}

test("original inspection stays pending through interruption until its actual finalizer joins", async () => {
  const records: Records = new Map()
  const input = { id: crypto.randomUUID(), owner: crypto.randomUUID(), model: "fixture/model" }
  const entered = Promise.withResolvers<void>()
  const cancelling = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const fiber = Effect.runFork(
    track(
      records,
      input,
      Effect.callback<void>(() => {
        entered.resolve()
        return Effect.promise(async () => {
          cancelling.resolve()
          await release.promise
        })
      }),
    ),
  )
  try {
    await entered.promise
    expect(await Effect.runPromise(inspect(records, input))).toMatchObject({
      settlement: "pending",
      outcome: "running",
    })
    await denied(track(records, { ...input, id: crypto.randomUUID() }, Effect.void), "not settled")
    const joined = Effect.runPromise(Fiber.interrupt(fiber))
    await cancelling.promise
    expect(await Effect.runPromise(inspect(records, input))).toMatchObject({
      settlement: "pending",
      outcome: "running",
    })
    release.resolve()
    await joined
    expect(await Effect.runPromise(inspect(records, input))).toMatchObject({
      settlement: "sdk",
      outcome: "interrupted",
    })
    await denied(track(records, input, Effect.void), "do not replay")
  } finally {
    release.resolve()
    await Effect.runPromise(Fiber.interrupt(fiber))
  }
})

test("inspection retains at most 32 metadata receipts and requires the original owner", async () => {
  const records: Records = new Map()
  const input = { id: crypto.randomUUID(), owner: crypto.randomUUID(), model: "fixture/model" }
  await Effect.runPromise(track(records, input, Effect.void))
  const result = await Effect.runPromise(inspect(records, input))
  result.configuredModel = "changed/model"
  expect((await Effect.runPromise(inspect(records, input))).configuredModel).toBe(input.model)
  await denied(inspect(records, { ...input, owner: crypto.randomUUID() }), "unavailable")
  for (let index = 0; index < 32; index++)
    await Effect.runPromise(track(records, { ...input, id: crypto.randomUUID() }, Effect.void))
  expect(records.size).toBe(32)
  await denied(inspect(records, input), "unavailable")
  expect([...records.values()].every((row) => row.settlement === "sdk" && row.outcome === "completed")).toBe(true)
})
