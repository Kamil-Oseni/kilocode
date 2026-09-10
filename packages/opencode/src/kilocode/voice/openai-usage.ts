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
export const OpenAIUsageInput = Schema.Struct({ generation: VoiceID, receipt: OpenAIUsage })
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
