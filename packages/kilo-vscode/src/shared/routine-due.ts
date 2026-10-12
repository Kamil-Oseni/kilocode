type Schedule =
  | { kind: "once"; at: number }
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "manual" }
  | { kind: "event"; source: string; filter?: string }

/** Present the scheduler's observed date without promising that execution will start. */
export function due(
  item: { enabled: boolean; schedule: Schedule; nextRun?: number; execution?: unknown },
  now = Date.now(),
  locale?: string,
) {
  if (!item.enabled || item.execution || item.schedule.kind === "manual" || item.schedule.kind === "event") return
  const zone = item.schedule.kind === "cron" ? item.schedule.tz?.trim() : undefined
  if (item.schedule.kind === "cron" && !zone) return
  const at = item.nextRun
  if (at === undefined || !Number.isFinite(at) || Math.abs(at) > 8.64e15) return "Next due not available"
  try {
    const date = new Date(at).toLocaleString(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: zone,
      timeZoneName: zone ? undefined : "short",
    })
    return `${at > now ? "Next due" : "Scheduled for"}: ${date}${zone ? ` (${zone})` : ""}`
  } catch {
    return "Next due unavailable: saved timezone needs review"
  }
}
