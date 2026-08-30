import { describe, expect, test } from "bun:test"
import { RayaDesignSystem } from "../../src/kilocode/design-system"

describe("RayaDesignSystem.reminder", () => {
  test("returns undefined when unlocked", () => {
    expect(RayaDesignSystem.reminder({ locked: false })).toBeUndefined()
    expect(RayaDesignSystem.reminder({ locked: false, source: "packages/ui" })).toBeUndefined()
  })

  test("includes the lock guidance when locked", () => {
    const text = RayaDesignSystem.reminder({ locked: true })
    expect(text).toBeDefined()
    expect(text).toContain("Design System Lock")
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("</system-reminder>")
  })

  test("cites the source when provided", () => {
    const text = RayaDesignSystem.reminder({ locked: true, source: "packages/kilo-ui" })
    expect(text).toContain("packages/kilo-ui")
  })

  test("omits an empty source", () => {
    const text = RayaDesignSystem.reminder({ locked: true, source: "   " })
    expect(text).toBeDefined()
    expect(text).not.toContain("approved system is defined at")
  })

  test("current() defaults to unlocked", () => {
    expect(RayaDesignSystem.current().locked).toBe(false)
  })
})
