import { Schema } from "effect"
import { VoiceID } from "./openai-protocol"

const count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000_000),
)
export const OpenAIUsage = Schema.Struct({
  id: VoiceID,
  kind: Schema.Literals(["response", "transcription"]),
  model: Schema.Literals(["gpt-realtime-2.1", "gpt-live-transcribe"]),
  status: Schema.Literals(["reported", "missing", "invalid"]),
  seconds: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(86400))),
  tokens: Schema.optional(
    Schema.Struct({
      input: count,
      output: count,
      total: count,
      cached: Schema.optional(count),
      inputText: Schema.optional(count),
      inputAudio: Schema.optional(count),
      inputImage: Schema.optional(count),
      cachedText: Schema.optional(count),
      cachedAudio: Schema.optional(count),
      cachedImage: Schema.optional(count),
      outputText: Schema.optional(count),
      outputAudio: Schema.optional(count),
    }),
  ),
}).annotate({ identifier: "OpenAIVoiceUsage" })
export const OpenAIUsageInput = Schema.Struct({
  generation: VoiceID,
  receipt: OpenAIUsage,
  reservationID: Schema.optional(VoiceID),
})
export const OpenAIUsageState = Schema.Struct({
  receipts: Schema.Array(OpenAIUsage).check(Schema.isMaxLength(512)),
}).annotate({ identifier: "OpenAIVoiceUsageState" })

export function valid(receipt: typeof OpenAIUsage.Type) {
  if (!Schema.is(OpenAIUsage)(receipt)) return false
  if (receipt.model !== (receipt.kind === "response" ? "gpt-realtime-2.1" : "gpt-live-transcribe")) return false
  const tokens = receipt.tokens
  if (receipt.status !== "reported") return tokens === undefined && receipt.seconds === undefined
  if (receipt.seconds !== undefined) return receipt.kind === "transcription" && tokens === undefined
  if (!tokens || tokens.total !== tokens.input + tokens.output) return false
  if ((tokens.cached ?? 0) > tokens.input) return false
  if ((tokens.inputText ?? 0) + (tokens.inputAudio ?? 0) + (tokens.inputImage ?? 0) > tokens.input) return false
  if ((tokens.outputText ?? 0) + (tokens.outputAudio ?? 0) > tokens.output) return false
  if (
    (tokens.cachedText ?? 0) + (tokens.cachedAudio ?? 0) + (tokens.cachedImage ?? 0) >
    (tokens.cached ?? tokens.input)
  )
    return false
  return !(["Text", "Audio", "Image"] as const).some((kind) => {
    const cached = tokens[`cached${kind}`]
    const input = tokens[`input${kind}`]
    return cached !== undefined && input !== undefined && cached > input
  })
}

export function fingerprint(receipt: typeof OpenAIUsage.Type) {
  return JSON.stringify([
    receipt.id,
    receipt.kind,
    receipt.model,
    receipt.status,
    receipt.seconds,
    Object.entries(receipt.tokens ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ])
}

const rates = {
  model: "gpt-realtime-2.1",
  version: "openai-model-doc:2026-09-14",
  currency: "USD",
  per: 1_000_000,
  input: { text: 4, audio: 32, image: 5 },
  cached: { text: 0.4, audio: 0.4, image: 0.5 },
  output: { text: 24, audio: 64 },
} as const

export type OpenAIPricing =
  | {
      coverage: "recorded"
      amount: number
      currency: "USD"
      quantity: number
      unit: "tokens" | "seconds"
      source: string
    }
  | {
      coverage: "unknown"
      quantity?: number
      unit?: "tokens" | "seconds"
      source: string
      reason: string
    }

/** Versioned estimate from the exact provider receipt. It is unknown unless every priced modality is attributable. */
export function pricing(receipt: typeof OpenAIUsage.Type): OpenAIPricing {
  if (!valid(receipt))
    return {
      coverage: "unknown",
      source: rates.version,
      reason: "The provider voice usage receipt is invalid.",
    }
  if (receipt.status !== "reported")
    return {
      coverage: "unknown",
      source: rates.version,
      reason: "The provider did not report valid usage for this voice operation.",
    }
  if (receipt.kind === "transcription") {
    if (receipt.seconds === undefined)
      return {
        coverage: "unknown",
        source: rates.version,
        reason: "GPT Live Transcribe did not report its billed audio duration.",
      }
    return {
      coverage: "recorded",
      amount: (receipt.seconds / 60) * 0.017,
      currency: rates.currency,
      quantity: receipt.seconds,
      unit: "seconds",
      source: "openai-model-doc:gpt-live-transcribe:2026-09-14",
    }
  }
  const tokens = receipt.tokens
  if (
    !tokens ||
    tokens.inputText === undefined ||
    tokens.inputAudio === undefined ||
    tokens.inputImage === undefined ||
    tokens.outputText === undefined ||
    tokens.outputAudio === undefined ||
    tokens.cached === undefined ||
    tokens.cachedText === undefined ||
    tokens.cachedAudio === undefined ||
    tokens.cachedImage === undefined ||
    tokens.inputText + tokens.inputAudio + tokens.inputImage !== tokens.input ||
    tokens.outputText + tokens.outputAudio !== tokens.output ||
    tokens.cachedText + tokens.cachedAudio + tokens.cachedImage !== tokens.cached
  )
    return {
      coverage: "unknown",
      quantity: tokens?.total,
      unit: tokens ? "tokens" : undefined,
      source: rates.version,
      reason: "The provider usage receipt does not fully attribute text, audio, image, cached, and output tokens.",
    }
  const amount =
    ((tokens.inputText - tokens.cachedText) * rates.input.text +
      (tokens.inputAudio - tokens.cachedAudio) * rates.input.audio +
      (tokens.inputImage - tokens.cachedImage) * rates.input.image +
      tokens.cachedText * rates.cached.text +
      tokens.cachedAudio * rates.cached.audio +
      tokens.cachedImage * rates.cached.image +
      tokens.outputText * rates.output.text +
      tokens.outputAudio * rates.output.audio) /
    rates.per
  return {
    coverage: "recorded",
    amount,
    currency: rates.currency,
    quantity: tokens.total,
    unit: "tokens",
    source: rates.version,
  }
}
