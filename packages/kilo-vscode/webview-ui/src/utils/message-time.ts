type Source = string | number | { createdAt?: string; time?: { created?: number } }

export function messageInstant(source?: Source) {
  const value = source && typeof source === "object" ? (source.time?.created ?? source.createdAt) : source
  if (typeof value !== "number" && typeof value !== "string") return
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return
  return date
}
