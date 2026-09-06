export function quiet(now: Date, window: string) {
  const match = window.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!match) return false
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  const mins = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  if (start < end) return mins >= start && mins < end
  return mins >= start || mins < end
}

export function shouldNotify(input: { visible: boolean; hours: string; now?: Date }) {
  if (input.visible) return false
  return !quiet(input.now ?? new Date(), input.hours)
}
