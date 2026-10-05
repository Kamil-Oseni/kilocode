import { expect, test } from "bun:test"
import { Effect } from "effect"
import { run, warm } from "../../src/kilocode/cli/bootstrap-mode"

test("metadata bootstrap mode is retained through actual Effect and restores outside it", async () => {
  expect(warm()).toBe(true)
  const held = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const metadata = run(false, () =>
    Effect.runPromise(
      Effect.promise(async () => {
        expect(warm()).toBe(false)
        held.resolve()
        await release.promise
        expect(warm()).toBe(false)
      }),
    ),
  )
  await held.promise
  await run(undefined, async () => {
    await Promise.resolve()
    expect(warm()).toBe(true)
  })
  expect(warm()).toBe(true)
  release.resolve()
  await metadata
  expect(warm()).toBe(true)
  await expect(
    run(false, async () => {
      throw new Error("Original bootstrap failed")
    }),
  ).rejects.toThrow("Original bootstrap failed")
  expect(warm()).toBe(true)
})
