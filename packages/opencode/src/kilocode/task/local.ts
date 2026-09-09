import { Effect } from "effect"

// Resolve an entered wall-clock time without silently shifting a clock-change gap or fold.
export function local(value: string, zone: string, fold: "reject" | "earlier" | "later" = "reject") {
  return Effect.gen(function* () {
    const clock = yield* Effect.try({
      try: () =>
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
        }),
      catch: () => new Error("Use a valid timezone for this routine."),
    })
    const target = yield* Effect.try({ try: () => parse(value), catch: (err) => err })
    const wall = (at: number) => {
      const parts = Object.fromEntries(clock.formatToParts(at).map((part) => [part.type, part.value]))
      return Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      )
    }
    const base = Math.floor(target / 1000) * 1000
    const offsets = new Set<number>()
    const matches = new Set<number>()
    // Sample actual timezone offsets around the date, then verify each candidate exactly.
    // Deriving offsets from the full clock also handles offsets containing seconds.
    for (let minute = -2160; minute <= 2160; minute++) {
      if (minute % 256 === 0) yield* Effect.sleep(0)
      yield* Effect.try({
        try: () => {
          const probe = base + minute * 60_000
          const offset = wall(probe) - probe
          if (offsets.has(offset)) return
          offsets.add(offset)
          const candidate = target - offset
          if (wall(candidate) === base) matches.add(candidate)
        },
        catch: (err) => err,
      })
    }
    const ordered = [...matches].sort((a, b) => a - b)
    if (!ordered.length)
      return yield* Effect.fail(new Error("That local time does not exist in this timezone. Choose a different time."))
    if (ordered.length > 1 && fold === "reject")
      return yield* Effect.fail(
        new Error("That local time occurs twice. Choose the first or second occurrence before previewing again."),
      )
    return {
      at: fold === "later" ? ordered[ordered.length - 1] : ordered[0],
      timezone: clock.resolvedOptions().timeZone,
    }
  })
}

function parse(value: string) {
  const match = value.match(/^([1-9]\d{3})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/)
  if (!match) throw new Error("Choose a valid calendar date and time.")
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6] ?? "0")
  const millisecond = Number((match[7] ?? "0").padEnd(3, "0"))
  const at = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  const date = new Date(at)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    throw new Error("Choose a valid calendar date and time.")
  return at
}
