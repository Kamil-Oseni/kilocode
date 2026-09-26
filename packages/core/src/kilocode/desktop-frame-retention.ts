// Remove legacy desktop pixels while retaining tool receipts and non-image attachments.
const pixels = /data:[^\s"'<>]*?;base64,[A-Za-z0-9+/=]+/gi

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(pixels, "[private media omitted]")
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]))
}

export function scrub(value: unknown): unknown {
  if (!record(value)) return value
  const part = value
  if (part.type !== "tool" || typeof part.tool !== "string" || !part.tool.startsWith("desktop_")) return value
  const state = part.state
  if (!record(state)) return value
  const next = state
  const attachments = next.attachments
  const saved = Array.isArray(attachments)
    ? attachments.filter((item: unknown) => {
        if (!record(item)) return true
        const file = item
        if (typeof file.mime === "string" && file.mime.startsWith("image/")) return false
        return typeof file.url !== "string" || !file.url.startsWith("data:image/")
      })
    : []
  const clean = {
    ...next,
    ...(typeof next.title === "string" ? { title: redact(next.title) } : {}),
    ...(typeof next.output === "string" ? { output: redact(next.output) } : {}),
    ...(next.metadata ? { metadata: redact(next.metadata) } : {}),
    ...(Array.isArray(attachments) ? { attachments: saved.length ? saved : undefined } : {}),
  }
  return { ...part, state: clean }
}
