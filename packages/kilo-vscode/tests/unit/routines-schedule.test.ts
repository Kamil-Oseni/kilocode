import { describe, expect, test } from "bun:test"
import { english, reason } from "../../src/kilo-provider/routines"

describe("routine schedule english", () => {
  test("maps panel phrases to concrete schedules without cron typing", () => {
    expect(english("just when I ask")).toEqual({ kind: "manual" })
    expect(english("every weekday at 6pm")).toEqual({ kind: "cron", expr: "0 18 * * 1-5" })
    expect(english("every morning")).toEqual({ kind: "cron", expr: "0 9 * * *" })
    expect(english("every time CI fails on main")).toEqual({ kind: "event", source: "ci", filter: "main" })
    const once = english("in 2 minutes")
    expect(once.kind).toBe("once")
    if (once.kind !== "once") return
    expect(once.at).toBeGreaterThan(Date.now())
    expect(once.at).toBeLessThan(Date.now() + 3 * 60_000)
  })

  test("turns raw HTTP 400 dumps into a capability sentence", () => {
    expect(reason(new Error("POST http://127.0.0.1:1/kilocode/agent → 400 Bad Request"))).toBe(
      "Could not save that routine. Accountant jobs need Money tools checked. Inbox jobs need Messages tools checked.",
    )
    expect(reason(new Error("This agent is paused."))).toBe("This agent is paused.")
  })
})
