import { createHash } from "node:crypto"
import type { LiveCall } from "./live-protocol"

type Fragment = (typeof LiveCall.Type)["context"]["fragments"][number]
export type State = {
  version: 1
  events: Record<string, string>
  fragments: Fragment[]
  bytes: number
  cursor: number
  blocked: boolean
}
export const create = (): State => ({ version: 1, events: {}, fragments: [], bytes: 0, cursor: 0, blocked: false })

export function valid(value: unknown): value is State {
  const state = object(value)
  const events = object(state?.events)
  if (
    !state ||
    state.version !== 1 ||
    !events ||
    Object.keys(events).length > 1024 ||
    !Object.entries(events).every(
      ([key, hash]) => /^[a-f0-9]{64}$/.test(key) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    ) ||
    !Array.isArray(state.fragments) ||
    state.fragments.length > 512 ||
    !offset(state.bytes) ||
    state.bytes > 65536 ||
    !offset(state.cursor) ||
    state.cursor > state.fragments.length ||
    typeof state.blocked !== "boolean"
  )
    return false
  let bytes = 0
  const ids = new Set<string>()
  for (const [index, value] of state.fragments.entries()) {
    const item = object(value)
    if (
      !item ||
      !identity(item.id) ||
      ids.has(item.id) ||
      !["user", "assistant"].includes(String(item.speaker)) ||
      typeof item.text !== "string" ||
      !offset(item.start) ||
      !offset(item.end) ||
      item.end < item.start ||
      item.sequence !== index + 1 ||
      (item.client !== undefined && !identity(item.client))
    )
      return false
    bytes += Buffer.byteLength(item.text, "utf8")
    ids.add(item.id)
  }
  return bytes === state.bytes
}

export function receive(state: State, kind: string, value: Record<string, unknown>) {
  const id = value.event_id
  if (!identity(id) || state.blocked) return false
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, value]))
    .digest("hex")
  const key = createHash("sha256").update(id).digest("hex")
  const prior = state.events[key]
  if (prior) return prior === hash
  if (Object.keys(state.events).length >= 1024) return block(state)
  if (kind === "session.delegation.created") {
    const delegation = object(value.delegation)
    if (
      !delegation ||
      !identity(delegation.id) ||
      delegation.type !== "delegation" ||
      delegation.target !== "client" ||
      !offset(value.offset_ms)
    )
      return block(state)
    state.events[key] = hash
    return true
  }
  if (!["transcript.input.delta", "transcript.output.delta"].includes(kind)) return false
  if (
    typeof value.delta !== "string" ||
    !offset(value.start_ms) ||
    !offset(value.end_ms) ||
    value.end_ms < value.start_ms ||
    (value.client_event_id !== undefined && !identity(value.client_event_id))
  )
    return block(state)
  const bytes = Buffer.byteLength(value.delta, "utf8")
  if (bytes > 16384 || state.bytes + bytes > 65536 || state.fragments.length >= 512) return block(state)
  state.events[key] = hash
  state.fragments.push({
    id,
    speaker: kind === "transcript.input.delta" ? "user" : "assistant",
    text: value.delta,
    start: value.start_ms,
    end: value.end_ms,
    sequence: state.fragments.length + 1,
    ...(typeof value.client_event_id === "string" ? { client: value.client_event_id } : {}),
  })
  state.bytes += bytes
  return true
}

export function select(state: State, id: string, at: number): (typeof LiveCall.Type)["context"] | undefined {
  if (state.blocked || !identity(id) || !offset(at)) return
  const available = state.fragments.filter((item) => item.start <= at)
  const fresh = available.filter(
    (item) => item.speaker === "user" && !item.client && item.sequence > state.cursor && item.text.trim(),
  )
  if (!fresh.length) return
  const result = {
    version: 1 as const,
    delegation: id,
    offset: at,
    fragments: [] as Fragment[],
    incomplete: true as const,
    omitted: false,
  }
  for (const item of available.slice(-32).reverse()) {
    const next = { ...result, fragments: [item, ...result.fragments] }
    if (JSON.stringify(next).length > 6000) break
    result.fragments.unshift({ ...item })
  }
  if (!result.fragments.some((item) => fresh.some((value) => value.id === item.id))) return
  result.omitted = result.fragments.length !== available.length
  state.cursor = Math.max(...fresh.map((item) => item.sequence))
  return result
}

export function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value)
}
export function object(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}
export function offset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86400000
}
function block(state: State) {
  state.blocked = true
  return false
}
