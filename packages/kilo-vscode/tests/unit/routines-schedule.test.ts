import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { english, handleRoutineMessage, reason } from "../../src/kilo-provider/routines"

describe("routine schedule english", () => {
  test("reports unsupported input before filesystem or API creation", async () => {
    const dir = path.resolve(".tmp", `invalid-routine-${crypto.randomUUID()}`)
    const calls: unknown[] = []
    const messages: unknown[] = []
    const client = createKiloClient({
      fetch: async (request) => {
        calls.push(request)
        throw new Error("Invalid schedules must not reach the API")
      },
    })
    expect(
      await handleRoutineMessage({
        message: { type: "routineCreate", when: "every 2 hours", dir },
        client,
        directory: process.cwd(),
        post: (msg) => messages.push(msg),
      }),
    ).toBe(true)
    expect(calls).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(messages).toEqual([
      { type: "routineState", error: expect.stringContaining("That schedule is not supported.") },
    ])
  })

  test.each([
    ["every Monday at 9am", "0 9 * * 1"],
    ["every Friday at 3pm", "0 15 * * 5"],
    ["every Sunday at 12am", "0 0 * * 0"],
    ["every Saturday at 12pm", "0 12 * * 6"],
    ["every Tuesday at 23:59", "59 23 * * 2"],
    ["every Wednesday at 0:00", "0 0 * * 3"],
    ["every Thursday at 6:05pm", "5 18 * * 4"],
    ["  EVERY   WEEKDAY at 6PM  ", "0 18 * * 1-5"],
    ["Weekdays at 6pm", "0 18 * * 1-5"],
    ["Weekday mornings", "0 9 * * 1-5"],
    ["daily at 9am", "0 9 * * *"],
  ])("preserves the requested calendar for %s", (text, expr) => {
    expect(english(text)).toEqual({ kind: "cron", expr })
  })

  test.each([
    "every 2 hours",
    "tomorrow morning",
    "every Monday at 9am except holidays",
    "every weekday at 25:00",
    "every day at 12:60",
    "every day at 0am",
    "every day at 13pm",
    "in 0 minutes",
    "in 9007199254740991 hours",
    "in 2 minutes then repeat",
    "manual tomorrow",
    "when CI fails on main or staging",
  ])("rejects unsupported or invalid input without inventing a schedule: %s", (text) => {
    expect(() => english(text)).toThrow()
  })

  test("preserves exact event branches, including case and non-default branches", () => {
    expect(english("when CI fails on Feature/Fix-123")).toEqual({
      kind: "event",
      source: "ci",
      filter: "Feature/Fix-123",
    })
    expect(english("when CI fails")).toEqual({ kind: "event", source: "ci", filter: undefined })
  })

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

  test("does not infer a capability denial from a generic HTTP failure", () => {
    expect(reason(new Error("POST http://127.0.0.1:1/kilocode/agent → 400 Bad Request"))).toBe(
      "The routine request was not confirmed. Check its current state before trying again.",
    )
    expect(reason(new Error("This agent is paused."))).toBe("This agent is paused.")
    expect(reason({ name: "InvalidRequestError", data: { message: "Choose a valid timezone." } })).toBe(
      "Choose a valid timezone.",
    )
    for (const input of [undefined, null, {}, "Bad Request", new Error("DELETE http://localhost/agent: 400")])
      expect(reason(input)).toBe("The routine request was not confirmed. Check its current state before trying again.")
  })
})
