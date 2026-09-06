export function next(expr: string, from: number) {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error("Schedule needs a 5-field cron expression")
  const start = Math.floor(from / 60_000) * 60_000 + 60_000
  const end = start + 366 * 86_400_000
  for (let at = start; at < end; at += 60_000) {
    const date = new Date(at)
    if (match(parts, date)) return at
  }
  throw new Error("No upcoming time for this schedule")
}

function match(parts: string[], date: Date) {
  return (
    field(parts[0]!, date.getMinutes()) &&
    field(parts[1]!, date.getHours()) &&
    field(parts[2]!, date.getDate()) &&
    field(parts[3]!, date.getMonth() + 1) &&
    weekday(parts[4]!, date.getDay())
  )
}

function weekday(token: string, day: number) {
  if (token === "7") return field("0", day)
  return field(token, day)
}

function field(token: string, value: number) {
  if (token === "*") return true
  return token.split(",").some((item) => {
    const [range, step] = item.split("/")
    const stride = step ? Number(step) : 1
    if (!range || range === "*") return value % stride === 0
    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number)
      if (lo === undefined || hi === undefined) return false
      return value >= lo && value <= hi && (value - lo) % stride === 0
    }
    const n = Number(range)
    return value === n && (stride === 1 || value % stride === 0)
  })
}
