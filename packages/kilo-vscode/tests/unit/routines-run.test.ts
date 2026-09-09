import { describe, expect, test } from "bun:test"
import { action, reason, select } from "../../webview-ui/src/components/routines/run"

describe("routine run navigation", () => {
  test("explains recorded trigger evidence without inventing a legacy trigger", () => {
    const at = Date.parse("2026-09-08T12:05:00Z")
    expect(reason({ at })).toStartWith("Trigger not recorded")
    expect(reason({ at, trigger: { kind: "manual" } })).toStartWith("Manual start")
    expect(reason({ at, trigger: { kind: "event", source: "ci", filter: "Feature/A", receivedAt: at } })).toContain(
      'Event: ci, filter "Feature/A"',
    )
    expect(reason({ at, trigger: { kind: "event", source: "ci", filter: "", receivedAt: at } })).toContain('filter ""')
    const trigger = { kind: "timer" as const, id: "occurrence", scheduledAt: at - 300_000, observedAt: at, tz: "UTC" }
    const scheduled = new Date(trigger.scheduledAt).toLocaleString(undefined, {
      timeZone: "UTC",
      timeZoneName: "short",
    })
    expect(reason({ at, trigger })).toContain(`Scheduled for ${scheduled}`)
    expect(reason({ at, trigger })).toContain("Startup began")
    expect(reason({ at, trigger: { ...trigger, tz: "Invalid/Zone" } })).toContain("saved timezone unavailable")
  })
  test("opens an unfinished waiting run even when newer history is complete", () => {
    const waiting = { status: "blocked" as const, blockedReason: "waiting on you", sessionID: "waiting-session" }
    const complete = { status: "complete" as const, sessionID: "complete-session" }
    const run = select([waiting, complete])
    expect(run?.sessionID).toBe("waiting-session")
    expect(action(run)).toBe("open")
    expect(action(select([{ ...waiting, status: "complete" as const }, complete]))).toBe("start")
  })

  test("preserves running exclusion without treating terminal failures as pending", () => {
    expect(action(select([{ status: "running" }, { status: "error" }]))).toBe("running")
    expect(action({ status: "blocked", blockedReason: "Missing access" })).toBe("start")
    expect(action({ status: "blocked", blockedReason: "waiting on you" }, true)).toBe("running")
    expect(select([])).toBeUndefined()
    expect(action()).toBe("start")
  })
})
