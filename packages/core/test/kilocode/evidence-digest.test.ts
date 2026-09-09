import { expect, test } from "bun:test"
import { digest } from "../../src/kilocode/evidence-digest"

test("receipt digests tolerate object ordering but preserve tool, content and array order", () => {
  const first = { tool: "read", state: { input: { b: 2, a: 1 }, output: "text", metadata: { items: [1, 2] } } }
  expect(digest(first)).toBe(
    digest({ tool: "read", state: { metadata: { items: [1, 2] }, output: "text", input: { a: 1, b: 2 } } }),
  )
  expect(digest(first)).not.toBe(digest({ ...first, tool: "write" }))
  expect(digest(first)).not.toBe(digest({ ...first, state: { ...first.state, output: "changed" } }))
  expect(digest(first)).not.toBe(digest({ ...first, state: { ...first.state, metadata: { items: [2, 1] } } }))
})
