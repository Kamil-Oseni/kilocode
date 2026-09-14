import { describe, expect, test } from "bun:test"
import { pricing, transcriptionAllowance } from "@/kilocode/voice/openai-usage"

describe("OpenAI voice pricing", () => {
  test("prices a complete multimodal GPT Realtime receipt with cached tokens separated", () => {
    const result = pricing({
      id: "response_1",
      kind: "response",
      model: "gpt-realtime-2.1",
      status: "reported",
      tokens: {
        input: 1_000_000,
        output: 1_000_000,
        total: 2_000_000,
        cached: 300_000,
        inputText: 400_000,
        inputAudio: 500_000,
        inputImage: 100_000,
        cachedText: 100_000,
        cachedAudio: 150_000,
        cachedImage: 50_000,
        outputText: 400_000,
        outputAudio: 600_000,
      },
    })

    expect(result).toEqual({
      coverage: "recorded",
      amount: 60.775,
      currency: "USD",
      quantity: 2_000_000,
      unit: "tokens",
      source: "openai-model-doc:2026-09-14",
    })
  })

  test("prices GPT Live Transcribe from reported audio duration", () => {
    expect(
      pricing({
        id: "transcription_1",
        kind: "transcription",
        model: "gpt-live-transcribe",
        status: "reported",
        seconds: 90,
      }),
    ).toEqual({
      coverage: "recorded",
      amount: 0.0255,
      currency: "USD",
      quantity: 90,
      unit: "seconds",
      source: "openai-model-doc:gpt-live-transcribe:2026-09-14",
    })
  })

  test("derives a stable whole-second transcription allowance from the same rate", () => {
    expect(transcriptionAllowance(0.6)).toBe(2117)
    expect(transcriptionAllowance((0.017 / 60) * 6)).toBe(6)
    expect(transcriptionAllowance(100)).toBe(86_400)
  })

  test("does not price missing, invalid, or incomplete modality reports as zero", () => {
    const missing = pricing({
      id: "missing_1",
      kind: "response",
      model: "gpt-realtime-2.1",
      status: "missing",
    })
    const partial = pricing({
      id: "partial_1",
      kind: "response",
      model: "gpt-realtime-2.1",
      status: "reported",
      tokens: { input: 10, output: 2, total: 12 },
    })
    const duration = pricing({
      id: "duration_1",
      kind: "transcription",
      model: "gpt-live-transcribe",
      status: "reported",
    })

    expect(missing.coverage).toBe("unknown")
    expect(partial).toMatchObject({ coverage: "unknown", quantity: 12, unit: "tokens" })
    expect(duration.coverage).toBe("unknown")
    expect("amount" in missing).toBe(false)
    expect("amount" in partial).toBe(false)
    expect("amount" in duration).toBe(false)
  })
})
