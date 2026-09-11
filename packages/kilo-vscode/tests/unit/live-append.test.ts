import { expect, test } from "bun:test"
import { parts, speak } from "../../src/speech/live-append"

test("Live append splits at 500 Unicode scalars including non-ASCII and refuses a fifth chunk", () => {
  expect(parts("")).toEqual([])
  expect(parts("a".repeat(500))).toEqual(["a".repeat(500)])
  expect(parts("a".repeat(501))).toEqual(["a".repeat(500), "a"])
  expect(parts("字".repeat(500))).toEqual(["字".repeat(500)])
  expect(parts("字".repeat(501))).toEqual(["字".repeat(500), "字"])
  const long = "字".repeat(500 * 4 + 1)
  const spoken = speak(long)
  expect(spoken).toHaveLength(4)
  expect(spoken.slice(0, 3).every((item) => [...item].length === 500)).toBe(true)
  expect(spoken.at(-1)).toContain("task conversation")
  expect(spoken.every((item) => [...item].length <= 500)).toBe(true)
})
