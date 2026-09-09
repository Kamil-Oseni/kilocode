import { describe, expect, test } from "bun:test"
import { next, parse, upcoming } from "@/kilocode/task/cron"
import { Cause, Effect, Exit } from "effect"
import { RayaTask } from "@/kilocode/task"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

describe("routine calendar timezone", () => {
  test("a host timer can interrupt a long calendar search", async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 0)
    try {
      const result = await Effect.runPromiseExit(
        upcoming("30 2 8-14 3 0", Date.parse("2026-01-01T00:00:00Z"), "America/Toronto"),
        { signal: controller.signal },
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) throw new Error("Expected interruption")
      expect(Cause.hasInterrupts(result.cause)).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  })

  test("cooperative searches preserve results and can be executed again", async () => {
    const from = Date.parse("2026-01-01T00:00:00Z")
    const search = upcoming("0 0 29 2 1", from, "America/Toronto")
    const expected = next("0 0 29 2 1", from, "America/Toronto")
    expect(await Effect.runPromise(search)).toBe(expected)
    expect(await Effect.runPromise(search)).toBe(expected)
  })

  test("terminates when every selected local time falls in a daylight-saving gap", () => {
    expect(() => next("30 2 8-14 3 0", Date.parse("2026-01-01T00:00:00Z"), "America/Toronto")).toThrow(
      "No upcoming time for this schedule",
    )
  }, 30_000)

  test.each([
    ["0 0 29 2 *", "2026-01-01T00:00:00Z", "2028-02-29T00:00:00Z"],
    ["0 0 29 2 *", "2096-03-01T00:00:00Z", "2104-02-29T00:00:00Z"],
    ["0 0 29 2 1", "2026-01-01T00:00:00Z", "2044-02-29T00:00:00Z"],
  ])("finds long-period calendar occurrences: %s after %s", (expr, from, expected) => {
    expect(next(expr, Date.parse(from), "UTC")).toBe(Date.parse(expected))
  })

  test.each(["0 0 30 2 *", "0 0 31 4,6,9,11 *", "0 0 30-31 2 *"])(
    "rejects a calendar with no possible date: %s",
    (expr) => {
      expect(() => parse(expr)).toThrow("No calendar date matches this schedule")
    },
  )

  test("retains schedules with at least one possible date in their lists", () => {
    expect(next("0 0 30,31 2,4 *", Date.parse("2026-01-01T00:00:00Z"), "UTC")).toBe(Date.parse("2026-04-30T00:00:00Z"))
  })

  test.each([NaN, Infinity, -Infinity, 8_640_000_000_000_001])("rejects an invalid reference timestamp: %s", (from) => {
    expect(() => next("* * * * *", from, "UTC")).toThrow("Invalid schedule reference time")
  })

  test.each([
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "0 24 * * *",
    "0 0 0 * *",
    "0 0 * 13 *",
    "0 0 * * 8",
    "*/0 * * * *",
    "*/-1 * * * *",
    "1-0 * * * *",
    "1,,2 * * * *",
    "1/2/3 * * * *",
    "1.5 * * * *",
    "0 0 L * *",
    "0 0 * * MON",
    "0 0 ? * *",
    "0 0 * * 1#2",
    "0 0 * * 7-1",
    "1/ * * * *",
    "/2 * * * *",
  ])("rejects unsupported or invalid cron before evaluating: %s", (expr) => {
    expect(() => parse(expr)).toThrow()
  })

  test("bounds parser input", () => {
    expect(() => parse("1,".repeat(1000) + "1 * * * *")).toThrow()
  })

  test.each([
    ["5/20 * * * *", "2026-01-01T00:06:00Z", "2026-01-01T00:25:00Z"],
    ["0 0 */2 * *", "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z"],
    ["0 0 1 */2 *", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"],
    ["0 0 * * 5-7", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"],
    ["0 0 * * 1,7", "2026-01-03T00:00:00Z", "2026-01-04T00:00:00Z"],
    ["10-20/5,45 * * * *", "2026-01-01T00:15:00Z", "2026-01-01T00:20:00Z"],
  ])("evaluates supported steps and lists: %s", (expr, from, expected) => {
    expect(next(expr, Date.parse(from), "UTC")).toBe(Date.parse(expected))
  })

  test("explicit timezone produces the same occurrence on differently zoned hosts", async () => {
    const results = await Promise.all(
      ["UTC", "Asia/Tokyo"].map(async (zone) => {
        const result = await promisify(execFile)(
          process.execPath,
          [fileURLToPath(new URL("./fixtures/task-cron.ts", import.meta.url))],
          { env: { ...process.env, TZ: zone }, windowsHide: true },
        )
        return JSON.parse(result.stdout)
      }),
    )
    expect(results).toEqual([
      { zone: "UTC", at: Date.parse("2026-07-06T13:00:00Z") },
      { zone: "Asia/Tokyo", at: Date.parse("2026-07-06T13:00:00Z") },
    ])
  })

  test.each([
    ["America/Toronto", "2026-01-02T00:00:00Z", "2027-01-01T05:00:00Z"],
    ["Pacific/Kiritimati", "2026-01-02T00:00:00Z", "2026-12-31T10:00:00Z"],
    ["Pacific/Honolulu", "2026-01-02T00:00:00Z", "2027-01-01T10:00:00Z"],
  ])("does not skip an annual occurrence near a UTC date boundary in %s", (zone, from, expected) => {
    expect(next("0 0 1 1 *", Date.parse(from), zone)).toBe(Date.parse(expected))
  })

  test.each([
    ["America/Toronto", "2026-01-05T13:00:00Z", "2026-01-05T14:00:00Z"],
    ["America/Toronto", "2026-07-06T12:00:00Z", "2026-07-06T13:00:00Z"],
    ["Asia/Kathmandu", "2026-07-06T00:00:00Z", "2026-07-06T03:15:00Z"],
    ["Pacific/Kiritimati", "2026-07-05T12:00:00Z", "2026-07-05T19:00:00Z"],
    ["UTC", "2026-07-06T08:59:59Z", "2026-07-06T09:00:00Z"],
  ])("runs at 09:00 in %s", (zone, from, expected) => {
    expect(next("0 9 * * 1-5", Date.parse(from), zone)).toBe(Date.parse(expected))
  })

  test("skips a nonexistent local time at the spring clock change", () => {
    expect(next("30 2 * * *", Date.parse("2026-03-08T05:00:00Z"), "America/Toronto")).toBe(
      Date.parse("2026-03-09T06:30:00Z"),
    )
  })

  test("keeps repeated local minutes as distinct increasing instants", () => {
    const first = next("30 1 * * *", Date.parse("2026-11-01T04:00:00Z"), "America/Toronto")
    expect(first).toBe(Date.parse("2026-11-01T05:30:00Z"))
    expect(next("30 1 * * *", first, "America/Toronto")).toBe(Date.parse("2026-11-01T06:30:00Z"))
  })

  test("handles a thirty-minute daylight-saving jump", () => {
    expect(next("15 2 * * *", Date.parse("2026-10-03T13:00:00Z"), "Australia/Lord_Howe")).toBe(
      Date.parse("2026-10-04T15:15:00Z"),
    )
  })

  test("uses local midnight and calendar date across UTC date boundaries", () => {
    expect(next("0 0 1 1 *", Date.parse("2026-12-31T09:59:59Z"), "Pacific/Kiritimati")).toBe(
      Date.parse("2026-12-31T10:00:00Z"),
    )
  })

  test("does not silently fall back for an invalid timezone", () => {
    expect(() => next("* * * * *", Date.parse("2026-01-01T00:00:00Z"), "Invalid/Timezone")).toThrow()
  })

  test("task scheduling passes the persisted timezone to the evaluator", () => {
    const agent: RayaTask.Agent = {
      id: "timezone",
      name: "Morning",
      role: "generalist",
      objective: "Summarize",
      capabilities: [],
      memoryScope: "role",
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Kathmandu" },
      enabled: true,
      createdAt: Date.parse("2026-07-06T00:00:00Z"),
      updatedAt: Date.parse("2026-07-06T00:00:00Z"),
    }
    const at = Date.parse("2026-07-06T03:15:00Z")
    expect(RayaTask.next(agent, at)).toBe(at)
    expect(RayaTask.due(agent, at)).toBe(at)
    expect(RayaTask.due(agent, at - 1)).toBeUndefined()
  })
})
