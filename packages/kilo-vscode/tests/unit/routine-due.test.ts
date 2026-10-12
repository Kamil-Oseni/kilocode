import { expect, test } from "bun:test"
import { due } from "../../src/shared/routine-due"

const at = Date.parse("2026-10-12T13:00:00Z")
const item = {
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/Toronto" },
  nextRun: at,
} as const

test("routine due date uses its saved timezone and distinguishes a retained past date", () => {
  expect(due(item, at - 1000, "en-GB")).toBe("Next due: 12 Oct 2026, 9:00 (America/Toronto)")
  expect(due(item, at + 1000, "en-GB")).toBe("Scheduled for: 12 Oct 2026, 9:00 (America/Toronto)")
  expect(due({ ...item, schedule: { kind: "once", at } }, at - 1000, "en-GB")).toContain("Next due:")
})

test("paused, active and undated routines do not advertise an upcoming start", () => {
  expect(due({ ...item, enabled: false })).toBeUndefined()
  expect(due({ ...item, execution: { state: "active" } })).toBeUndefined()
  expect(due({ ...item, schedule: { kind: "manual" } })).toBeUndefined()
  expect(due({ ...item, schedule: { kind: "event", source: "ci" } })).toBeUndefined()
})

test("unknown dates and invalid timezone cannot become a fabricated upcoming occurrence", () => {
  expect(due({ ...item, nextRun: undefined })).toBe("Next due not available")
  expect(due({ ...item, nextRun: NaN })).toBe("Next due not available")
  expect(due({ ...item, schedule: { ...item.schedule, tz: undefined } })).toBeUndefined()
  expect(due({ ...item, schedule: { ...item.schedule, tz: "Not/AZone" } })).toBe(
    "Next due unavailable: saved timezone needs review",
  )
})
