import { expect, test } from "bun:test"
import { budget } from "../../src/kilocode/second-brain/capture-budget"

test("capture respects the installed pinned model's 1024 output limit", () => {
  expect(budget({ context: 32768, output: 1024 })).toEqual({ input: 8000, output: 1024 })
})

test("capture retains its own caps and leaves the transport context reserve", () => {
  expect(budget({ context: 32768, output: 8192 })).toEqual({ input: 8000, output: 1800 })
  expect(budget({ context: 8192, output: 4096 })).toEqual({ input: 6360, output: 1800 })
  expect(budget({ context: 512, output: 256 })).toEqual({ input: 224, output: 256 })
  expect(budget({ context: 34, output: 2 })).toEqual({ input: 1, output: 1 })
})

test("invalid configured capture limits fail without increasing the model budget", () => {
  for (const limit of [
    { context: 33, output: 1 },
    { context: 32768, output: 0 },
    { context: Infinity, output: 1024 },
    { context: 32768, output: NaN },
    { context: 8192.5, output: 1024 },
    { context: 8192, output: 1024.5 },
  ])
    expect(() => budget(limit)).toThrow("configured model limits")
})
