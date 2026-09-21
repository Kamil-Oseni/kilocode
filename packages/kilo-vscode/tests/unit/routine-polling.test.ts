import { describe, expect, test } from "bun:test"
import { polling } from "../../webview-ui/src/components/routines/routine-polling"

describe("Routine roster polling", () => {
  test("refreshes the overview and leaves open detail views stable", () => {
    expect(polling(false)).toBe(true)
    expect(polling(true)).toBe(false)
    expect(polling(false, "worker")).toBe(false)
    expect(polling(false, undefined, `org_${"a".repeat(32)}`)).toBe(false)
  })
})
