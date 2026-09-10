import type { VoiceUsage } from "../shared/voice-usage"

type Receipt = {
  id: string
  kind: "response" | "transcription"
  model: "gpt-realtime-2.1" | "gpt-live-transcribe"
  status: "reported" | "missing" | "invalid"
  seconds?: number
  tokens?: {
    input: number
    output: number
    total: number
    cached?: number
    inputText?: number
    inputAudio?: number
    inputImage?: number
    cachedText?: number
    cachedAudio?: number
    cachedImage?: number
    outputText?: number
    outputAudio?: number
  }
}

/** Observed provider receipts, not an invoice, elapsed-time estimate or spend ceiling. */
export class OpenAIUsage {
  private records = new Map<string, Receipt>()
  private queue: Receipt[] = []
  private writing = false
  private pending = new Set<string>()
  private state: VoiceUsage = {
    responses: 0,
    transcriptions: 0,
    input: 0,
    output: 0,
    missing: 0,
    invalid: 0,
    recorded: 0,
    unrecorded: 0,
    pending: 0,
    incomplete: false,
  }

  constructor(
    private readonly signal: AbortSignal,
    private readonly write: (receipt: Receipt) => Promise<Record<string, unknown>>,
    private readonly notify: (state: VoiceUsage) => void,
  ) {
    signal.addEventListener(
      "abort",
      () => {
        this.queue = []
        this.state.incomplete ||= this.state.unrecorded > 0 || this.pending.size > 0
        this.publish()
      },
      { once: true },
    )
  }

  receive(event: Record<string, unknown>) {
    if (this.signal.aborted) return
    if (event.type === "response.created" || event.type === "input_audio_buffer.committed") {
      return this.track(event)
    }
    const response = event.type === "response.done"
    const transcription = [
      "conversation.item.input_audio_transcription.completed",
      "conversation.item.input_audio_transcription.failed",
    ].includes(String(event.type))
    if (!response && !transcription) return
    const value = response ? object(event.response) : event
    const id = response ? value?.id : event.item_id
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !value) {
      this.state.incomplete = true
      return this.publish()
    }
    const receipt: Receipt = {
      id,
      kind: response ? "response" : "transcription",
      model: response ? "gpt-realtime-2.1" : "gpt-live-transcribe",
      ...usage(value.usage, transcription),
    }
    const key = `${receipt.kind}:${id}`
    this.pending.delete(key)
    const prior = this.records.get(key)
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(receipt)) {
        this.state.incomplete = true
        this.publish()
      }
      return
    }
    if (this.records.size >= 512) {
      this.state.incomplete = true
      return this.publish()
    }
    this.records.set(key, receipt)
    this.accumulate(receipt)
    this.queue.push(receipt)
    this.publish()
    void this.drain()
  }

  private track(event: Record<string, unknown>) {
    const response = event.type === "response.created"
    const value = response ? object(event.response)?.id : event.item_id
    if (typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && this.pending.size < 512) {
      const key = `${response ? "response" : "transcription"}:${value}`
      if (!this.records.has(key)) this.pending.add(key)
    } else this.state.incomplete = true
    this.publish()
  }

  private accumulate(receipt: Receipt) {
    this.state.responses += Number(receipt.kind === "response")
    this.state.transcriptions += Number(receipt.kind === "transcription")
    this.state.missing += Number(receipt.status === "missing")
    this.state.invalid += Number(receipt.status === "invalid")
    this.state.input += receipt.tokens?.input ?? 0
    this.state.output += receipt.tokens?.output ?? 0
    if (receipt.seconds !== undefined) {
      this.state.seconds = (this.state.seconds ?? 0) + receipt.seconds
      this.state.durations = (this.state.durations ?? 0) + 1
    }
    this.state.unrecorded++
  }

  private publish() {
    this.state.pending = this.pending.size
    try {
      this.notify({ ...this.state })
    } catch {
      this.state.incomplete = true
      console.error("[Raya] Voice usage display notification failed.")
    }
  }

  private async drain() {
    if (this.writing) return
    this.writing = true
    try {
      while (!this.signal.aborted && this.queue.length) {
        const receipt = this.queue.shift()!
        const result = await this.write(receipt).catch(() => undefined)
        if (result && matches(result, receipt)) {
          this.state.recorded++
          this.state.unrecorded--
        }
        if (!result || !matches(result, receipt)) this.state.incomplete = true
        this.publish()
      }
    } finally {
      this.writing = false
    }
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000
}

function usage(value: unknown, transcription: boolean): Pick<Receipt, "status" | "tokens" | "seconds"> {
  if (value === undefined || value === null) return { status: "missing" }
  const data = object(value)
  if (data?.type === "duration") {
    return duration(data.seconds, transcription)
  }
  if (
    !data ||
    !count(data.input_tokens) ||
    !count(data.output_tokens) ||
    !count(data.total_tokens) ||
    data.input_tokens + data.output_tokens !== data.total_tokens
  )
    return { status: "invalid" }
  const tokens: NonNullable<Receipt["tokens"]> = {
    input: data.input_tokens,
    output: data.output_tokens,
    total: data.total_tokens,
  }
  if (!details(data, tokens) || !consistent(tokens)) return { status: "invalid" }
  return { status: "reported", tokens }
}

function duration(seconds: unknown, transcription: boolean): Pick<Receipt, "status" | "seconds"> {
  return transcription && typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400
    ? { status: "reported", seconds }
    : { status: "invalid" }
}

function details(data: Record<string, unknown>, tokens: NonNullable<Receipt["tokens"]>) {
  const input = object(data.input_token_details)
  const output = object(data.output_token_details)
  const cached = object(input?.cached_tokens_details)
  if (
    (data.input_token_details !== undefined && !input) ||
    (data.output_token_details !== undefined && !output) ||
    (input?.cached_tokens_details !== undefined && !cached)
  )
    return false
  return breakdown(tokens, input, output, cached)
}

function breakdown(
  tokens: NonNullable<Receipt["tokens"]>,
  input?: Record<string, unknown>,
  output?: Record<string, unknown>,
  cached?: Record<string, unknown>,
) {
  const fields = [
    ["cached", input?.cached_tokens],
    ["inputText", input?.text_tokens],
    ["inputAudio", input?.audio_tokens],
    ["inputImage", input?.image_tokens],
    ["cachedText", cached?.text_tokens],
    ["cachedAudio", cached?.audio_tokens],
    ["cachedImage", cached?.image_tokens],
    ["outputText", output?.text_tokens],
    ["outputAudio", output?.audio_tokens],
  ] as const
  for (const [key, value] of fields) {
    if (value === undefined) continue
    if (!count(value)) return false
    tokens[key] = value
  }
  return true
}

function consistent(tokens: NonNullable<Receipt["tokens"]>) {
  if (
    (tokens.cached ?? 0) > tokens.input ||
    (tokens.inputText ?? 0) + (tokens.inputAudio ?? 0) + (tokens.inputImage ?? 0) > tokens.input ||
    (tokens.outputText ?? 0) + (tokens.outputAudio ?? 0) > tokens.output ||
    (tokens.cachedText ?? 0) + (tokens.cachedAudio ?? 0) + (tokens.cachedImage ?? 0) >
      (tokens.cached ?? tokens.input) ||
    (["Text", "Audio", "Image"] as const).some(
      (kind) =>
        tokens[`cached${kind}`] !== undefined &&
        tokens[`input${kind}`] !== undefined &&
        tokens[`cached${kind}`]! > tokens[`input${kind}`]!,
    )
  )
    return false
  return true
}

function matches(value: Record<string, unknown>, receipt: Receipt) {
  if (
    value.id !== receipt.id ||
    value.kind !== receipt.kind ||
    value.model !== receipt.model ||
    value.status !== receipt.status
  )
    return false
  if (value.seconds !== receipt.seconds) return false
  if (!receipt.tokens) return value.tokens === undefined
  const tokens = object(value.tokens)
  return (
    !!tokens &&
    Object.keys(tokens).length === Object.keys(receipt.tokens).length &&
    Object.entries(receipt.tokens).every(([key, value]) => tokens[key] === value)
  )
}
