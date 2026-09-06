import { describe, expect, test } from "bun:test"
import { quiet, shouldNotify } from "../../src/kilo-provider/presence-notify"

describe("presence notifications", () => {
  test("skips while the panel is focused", () => {
    expect(shouldNotify({ visible: true, hours: "" })).toBe(false)
  })

  test("honors overnight quiet hours", () => {
    const night = new Date("2026-09-05T23:30:00")
    expect(quiet(night, "22:00-08:00")).toBe(true)
    expect(shouldNotify({ visible: false, hours: "22:00-08:00", now: night })).toBe(false)
    expect(shouldNotify({ visible: false, hours: "22:00-08:00", now: new Date("2026-09-05T12:00:00") })).toBe(true)
  })
})
