import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ContextItem } from "@/kilocode/voice/protocol"

test("voice context keeps legacy supersedes and additive bounded replacement identities", () => {
  const item = { id: "fact", kind: "fact", text: "Context", created: new Date(0).toISOString() }
  const decode = Schema.decodeUnknownSync(ContextItem)
  expect(decode({ ...item, supersedes: "legacy" }).supersedes).toBe("legacy")
  expect(decode({ ...item, replaces: ["fact_1", "fact-2"] }).replaces).toEqual(["fact_1", "fact-2"])
  expect(decode(item).replaces).toBeUndefined()
  expect(decode({ ...item, replaces: Array.from({ length: 8 }, (_, index) => `fact_${index}`) }).replaces).toHaveLength(
    8,
  )
  for (const replaces of [[""], ["bad id"], ["bad\n"], ["x".repeat(129)], Array.from({ length: 9 }, () => "fact")])
    expect(() => decode({ ...item, replaces })).toThrow()
})
