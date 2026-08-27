// raya_change - Authoritative transcript, overlap, interruption, and sequence-gap coverage.
import { describe, expect, it } from "bun:test"
import { VoiceReconstructor } from "../../src/kilocode/voice/reconstructor"

const at = new Date(0).toISOString()

describe("Raya voice turn reconstruction", () => {
  it("rehydrates persisted transcript truth after backend restart", () => {
    const first = new VoiceReconstructor()
    first.ingest(1, {
      seq: 1,
      type: "transcript.input.done",
      item: "user-1",
      text: "persist me",
      stable: true,
      at,
    })
    const restored = new VoiceReconstructor(first.state())
    expect(restored.state()).toEqual(first.state())
    restored.ingest(2, {
      seq: 2,
      type: "transcript.output.done",
      item: "assistant-1",
      text: "restored",
      stable: true,
      at,
    })
    expect(restored.state().lastSeq).toBe(2)
    expect(restored.state().turns).toHaveLength(2)
  })

  it("keeps speculative text separate from authoritative text", () => {
    const voice = new VoiceReconstructor()
    voice.ingest(1, { seq: 1, type: "transcript.input.delta", item: "user-1", text: "hel", at })
    expect(voice.state().turns[0]).toMatchObject({ speculative: "hel", stable: false })
    voice.ingest(2, { seq: 2, type: "transcript.input.done", item: "user-1", text: "hello", stable: true, at })
    expect(voice.state().turns[0]).toMatchObject({
      speculative: "hello",
      authoritative: "hello",
      stable: true,
    })
  })

  it("marks interrupted output and sequence gaps as incomplete", () => {
    const voice = new VoiceReconstructor()
    voice.ingest(1, { seq: 1, type: "transcript.output.delta", item: "assistant-1", text: "The answer is", at })
    voice.ingest(3, { seq: 3, type: "response.interrupted", heardMs: 420, at })
    expect(voice.state()).toMatchObject({
      incomplete: true,
      turns: [{ id: "assistant-1", truncated: true, heardMs: 420, stable: false }],
    })
  })

  it("records overlapping user and assistant speech", () => {
    const voice = new VoiceReconstructor()
    voice.ingest(1, { seq: 1, type: "transcript.output.delta", item: "assistant-1", text: "Speaking", at })
    voice.ingest(2, { seq: 2, type: "transcript.input.delta", item: "user-1", text: "Stop", at })
    expect(voice.state().turns[1]?.overlap).toBe(true)
  })
})
