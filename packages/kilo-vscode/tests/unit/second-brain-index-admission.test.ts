import { expect, test } from "bun:test"
import { IndexUnavailable, resources } from "../../src/second-brain/index-admission"

const gib = 1073741824
const sample = (free: number, available: number) =>
  JSON.stringify({
    format: "raya.memory.index.resources",
    version: 1,
    physical: 32 * gib,
    free,
    commit: 64 * gib,
    available,
  })

test("cold indexing preserves the full 4 GiB model plus 6 GiB OS reserve and 5 GiB commit", () => {
  expect(resources(sample(10 * gib, 5 * gib))).toMatchObject({ free: 10 * gib, available: 5 * gib })
  expect(() => resources(sample(10 * gib - 1, 5 * gib))).toThrow("10 GiB free RAM")
  expect(() => resources(sample(10 * gib, 5 * gib - 1))).toThrow("5 GiB free commit")
  expect(() => resources(sample(Math.floor(8.2 * gib), 30 * gib))).toThrow("Available: 8.20 GiB RAM")
  expect(() => resources(sample(8 * gib, 30 * gib))).toThrow(IndexUnavailable)
  expect(Object.isFrozen(resources(sample(12 * gib, 8 * gib)))).toBe(true)
})

test("native admission refuses absent, malformed, extended and impossible samples", () => {
  for (const raw of [
    "",
    "null",
    "{}",
    "[1,2]",
    sample(33 * gib, 5 * gib),
    sample(10 * gib, 65 * gib),
    sample(10 * gib + 0.5, 5 * gib),
    sample(-1, 5 * gib),
    sample(Number.MAX_SAFE_INTEGER + 1, 5 * gib),
    sample(10 * gib, 5 * gib).replace('"version":1', '"version":2'),
    sample(10 * gib, 5 * gib).replace('"version":1', '"extra":true,"version":1'),
    " ".repeat(1025),
  ]) {
    expect(() => resources(raw)).toThrow()
    const error = (() => {
      try {
        resources(raw)
      } catch (err) {
        return err
      }
    })()
    expect(error).not.toBeInstanceOf(IndexUnavailable)
  }
})
