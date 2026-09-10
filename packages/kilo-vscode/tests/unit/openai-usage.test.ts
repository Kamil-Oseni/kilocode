import { expect, test } from "bun:test"
import { OpenAIUsage } from "../../src/speech/openai-usage"
import type { VoiceUsage } from "../../src/shared/voice-usage"
import { createVoiceUsage } from "../../webview-ui/src/context/voice-usage"

const report = (id = "response_1") => ({
  type: "response.done",
  response: {
    id,
    status: "cancelled",
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      total_tokens: 15,
      input_token_details: {
        text_tokens: 4,
        audio_tokens: 8,
        cached_tokens: 2,
        cached_tokens_details: { text_tokens: 2, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 1, audio_tokens: 2 },
    },
  },
})

async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error("Usage state did not settle")
    await Bun.sleep(5)
  }
}

test("a failed usage observer cannot interrupt provider handling or receipt persistence", async () => {
  const abort = new AbortController()
  const writes: Record<string, unknown>[] = []
  let latest: VoiceUsage | undefined
  let failed = false
  const meter = new OpenAIUsage(
    abort.signal,
    async (receipt) => {
      writes.push(receipt)
      return receipt
    },
    (state) => {
      if (!failed) {
        failed = true
        throw new Error("Observer unavailable")
      }
      latest = state
    },
  )
  expect(() => meter.receive(report())).not.toThrow()
  await until(() => latest?.recorded === 1)
  expect(writes).toHaveLength(1)
  expect(latest).toMatchObject({ recorded: 1, unrecorded: 0, incomplete: true })
  abort.abort()
})

test("provider usage includes cancelled responses and separate transcription, without double counting cached or duplicate tokens", async () => {
  const abort = new AbortController()
  const writes: Record<string, unknown>[] = []
  let latest: VoiceUsage | undefined
  const meter = new OpenAIUsage(
    abort.signal,
    async (receipt) => {
      writes.push(receipt)
      return { ...receipt, tokens: receipt.tokens && Object.fromEntries(Object.entries(receipt.tokens).reverse()) }
    },
    (state) => (latest = state),
  )
  meter.receive({ type: "response.created", response: { id: "response_1" } })
  expect(latest?.pending).toBe(1)
  meter.receive(report())
  meter.receive(report())
  meter.receive({ type: "response.created", response: { id: "response_1" } })
  meter.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "speech_1",
    transcript: "private speech",
    usage: { type: "tokens", input_tokens: 5, output_tokens: 1, total_tokens: 6 },
  })
  await until(() => latest?.recorded === 2)
  expect(latest).toMatchObject({
    responses: 1,
    transcriptions: 1,
    input: 17,
    output: 4,
    recorded: 2,
    pending: 0,
    incomplete: false,
  })
  expect(writes[0]).toMatchObject({ model: "gpt-realtime-2.1", tokens: { cached: 2, inputAudio: 8, outputAudio: 2 } })
  expect(writes[1]).toMatchObject({ model: "gpt-live-transcribe" })
  expect(JSON.stringify(writes)).not.toContain("private speech")
  abort.abort()
})

test("missing, inconsistent, conflicting and unsupported usage remains visibly incomplete", async () => {
  const abort = new AbortController()
  let latest: VoiceUsage | undefined
  const meter = new OpenAIUsage(
    abort.signal,
    async (receipt) => receipt,
    (state) => (latest = state),
  )
  meter.receive(report())
  meter.receive({ type: "response.done", response: { id: "missing" } })
  meter.receive({
    type: "response.done",
    response: { id: "invalid", usage: { input_tokens: 2, output_tokens: 2, total_tokens: 1 } },
  })
  meter.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "duration",
    usage: { type: "duration", seconds: -2 },
  })
  const conflict = report()
  conflict.response.usage.output_tokens = 4
  conflict.response.usage.total_tokens = 16
  meter.receive(conflict)
  await until(() => latest?.recorded === 4)
  expect(latest).toMatchObject({
    responses: 3,
    transcriptions: 1,
    input: 12,
    output: 3,
    missing: 1,
    invalid: 2,
    incomplete: true,
  })
  abort.abort()
})

test("persistence failure never retries and abort prevents queued writes without hiding missing receipts", async () => {
  const abort = new AbortController()
  const pending = Promise.withResolvers<Record<string, unknown>>()
  let writes = 0
  let latest: VoiceUsage | undefined
  const meter = new OpenAIUsage(
    abort.signal,
    async () => {
      writes++
      return pending.promise
    },
    (state) => (latest = state),
  )
  meter.receive(report("one"))
  meter.receive(report("two"))
  meter.receive({ type: "response.created", response: { id: "three" } })
  abort.abort()
  pending.resolve({ id: "wrong" })
  await Bun.sleep(10)
  expect(writes).toBe(1)
  expect(latest).toMatchObject({ responses: 2, recorded: 0, unrecorded: 2, pending: 1, incomplete: true })
  meter.receive(report("late"))
  expect(latest?.responses).toBe(2)
})

test("usage display follows its exact connection and parent, including retained end-of-call counts", () => {
  let session = "parent"
  const usage = createVoiceUsage(() => session)
  const value: VoiceUsage = {
    responses: 1,
    transcriptions: 0,
    input: 12,
    output: 3,
    missing: 0,
    invalid: 0,
    recorded: 1,
    unrecorded: 0,
    pending: 0,
    incomplete: false,
  }
  usage.bind("call", session)
  usage.receive({ type: "speechOpenAIUsage", requestId: "foreign", sessionID: session, usage: value })
  expect(usage.state()).toBeUndefined()
  usage.receive({ type: "speechOpenAIUsage", requestId: "call", sessionID: session, usage: value })
  expect(usage.state()).toEqual(value)
  session = "other"
  expect(usage.state()).toBeUndefined()
  usage.bind("new", session)
  usage.receive({ type: "speechOpenAIUsage", requestId: "call", sessionID: "parent", usage: value })
  expect(usage.state()).toBeUndefined()
})

test("duration-based transcription preserves provider seconds without inventing token counts", async () => {
  const abort = new AbortController()
  const writes: Record<string, unknown>[] = []
  let latest: VoiceUsage | undefined
  const meter = new OpenAIUsage(
    abort.signal,
    async (receipt) => {
      writes.push(receipt)
      return receipt
    },
    (state) => (latest = state),
  )
  meter.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "duration",
    usage: { type: "duration", seconds: 2.75 },
  })
  await until(() => latest?.recorded === 1)
  expect(latest).toMatchObject({ input: 0, output: 0, seconds: 2.75, durations: 1, invalid: 0, missing: 0 })
  expect(writes).toEqual([
    { id: "duration", kind: "transcription", model: "gpt-live-transcribe", status: "reported", seconds: 2.75 },
  ])
  abort.abort()
})
