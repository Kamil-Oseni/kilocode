function calendar(hour: RegExpMatchArray) {
  const ap = hour[4]?.toLowerCase()
  const raw = Number(hour[2])
  const m = Number(hour[3] ?? "0")
  if (m > 59 || (ap ? raw < 1 || raw > 12 : raw > 23))
    throw new Error("Use a valid time: 1–12 with am/pm, or 0–23 without am/pm, and minutes from 00–59.")
  const h = ap === "pm" && raw < 12 ? raw + 12 : ap === "am" && raw === 12 ? 0 : raw
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
  const day = hour[1]?.toLowerCase() ?? "day"
  const dow = day.startsWith("weekday") ? "1-5" : day === "day" ? "*" : String(days.indexOf(day))
  return { kind: "cron" as const, expr: `${m} ${h} * * ${dow}` }
}

export function english(when: string | undefined) {
  const text = (when ?? "").trim().replace(/\s+/g, " ")
  if (!text || /^(?:when i ask|only when i ask|manual|just when i ask)$/i.test(text)) return { kind: "manual" as const }
  const once = text.match(/^(?:once )?in (\d+)\s*(minute|min|hour|hr)s?$/i)
  if (once) {
    const n = Number(once[1])
    const ms = /^h/i.test(once[2]) ? n * 3_600_000 : n * 60_000
    const at = Date.now() + ms
    if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(at) || at > 8.64e15)
      throw new Error("Choose a positive delay within the supported date range.")
    return { kind: "once" as const, at }
  }
  const event = text.match(/^(?:every time|when) ci fails(?: on ([a-z0-9._/-]+))?$/i)
  if (event) {
    return { kind: "event" as const, source: "ci", filter: event[1] }
  }
  if (/^(?:every morning|daily)$/i.test(text)) return { kind: "cron" as const, expr: "0 9 * * *" }
  if (/^weekday mornings$/i.test(text)) return { kind: "cron" as const, expr: "0 9 * * 1-5" }
  const hour = text.match(
    /^(?:(?:every )?(day|weekday|weekdays|sunday|monday|tuesday|wednesday|thursday|friday|saturday)|daily) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  )
  if (hour) return calendar(hour)
  throw new Error(
    'That schedule is not supported. Try "every Monday at 9am", "every weekday at 6pm", "in 2 hours", or "just when I ask".',
  )
}
