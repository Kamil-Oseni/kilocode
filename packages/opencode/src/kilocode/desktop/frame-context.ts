// Kilo-owned one-turn desktop image delivery. Data URLs never enter the session database.
import type { SessionV1 } from "@opencode-ai/core/v1/session"

const limit = 24 * 1024 * 1024
const lifetime = 120_000
const queue = new Map<
  string,
  { session: string; turn: string; call: string; until: number; images: SessionV1.FilePart[]; bytes: number }
>()
const injected = new WeakSet<object>()

const pixels = /data:[^\s"'<>]*?;base64,[A-Za-z0-9+/=]+/gi

export function redact(text: string) {
  return text.replace(pixels, "[private media omitted]")
}

export function redactMetadata(value: unknown): unknown {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map(redactMetadata)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactMetadata(item)]))
}

function prune() {
  const now = Date.now()
  for (const [key, value] of queue) if (value.until <= now) queue.delete(key)
  let bytes = [...queue.values()].reduce((sum, item) => sum + item.bytes, 0)
  while (queue.size > 16 || bytes > limit) {
    const key = queue.keys().next().value
    if (!key) break
    bytes -= queue.get(key)!.bytes
    queue.delete(key)
  }
}

export function store(input: { session: string; turn: string; call: string; attachments: SessionV1.FilePart[] }) {
  prune()
  const images: SessionV1.FilePart[] = []
  let bytes = 0
  for (const item of input.attachments.toReversed()) {
    if (!item.mime.startsWith("image/") || !item.url.startsWith(`data:${item.mime};base64,`)) continue
    const size = Buffer.byteLength(item.url)
    if (bytes + size > limit) continue
    images.unshift(item)
    bytes += size
  }
  const key = `${input.session}:${input.call}`
  if (images.length) queue.set(key, { ...input, images, bytes, until: Date.now() + lifetime })
  prune()
  return { kept: images.length, omitted: input.attachments.length - images.length }
}

export function take(session: string, turn: string) {
  prune()
  const frames = new Map<string, SessionV1.FilePart[]>()
  for (const [key, value] of queue) {
    if (value.session !== session) continue
    queue.delete(key)
    if (value.turn === turn) frames.set(value.call, value.images)
  }
  return frames
}

export function inject(messages: SessionV1.WithParts[], frames: Map<string, SessionV1.FilePart[]>) {
  if (!frames.size) return messages
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return part
      const images = frames.get(part.callID)
      if (!images || message.info.sessionID !== part.sessionID) return part
      const next = { ...part, state: { ...part.state, attachments: images } }
      injected.add(next)
      return next
    }),
  }))
}

export function isInjected(part: object) {
  return injected.has(part)
}
