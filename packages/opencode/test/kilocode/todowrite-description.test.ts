import { describe, expect, test } from "bun:test"
import DESCRIPTION_WRITE from "../../src/tool/todowrite.txt"

describe("todowrite description", () => {
  test("requires an update between each task", () => {
    expect(DESCRIPTION_WRITE).toContain("call this tool before starting the first item")
    expect(DESCRIPTION_WRITE).toContain("After completing each item, call this tool before starting the next item")
    expect(DESCRIPTION_WRITE).toContain("Do not complete multiple items or continue through multiple steps")
  })
  test("permits real parallel work while preserving dependencies", () => {
    expect(DESCRIPTION_WRITE).toContain("include every task actually running")
    expect(DESCRIPTION_WRITE).toContain("keep dependency-blocked items `pending`")
    expect(DESCRIPTION_WRITE).not.toMatch(/exactly one|only one at a time/i)
  })
})
