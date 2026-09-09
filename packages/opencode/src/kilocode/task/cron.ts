import { Effect } from "effect"

export function next(expr: string, from: number, zone?: string) {
  const cursor = scan(expr, from, zone)
  while (true) {
    const step = cursor.next()
    if (step.done) return step.value
  }
}

export function upcoming(expr: string, from: number, zone?: string) {
  return Effect.gen(function* () {
    const cursor = scan(expr, from, zone)
    while (true) {
      const step = yield* Effect.try({ try: () => cursor.next(), catch: (err) => err })
      if (step.done) return step.value
      // Yield to the host event loop as well as other Effect fibers; waiting is interruptible.
      yield* Effect.sleep(0)
    }
  })
}

function* scan(expr: string, from: number, zone?: string) {
  if (!Number.isFinite(from) || Math.abs(from) > 8_640_000_000_000_000) {
    throw new Error("Invalid schedule reference time")
  }
  const parts = parse(expr)
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  })
  const minute =
    parts[0].size < 60
      ? new Intl.DateTimeFormat("en-US", { timeZone: zone, numberingSystem: "latn", minute: "numeric" })
      : undefined
  const start = Math.floor(from / 60_000) * 60_000 + 60_000
  // One Gregorian cycle includes every date/weekday combination, including century exceptions.
  // Adjacent days allow for the local/UTC date boundary; stay within JavaScript's date range.
  const end = Math.min(start + 146_099 * 86_400_000, 8_640_000_000_000_000)
  let count = 0
  for (let at = start; at <= end; at += 60_000) {
    if (++count % 1024 === 0) yield
    if (at === start || at % 86_400_000 === 0) {
      const day = Math.floor(at / 86_400_000) * 86_400_000
      // A zoned date is at most one calendar day away from the UTC date.
      // This is only a coarse exclusion: actual minutes still use the timezone clock,
      // including transitions with fractional-hour offsets and repeated local times.
      const possible = [-1, 0, 1].some((offset) => {
        const date = new Date(day + offset * 86_400_000)
        return parts[2].has(date.getUTCDate()) && parts[3].has(date.getUTCMonth() + 1) && parts[4].has(date.getUTCDay())
      })
      if (!possible) {
        at = day + 86_400_000 - 60_000
        continue
      }
    }
    if (minute && !parts[0].has(Number(minute.format(at)))) continue
    const date = Object.fromEntries(clock.formatToParts(at).map((part) => [part.type, part.value]))
    if (match(parts, date)) return at
  }
  throw new Error("No upcoming time for this schedule")
}

function match(parts: Set<number>[], date: Record<string, string>) {
  return (
    parts[0].has(Number(date.minute)) &&
    parts[1].has(Number(date.hour)) &&
    parts[2].has(Number(date.day)) &&
    parts[3].has(Number(date.month)) &&
    parts[4].has(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(date.weekday))
  )
}

export function parse(expr: string) {
  if (expr.length > 1024) throw new Error("Schedule expression is too long")
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error("Schedule needs a 5-field cron expression")
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ]
  const fields = parts.map((token, index) => {
    const [min, max] = bounds[index]
    const values = new Set<number>()
    for (const item of token.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item)
      if (!match) throw new Error(`Unsupported schedule field: ${token}`)
      const range = match[1].split("-")
      const step = match[2] === undefined ? 1 : Number(match[2])
      const lo = match[1] === "*" ? min : Number(range[0])
      const hi = match[1] === "*" ? max : range[1] !== undefined ? Number(range[1]) : match[2] !== undefined ? max : lo
      if (
        !Number.isSafeInteger(step) ||
        step < 1 ||
        !Number.isSafeInteger(lo) ||
        !Number.isSafeInteger(hi) ||
        lo < min ||
        hi > max ||
        lo > hi
      ) {
        throw new Error(`Invalid schedule field: ${token}`)
      }
      for (let value = lo; value <= hi; value += step) values.add(index === 4 && value === 7 ? 0 : value)
    }
    return values
  })
  const lengths = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (![...fields[3]].some((month) => [...fields[2]].some((day) => day <= lengths[month - 1]))) {
    throw new Error("No calendar date matches this schedule")
  }
  return fields
}
