import { describe, expect, test } from "bun:test"
import { childDirectory } from "../../src/kilo-provider/child-steer"

describe("child steer host routing", () => {
  test("uses an exact route before the tracked child directory", () => {
    expect(childDirectory("C:\\worktrees\\exact", "C:\\workspace")).toBe("C:\\worktrees\\exact")
  })

  test("uses a tracked child directory when no route service owns the session", () => {
    expect(childDirectory(undefined, "C:\\workspace")).toBe("C:\\workspace")
  })

  test("fails closed for ambiguous or unknown child identity", () => {
    expect(childDirectory(null, "C:\\workspace")).toBeUndefined()
    expect(childDirectory(undefined, undefined)).toBeUndefined()
  })
})
