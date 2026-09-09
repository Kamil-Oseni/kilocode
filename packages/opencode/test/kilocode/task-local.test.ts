import { describe, expect, test } from "bun:test"
import { Effect, Exit, Cause } from "effect"
import assert from "node:assert/strict"
import { RayaTask } from "@/kilocode/task"

const from = Date.parse("2025-01-01T00:00:00Z")
const forecast = (local: string, tz: string, fold?: "reject" | "earlier" | "later") =>
  Effect.runPromise(RayaTask.forecast({ kind: "local", local, tz, fold }, from))

describe("one-shot local calendar preview", () => {
  test("a host timer can interrupt date resolution", async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 0)
    try {
      const result = await Effect.runPromiseExit(
        RayaTask.forecast({ kind: "local", local: "2026-11-01T01:30", tz: "America/Toronto" }, from),
        { signal: controller.signal },
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isSuccess(result)) throw new Error("Expected interruption")
      expect(Cause.hasInterrupts(result.cause)).toBe(true)
    } finally {
      clearTimeout(timer)
    }
  })
  test("resolves seasonal and fractional offsets, preserving seconds and milliseconds", async () => {
    for (const [value, tz, expected] of [
      ["2026-01-10T09:00", "America/Toronto", "2026-01-10T14:00:00Z"],
      ["2026-07-10T09:00:12.345", "America/Toronto", "2026-07-10T13:00:12.345Z"],
      ["2026-07-10T09:00", "Asia/Kathmandu", "2026-07-10T03:15:00Z"],
      ["2026-07-10T09:00", "Australia/Eucla", "2026-07-10T00:15:00Z"],
      ["2028-02-29T00:00", "UTC", "2028-02-29T00:00:00Z"],
    ] as const) {
      const result = await forecast(value, tz)
      expect(result.schedule).toEqual({ kind: "once", at: Date.parse(expected) })
      expect(result.occurrences).toEqual([Date.parse(expected)])
      expect(result).toMatchObject({
        timezone: new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone,
      })
    }
  })

  test("requires a deliberate choice for a repeated hour and a repeated half hour", async () => {
    for (const [value, tz, first, second] of [
      ["2026-11-01T01:30", "America/Toronto", "2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"],
      ["2026-04-05T01:45", "Australia/Lord_Howe", "2026-04-04T14:45:00Z", "2026-04-04T15:15:00Z"],
    ] as const) {
      await assert.rejects(forecast(value, tz), /occurs twice/)
      expect((await forecast(value, tz, "earlier")).occurrences).toEqual([Date.parse(first)])
      expect((await forecast(value, tz, "later")).occurrences).toEqual([Date.parse(second)])
    }
  })

  test("rejects gaps, date rollover, invalid zones and past times", async () => {
    for (const [value, tz] of [
      ["2026-03-08T02:30", "America/Toronto"],
      ["2026-10-04T02:15", "Australia/Lord_Howe"],
    ] as const)
      await assert.rejects(forecast(value, tz, "later"), /does not exist/)
    for (const value of [
      "2026-02-29T12:00",
      "2026-04-31T12:00",
      "2026-01-01T24:00",
      "2026-01-01T12:60",
      "2026-01-01T12:00:60",
      "tomorrow",
    ]) {
      await assert.rejects(forecast(value, "UTC"), /valid calendar date/)
    }
    await assert.rejects(forecast("2026-01-01T12:00", "Invalid/Zone"), /valid timezone/)
    await assert.rejects(forecast("2024-01-01T12:00", "UTC"), /future/)
  })
})
