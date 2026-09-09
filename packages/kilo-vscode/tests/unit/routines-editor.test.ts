import { expect, test } from "bun:test"
import { compile, initial, populate, Schedule } from "../../src/shared/routine-schedule"

test("structured calendar controls preserve selected days and monthly skip semantics", () => {
  const draft = initial("America/Toronto")
  expect(compile({ ...draft, days: [1], time: "09:00" })).toEqual({
    kind: "cron",
    expr: "0 9 * * 1",
    tz: "America/Toronto",
  })
  expect(compile({ ...draft, days: [5, 1, 5], time: "15:30" })).toEqual({
    kind: "cron",
    expr: "30 15 * * 1,5",
    tz: "America/Toronto",
  })
  expect(compile({ ...draft, mode: "daily", time: "00:00" })).toEqual({
    kind: "cron",
    expr: "0 0 * * *",
    tz: "America/Toronto",
  })
  expect(compile({ ...draft, mode: "monthly", day: "31" })).toEqual({
    kind: "cron",
    expr: "0 18 31 * *",
    tz: "America/Toronto",
  })
})

test("one-shot and event controls retain exact meaning", () => {
  const draft = initial("UTC")
  expect(compile({ ...draft, mode: "once", delay: "2", unit: "hours" }, 1000)).toEqual({ kind: "once", at: 7_201_000 })
  expect(compile({ ...draft, mode: "once", delay: "2", unit: "minutes" }, 1000)).toEqual({ kind: "once", at: 121_000 })
  expect(compile({ ...draft, mode: "event", filtered: true, branch: "Feature/Fix" })).toEqual({
    kind: "event",
    source: "ci",
    filter: "Feature/Fix",
  })
  expect(compile({ ...draft, mode: "event", filtered: false })).toEqual({
    kind: "event",
    source: "ci",
    filter: undefined,
  })
  expect(compile({ ...draft, mode: "event", filtered: true, branch: "" })).toEqual({
    kind: "event",
    source: "ci",
    filter: "",
  })
  expect(compile({ ...draft, mode: "event", filtered: true, branch: " Exact " })).toEqual({
    kind: "event",
    source: "ci",
    filter: " Exact ",
  })
  expect(compile({ ...draft, mode: "manual" })).toEqual({ kind: "manual" })
})

test("invalid structured inputs do not become a different schedule", () => {
  const draft = initial("UTC")
  for (const patch of [
    { days: [] },
    { time: "24:00" },
    { time: "09:60" },
    { days: [7] },
    { zone: "" },
    { mode: "monthly" as const, day: "0" },
    { mode: "monthly" as const, day: "32" },
    { mode: "once" as const, delay: "0" },
    { mode: "once" as const, delay: "1.5" },
    { mode: "once" as const, delay: "9007199254740991" },
    { mode: "event" as const, source: "" },
  ])
    expect(() => compile({ ...draft, ...patch })).toThrow()
  for (const value of [
    { kind: "once", at: Infinity },
    { kind: "manual", expr: "0 9 * * *" },
    { kind: "cron", expr: "" },
  ])
    expect(Schedule.safeParse(value).success).toBe(false)
})

test("templates populate simple controls and preserve advanced cron expressions", () => {
  for (const schedule of [
    { kind: "cron" as const, expr: "0 9 * * *", tz: "UTC" },
    { kind: "cron" as const, expr: "30 18 * * 1,5", tz: "America/Toronto" },
    { kind: "cron" as const, expr: "0 9 15 * *", tz: "UTC" },
    { kind: "cron" as const, expr: "0 9 15 * 1", tz: "UTC" },
    { kind: "cron" as const, expr: "*/15 * * * *", tz: "UTC" },
    { kind: "event" as const, source: "custom", filter: "Exact" },
    { kind: "event" as const, source: "custom", filter: "" },
    { kind: "manual" as const },
  ])
    expect(compile(populate(schedule, "UTC"))).toEqual(schedule)
  expect(populate({ kind: "cron", expr: "0 18 * * 1-5" }, "UTC").days).toEqual([1, 2, 3, 4, 5])
  expect(compile(populate({ kind: "once", at: Date.parse("2026-07-10T13:00:12.345Z") }, "America/Toronto"))).toEqual({
    kind: "local",
    local: "2026-07-10T09:00:12.345",
    tz: "America/Toronto",
    fold: "reject",
  })
  expect(() => compile({ ...initial("UTC"), mode: "date" })).toThrow("calendar date")
})
