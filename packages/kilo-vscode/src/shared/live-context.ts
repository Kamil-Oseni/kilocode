type Fragment = {
  id: string
  speaker: "user" | "assistant"
  text: string
  start: number
  end: number
  sequence: number
  client?: string
}
type Selection = {
  version: 1
  delegation: string
  offset: number
  fragments: Fragment[]
  incomplete: boolean
  omitted: boolean
}
type Delegation = { offset: number; selection?: Selection }

/** Captions are generated/transcribed text, never proof of heard audio or complete turns. */
export class LiveContext {
  private fragments: Fragment[] = []
  private events = new Map<string, string>()
  private delegations = new Map<string, Delegation>()
  private incomplete = false
  private limited = false
  private bytes = 0
  private sequence = 0
  private consumed = 0

  receive(value: unknown): "ignored" | "transcript" | "delegation" | "invalid" | "limit" {
    if (!record(value)) return "ignored"
    const kind =
      value.type === "session.input_transcript.delta" || value.type === "session.output_transcript.delta"
        ? "transcript"
        : value.type === "session.delegation.created"
          ? "delegation"
          : "ignored"
    if (kind === "ignored") return "ignored"
    if (this.limited) return "limit"
    if (!id(value.event_id) || (value.client_event_id !== undefined && !id(value.client_event_id)))
      return this.invalid()
    return kind === "transcript" ? this.append(value) : this.created(value)
  }

  snapshot() {
    return {
      fragments: this.fragments.map((fragment) => ({ ...fragment })),
      incomplete: this.incomplete,
      limited: this.limited,
    }
  }

  /** Explicit transport gaps invalidate automatic delegation; absence of events does not prove a gap. */
  gap() {
    this.incomplete = true
  }

  select(id: string): Selection | undefined {
    const delegation = this.delegations.get(id)
    if (!delegation || this.incomplete || this.limited) return undefined
    if (delegation.selection) return structuredClone(delegation.selection)
    const available = this.fragments.filter((fragment) => fragment.start <= delegation.offset)
    const fresh = available.filter(
      (fragment) =>
        fragment.speaker === "user" && !fragment.client && fragment.sequence > this.consumed && fragment.text.trim(),
    )
    if (!fresh.length) return undefined
    const selection: Selection = {
      version: 1,
      delegation: id,
      offset: delegation.offset,
      fragments: [],
      incomplete: true,
      omitted: false,
    }
    for (const fragment of available.slice(-32).reverse()) {
      const candidate = { ...selection, fragments: [fragment, ...selection.fragments] }
      if (JSON.stringify(candidate).length > 6000) {
        selection.omitted = true
        break
      }
      selection.fragments.unshift({ ...fragment })
    }
    if (!selection.fragments.some((fragment) => fresh.some((item) => item.id === fragment.id))) return undefined
    selection.omitted ||= selection.fragments.length !== available.length
    // A provider timestamp is not a completeness watermark. Preserve that uncertainty in every request.
    delegation.selection = selection
    this.consumed = Math.max(...fresh.map((fragment) => fragment.sequence))
    return structuredClone(selection)
  }

  private retain(id: string, fingerprint: string, extra: boolean) {
    const prior = this.events.get(id)
    if (prior !== undefined) return prior === fingerprint ? ("ignored" as const) : this.invalid()
    if (this.events.size >= 4224 || extra) return this.limit()
    this.events.set(id, fingerprint)
    return undefined
  }

  private append(value: Record<string, unknown>): "ignored" | "transcript" | "invalid" | "limit" {
    const eventID = value.event_id
    const start = value.start_ms
    const end = value.end_ms
    if (typeof value.delta !== "string" || !id(eventID) || !offset(start) || !offset(end) || end < start)
      return this.invalid()
    const bytes = new TextEncoder().encode(value.delta).length
    if (bytes > 16384) return this.limit()
    const fingerprint = JSON.stringify([
      value.type,
      eventID,
      value.delta,
      start,
      end,
      value.client_event_id ?? null,
    ])
    const blocked = this.retain(eventID, fingerprint, this.bytes + bytes > 262144)
    if (blocked) return blocked
    if (this.fragments.length >= 4096 || this.bytes + bytes > 262144) return this.limit()
    this.bytes += bytes
    this.fragments.push({
      id: eventID,
      speaker: value.type === "session.input_transcript.delta" ? "user" : "assistant",
      text: value.delta,
      start,
      end,
      sequence: ++this.sequence,
      ...(typeof value.client_event_id === "string" ? { client: value.client_event_id } : {}),
    })
    return "transcript"
  }

  private created(value: Record<string, unknown>): "ignored" | "delegation" | "invalid" | "limit" {
    const eventID = value.event_id
    const delegation = record(value.delegation) ? value.delegation : undefined
    if (
      !id(eventID) ||
      !offset(value.offset_ms) ||
      !delegation ||
      !id(delegation.id) ||
      delegation.type !== "delegation" ||
      !["client", "responses"].includes(String(delegation.target))
    )
      return this.invalid()
    const fingerprint = JSON.stringify([
      value.type,
      eventID,
      value.offset_ms,
      delegation.id,
      delegation.target,
      value.client_event_id ?? null,
    ])
    const blocked = this.retain(eventID, fingerprint, false)
    if (blocked) return blocked
    return this.delegate(value)
  }

  private delegate(value: Record<string, unknown>): "delegation" | "invalid" | "limit" | "ignored" {
    const delegation = value.delegation
    if (
      !offset(value.offset_ms) ||
      !record(delegation) ||
      !id(delegation.id) ||
      delegation.type !== "delegation" ||
      !["client", "responses"].includes(String(delegation.target))
    )
      return this.invalid()
    if (delegation.target !== "client") return "ignored"
    const prior = this.delegations.get(delegation.id)
    if (prior) return prior.offset === value.offset_ms ? "ignored" : this.invalid()
    if (this.delegations.size >= 128) return this.limit()
    this.delegations.set(delegation.id, { offset: value.offset_ms })
    return "delegation"
  }

  private invalid(): "invalid" {
    this.incomplete = true
    return "invalid"
  }
  private limit(): "limit" {
    this.limited = true
    this.incomplete = true
    return "limit"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}
function offset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
