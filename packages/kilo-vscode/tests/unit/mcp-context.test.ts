import { describe, expect, it } from "bun:test"
import path from "node:path"
import { bound } from "../../src/kilo-provider/mcp-context"

describe("MCP Settings context", () => {
  it("accepts the explicitly selected workspace and rejects stale or missing targets", () => {
    const root = path.resolve("original-workspace")
    expect(bound(root, root)).toBe(true)
    expect(bound(path.join(root, "."), root)).toBe(true)
    expect(bound(path.resolve("other-workspace"), root)).toBe(false)
    expect(bound("original-workspace", root)).toBe(false)
    expect(bound("", root)).toBe(false)
    expect(bound(root, "")).toBe(false)
    expect(bound(42, root)).toBe(false)
    expect(bound({}, root)).toBe(false)
  })

  it("preserves callers that have no new optional binding", () => {
    expect(bound(undefined, path.resolve("original-workspace"))).toBe(true)
  })
})
