type Source = string | number | { createdAt?: string; time?: { created?: number } }

const LENGTH = 10
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const MAXIMUM = 0xffffffffffff

export function messageInstant(source?: Source) {
  const value = source && typeof source === "object" ? (source.time?.created ?? source.createdAt) : source
  if (typeof value !== "number" && typeof value !== "string") return
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return
  return date
}

export function ulidInstant(id: string) {
  if (id.length < LENGTH) return
  const value = id.slice(0, LENGTH).toUpperCase()
  let epoch = 0
  for (const char of value) {
    const index = ENCODING.indexOf(char)
    if (index === -1) return
    epoch = epoch * ENCODING.length + index
  }
  if (epoch > MAXIMUM) return
  return messageInstant(epoch)
}

export function messageLabel(date: Date | undefined, locale: string, detail: "time" | "date-time" = "time") {
  if (!date) return ""
  if (detail === "date-time")
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date)
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(date)
}

export function messageTitle(date: Date | undefined, locale: string) {
  if (!date) return ""
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "long" }).format(date)
}
