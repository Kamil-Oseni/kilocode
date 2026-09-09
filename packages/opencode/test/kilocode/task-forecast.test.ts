import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { RayaTask } from "@/kilocode/task"

describe("routine schedule forecast", () => {
  test("uses execution's timezone rules across a daylight-saving change", async () => {
    const input = { kind: "cron" as const, expr: "0 9 * * *", tz: "America/Toronto" }
    const from = Date.parse("2026-03-07T00:00:00Z")
    const result = await Effect.runPromise(RayaTask.forecast(input, from))
    expect(result.schedule).toEqual(input)
    expect(result.from).toBe(from)
    expect(result.occurrences).toEqual([
      Date.parse("2026-03-07T14:00:00Z"),
      Date.parse("2026-03-08T13:00:00Z"),
      Date.parse("2026-03-09T13:00:00Z"),
    ])
  })

  test("previews one-shot, manual and exact event schedules without storage services", async () => {
    expect(await Effect.runPromise(RayaTask.forecast({ kind: "once", at: 2000 }, 1000))).toEqual({
      schedule: { kind: "once", at: 2000 },
      from: 1000,
      occurrences: [2000],
    })
    for (const schedule of [
      { kind: "manual" as const },
      { kind: "event" as const, source: "ci", filter: "Feature/A" },
    ]) {
      expect(await Effect.runPromise(RayaTask.forecast(schedule, 1000))).toEqual({
        schedule,
        from: 1000,
        occurrences: [],
      })
    }
  })

  test("rejects invalid dates, calendars and timezones", async () => {
    for (const input of [
      { kind: "once" as const, at: 1000 },
      { kind: "once" as const, at: Infinity },
      { kind: "cron" as const, expr: "0 9 30 2 *", tz: "UTC" },
      { kind: "cron" as const, expr: "0 9 * * *", tz: "Invalid/Zone" },
    ]) {
      const result = await Effect.runPromise(RayaTask.forecast(input, 1000).pipe(Effect.flip))
      expect(result._tag).toBe("RayaTask.GuardError")
      expect(result.kind).toBe("schedule")
      expect(["schedule", "timezone"]).toContain(result.field ?? "")
    }
  })
})
