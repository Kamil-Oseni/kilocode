import { expect, test } from "bun:test"
import { UpdateRun } from "../../src/services/update-run"

test("overlapping checks share a single flow and a later explicit retry can run", async () => {
  const runner = new UpdateRun()
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const first = runner.run(async () => {
    calls++
    await gate.promise
  })
  const second = runner.run(async () => {
    calls++
  })
  expect(second).toBe(first)
  await Promise.resolve()
  expect(calls).toBe(1)
  gate.resolve()
  await first
  await runner.run(async () => {
    calls++
  })
  expect(calls).toBe(2)
})

test("disposal invalidates an awaiting update choice and prevents future dispatch", async () => {
  const runner = new UpdateRun()
  const choice = Promise.withResolvers<void>()
  let installed = false
  const flow = runner.run(async (active) => {
    await choice.promise
    if (active()) installed = true
  })
  await Promise.resolve()
  runner.dispose()
  choice.resolve()
  await flow
  await runner.run(async () => {
    installed = true
  })
  expect(installed).toBe(false)
})

test("a rejected flow releases ownership for a corrected retry", async () => {
  const runner = new UpdateRun()
  await expect(
    runner.run(async () => {
      throw new Error("failed")
    }),
  ).rejects.toThrow("failed")
  let completed = false
  await runner.run(async () => {
    completed = true
  })
  expect(completed).toBe(true)
})
