import type { RealtimeTranscript } from "./realtime-voice"

type Packet = Record<string, unknown> & { type: string }
type Entry = RealtimeTranscript & { direction: "input" | "output"; sequence: number; content: number }
type Response = { interrupted?: boolean; generation?: RealtimeTranscript["generation"] }
const kinds = {
  "conversation.item.input_audio_transcription.delta": ["input", false, "delta"],
  "conversation.item.input_audio_transcription.completed": ["input", true, "transcript"],
  "response.output_audio_transcript.delta": ["output", false, "delta"],
  "response.output_audio_transcript.done": ["output", true, "transcript"],
} as const

/** Display-only projection. Provider audio offsets cannot be translated into heard words. */
export class NativeProjection {
  private entries = new Map<string, Entry>()
  private responses = new Map<string, Response>()
  private events = new Set<string>()
  private selected: Entry | undefined
  private sequence = 0
  private limited = false

  receive(packet: Packet): RealtimeTranscript | undefined {
    if (this.limited) return
    if (packet.type === "conversation.item.truncated") return this.truncate(packet)
    if (packet.type === "response.done") return this.complete(packet)
    if (packet.type === "output_audio_buffer.cleared") return this.interrupt(packet.response_id)
    if (!Object.hasOwn(kinds, packet.type)) return
    return this.transcript(packet)
  }

  interrupt(id: unknown): RealtimeTranscript | undefined {
    if (this.limited || !identifier(id)) return
    const response = this.responses.get(id) ?? {}
    response.interrupted = true
    this.responses.set(id, response)
    for (const entry of this.entries.values()) {
      if (entry.direction !== "output" || entry.turn !== id) continue
      this.hide(entry)
    }
    if (this.responses.size > 256) return this.limit()
    return this.selected?.turn === id ? { ...this.selected } : undefined
  }

  private transcript(packet: Packet): RealtimeTranscript | undefined {
    const input = transcription(packet)
    if (!input || this.duplicate(packet)) return
    if (this.events.size > 8192) return this.limit()
    const key = `${input.direction}:${input.item}:${input.content}`
    const prior = this.entries.get(key)
    if (prior?.stable || prior?.interruption) return
    if (prior && prior.turn !== input.turn) return
    const response = input.turn ? this.responses.get(input.turn) : undefined
    const entry = projected(input, prior, response, prior?.sequence ?? ++this.sequence)
    this.entries.set(key, entry)
    if (this.entries.size > 256) return this.limit()
    return entry.sequence ? this.select(entry) : undefined
  }

  private truncate(packet: Packet): RealtimeTranscript | undefined {
    if (!identifier(packet.item_id) || !index(packet.content_index) || !index(packet.audio_end_ms)) return
    const key = `output:${packet.item_id}:${packet.content_index}`
    const prior = this.entries.get(key)
    const entry: Entry = prior ?? {
      type: packet.type,
      item: packet.item_id,
      direction: "output",
      content: packet.content_index,
      sequence: 0,
      text: "",
      stable: false,
    }
    // A completed generation is still revisable by an authoritative playback truncation.
    this.hide(entry)
    entry.interruption = "confirmed"
    entry.audioEndMs = Math.min(entry.audioEndMs ?? packet.audio_end_ms, packet.audio_end_ms)
    this.entries.set(key, entry)
    if (this.entries.size > 256) return this.limit()
    return this.selected === entry ? { ...entry } : undefined
  }

  private complete(packet: Packet): RealtimeTranscript | undefined {
    const response = completion(packet)
    if (!response) return
    const generation = response.generation
    const prior = this.responses.get(response.id) ?? {}
    // A late completed event cannot erase cancellation or interrupted playback.
    if (!prior.generation || prior.generation === "completed") prior.generation = generation
    if (generation !== "completed") prior.interrupted = true
    this.responses.set(response.id, prior)
    for (const entry of this.entries.values()) {
      if (entry.direction !== "output" || entry.turn !== response.id) continue
      entry.generation = prior.generation
      if (prior.interrupted) this.hide(entry)
    }
    if (this.responses.size > 256) return this.limit()
    return this.selected?.turn === response.id ? { ...this.selected } : undefined
  }

  private hide(entry: Entry) {
    entry.text = ""
    entry.interruption ??= "pending"
  }

  private select(entry: Entry) {
    if (this.selected && this.selected.sequence > entry.sequence) return
    this.selected = entry
    return { ...entry }
  }

  private duplicate(packet: Packet) {
    if (!identifier(packet.event_id)) return false
    if (this.events.has(packet.event_id)) return true
    this.events.add(packet.event_id)
    return false
  }

  private limit(): RealtimeTranscript {
    this.limited = true
    this.entries.clear()
    this.responses.clear()
    this.events.clear()
    this.selected = undefined
    return { type: "native.transcript.limit", text: "", stable: false, limited: true, sequence: ++this.sequence }
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value)
}

function index(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function transcription(packet: Packet) {
  const kind = kinds[packet.type as keyof typeof kinds]
  const content = packet.content_index ?? 0
  if (!identifier(packet.item_id) || !index(content)) return
  if (kind[0] === "output" && !identifier(packet.response_id)) return
  const text = packet[kind[2]]
  if (typeof text !== "string") return
  return {
    type: packet.type,
    item: packet.item_id,
    content,
    direction: kind[0],
    stable: kind[1],
    turn: kind[0] === "output" ? (packet.response_id as string) : undefined,
    text,
  }
}

function completion(packet: Packet) {
  const response = packet.response
  if (!response || typeof response !== "object" || Array.isArray(response)) return
  if (!("id" in response) || !identifier(response.id) || !("status" in response)) return
  const generation = response.status
  if (
    generation !== "completed" &&
    generation !== "cancelled" &&
    generation !== "failed" &&
    generation !== "incomplete"
  )
    return
  return { id: response.id, generation } as const
}

function projected(
  input: NonNullable<ReturnType<typeof transcription>>,
  prior: Entry | undefined,
  response: Response | undefined,
  sequence: number,
): Entry {
  const text = input.stable ? input.text : (prior?.text ?? "") + input.text
  return {
    ...input,
    sequence: response?.interrupted ? 0 : sequence,
    text: response?.interrupted ? "" : text.slice(0, 8192),
    truncated: text.length > 8192 || (!input.stable && prior?.truncated === true),
    generation: response?.generation,
    interruption: response?.interrupted ? "pending" : undefined,
  }
}
