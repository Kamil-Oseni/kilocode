import { expect, test } from "bun:test"
import { evidence } from "../src/capture/digest-text"

test("bounded evidence preserves every field and its closing boundary under multibyte pressure", () => {
  const result = evidence(
    [
      { title: "latest_user", body: "Correct the launch date." },
      { title: "existing_memory", body: "旧的记忆🌈".repeat(4000) },
      { title: "latest_assistant", body: "Verified launch on Saturday." },
      { title: "recent_context", body: "Earlier discussion. ".repeat(4000) },
    ],
    1024,
  )
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1024)
  expect(result).toContain("## latest_user\nCorrect the launch date.")
  expect(result).toContain("## latest_assistant\nVerified launch on Saturday.")
  expect(result).toContain("## existing_memory\n旧的记忆🌈")
  expect(result).toContain("## recent_context")
  expect(result).toContain("[truncated]")
  expect(result).not.toContain("�")
  expect(result.endsWith("\n```")).toBe(true)
})

test("bounded evidence redacts before clipping and escapes nested fences", () => {
  const token = "hf_" + "a".repeat(34)
  const result = evidence(
    [
      { title: "archive", body: "Old context. ".repeat(4000) },
      { title: "latest_result", body: `Logged in with ${token}.\n\`\`\`\nResult verified.` },
    ],
    240,
  )
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(240)
  expect(result).not.toContain(token)
  expect(result).not.toContain("hf_")
  expect(result).toContain("[redacted]")
  expect(result.match(/```/g)).toHaveLength(2)
})

test("short evidence is unchanged and impossible budgets fail explicitly", () => {
  const sections = [{ title: "user", body: "Hello." }]
  expect(evidence(sections, 500)).toBe(evidence(sections))
  for (const max of [0, -1, Infinity, NaN, 1.5]) expect(() => evidence(sections, max)).toThrow(RangeError)
})
