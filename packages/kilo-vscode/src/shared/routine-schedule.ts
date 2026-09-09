import { z } from "zod"

export const Schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("once"), at: z.number().finite().positive().max(8.64e15) }).strict(),
  z.object({ kind: z.literal("cron"), expr: z.string().min(1).max(1024), tz: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("event"), source: z.string().min(1), filter: z.string().optional() }).strict(),
])
export type Schedule = z.infer<typeof Schedule>

export const Proposal = z.discriminatedUnion("kind", [
  ...Schedule.options,
  z
    .object({
      kind: z.literal("local"),
      local: z.string().min(1).max(32),
      tz: z.string().min(1),
      fold: z.enum(["reject", "earlier", "later"]).optional(),
    })
    .strict(),
])
export type Proposal = z.infer<typeof Proposal>

// Preconditions must preserve malformed legacy values so an edit can repair them.
const Stored = z.discriminatedUnion("kind", [
  Schedule.options[0],
  Schedule.options[1].extend({ at: z.number() }),
  Schedule.options[2].extend({ expr: z.string(), tz: z.string().optional() }),
  Schedule.options[3].extend({ source: z.string() }),
])

export const Edit = z
  .object({
    agentID: z.string().min(1),
    expectedSchedule: Stored,
    expectedScheduleVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
export type Edit = z.infer<typeof Edit>

export type Draft = {
  mode: "daily" | "weekly" | "monthly" | "once" | "date" | "event" | "manual" | "cron"
  local: string
  fold: "reject" | "earlier" | "later"
  time: string
  days: number[]
  day: string
  delay: string
  unit: "minutes" | "hours"
  branch: string
  source: string
  filtered: boolean
  expr: string
  zone: string
}

export function initial(zone: string): Draft {
  return {
    mode: "weekly",
    local: "",
    fold: "reject",
    time: "18:00",
    days: [1, 2, 3, 4, 5],
    day: "1",
    delay: "2",
    unit: "hours",
    branch: "main",
    source: "ci",
    filtered: false,
    expr: "0 18 * * 1-5",
    zone,
  }
}

export function compile(draft: Draft, from = Date.now()): Proposal {
  if (draft.mode === "manual") return { kind: "manual" }
  if (draft.mode === "event") {
    if (!draft.source.trim()) throw new Error("Enter an event source.")
    if (draft.source.trim() !== draft.source) throw new Error("Event sources cannot start or end with spaces.")
    return { kind: "event", source: draft.source, filter: draft.filtered ? draft.branch : undefined }
  }
  if (draft.mode === "once") {
    const delay = Number(draft.delay)
    const at = from + delay * (draft.unit === "hours" ? 3_600_000 : 60_000)
    if (
      !/^\d+$/.test(draft.delay) ||
      !Number.isSafeInteger(delay) ||
      delay <= 0 ||
      !Number.isSafeInteger(at) ||
      at > 8.64e15
    )
      throw new Error("Choose a positive whole-number delay within the supported date range.")
    return { kind: "once", at }
  }
  if (!draft.zone.trim()) throw new Error("Choose a timezone for this routine.")
  if (draft.mode === "date") {
    if (!draft.local) throw new Error("Choose a calendar date and time.")
    return { kind: "local", local: draft.local, tz: draft.zone.trim(), fold: draft.fold }
  }
  if (draft.mode === "cron") {
    if (!draft.expr.trim()) throw new Error("Enter a five-field cron expression.")
    return { kind: "cron", expr: draft.expr.trim(), tz: draft.zone.trim() }
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error("Choose a valid time of day.")
  const [hour, minute] = draft.time.split(":").map(Number)
  return { kind: "cron", expr: `${minute} ${hour} ${dates(draft)}`, tz: draft.zone.trim() }
}

function dates(draft: Draft) {
  if (draft.mode === "daily") return "* * *"
  if (draft.mode === "monthly") {
    const day = Number(draft.day)
    if (!/^\d+$/.test(draft.day) || day < 1 || day > 31) throw new Error("Choose a day of the month from 1 to 31.")
    return `${day} * *`
  }
  if (!draft.days.length || draft.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
    throw new Error("Choose at least one weekday.")
  return `* * ${[...new Set(draft.days)].sort().join(",")}`
}

export function populate(schedule: Schedule, zone: string): Draft {
  const draft = initial(zone)
  if (schedule.kind === "manual") return { ...draft, mode: "manual" }
  if (schedule.kind === "event")
    return {
      ...draft,
      mode: "event",
      source: schedule.source,
      filtered: schedule.filter !== undefined,
      branch: schedule.filter ?? "main",
    }
  if (schedule.kind === "once") {
    if (!Number.isFinite(schedule.at) || Math.abs(schedule.at) > 8.64e15) return { ...draft, mode: "date" }
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        calendar: "gregory",
        numberingSystem: "latn",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(schedule.at)
        .map((part) => [part.type, part.value]),
    )
    const fraction = String(new Date(schedule.at).getUTCMilliseconds()).padStart(3, "0")
    return {
      ...draft,
      mode: "date",
      local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${fraction}`,
    }
  }
  const parts = schedule.expr.match(/^(\d+) (\d+) (\*|\d+) \* (\*|[0-6](?:,[0-6])*|1-5)$/)
  const base = { ...draft, expr: schedule.expr, zone: schedule.tz ?? zone }
  if (!parts || Number(parts[1]) > 59 || Number(parts[2]) > 23) return { ...base, mode: "cron" }
  const time = `${parts[2]!.padStart(2, "0")}:${parts[1]!.padStart(2, "0")}`
  if (parts[3] !== "*" && parts[4] !== "*") return { ...base, mode: "cron" }
  if (parts[3] !== "*") return { ...base, mode: "monthly", day: parts[3]!, time }
  if (parts[4] === "*") return { ...base, mode: "daily", time }
  return {
    ...base,
    mode: "weekly",
    time,
    days: parts[4] === "1-5" ? [1, 2, 3, 4, 5] : parts[4]!.split(",").map(Number),
  }
}
