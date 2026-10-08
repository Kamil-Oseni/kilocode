import { expect, test } from "bun:test"
import { unchanged } from "../../src/second-brain/review"

test("native Memory review preserves mixed Windows note contents across editor line endings", () => {
  const text = "Policy SHA-256: " + "a".repeat(64) + "\n--- INDEX.md ---\nWindows note\r\nCafé 日本 😀\r\n--- project.md ---\nLocal project\n"
  const unix = text.replace(/\r\n/g, "\n")
  const windows = unix.replace(/\n/g, "\r\n")
  expect(unchanged(text, unix)).toBe(true)
  expect(unchanged(text, windows)).toBe(true)
  for (const changed of [
    unix.replace("a".repeat(64), "b".repeat(64)),
    unix.replace("Windows note", "Another note"),
    unix.replace("日本", "日本 "),
    unix.slice(0, -1),
    unix + "Added source\n",
  ]) expect(unchanged(text, changed)).toBe(false)
})
