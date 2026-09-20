import { describe, expect, test } from "bun:test"
import { present } from "@/kilocode/snapshot/stage"

describe("snapshot stage candidates", () => {
  test("drops only untracked files that disappeared after enumeration", () => {
    const files = ["tracked-delete.txt", ".raya-replace-123", "stable.txt"]
    const untracked = new Set([".raya-replace-123", "stable.txt"])

    const result = present(files, untracked, new Set(["stable.txt"]))

    expect(result).toEqual(["tracked-delete.txt", "stable.txt"])
  })

  test("retains a missing tracked path so Git can stage its deletion", () => {
    const result = present(["deleted.txt"], new Set(), new Set())

    expect(result).toEqual(["deleted.txt"])
  })
})
