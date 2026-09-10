import { expect, test } from "bun:test"
import { NativeProjection } from "../../webview-ui/src/context/native-projection"

const delta = (item = "item", response = "response", content = 0) => ({
  type: "response.output_audio_transcript.delta",
  item_id: item,
  response_id: response,
  content_index: content,
  delta: "Generated but not necessarily heard",
})
const truncate = (item = "item", content = 0, offset = 1500) => ({
  type: "conversation.item.truncated",
  item_id: item,
  content_index: content,
  audio_end_ms: offset,
})

test("local interruption hides generated text before provider confirmation and cannot be undone by final generation", () => {
  const projection = new NativeProjection()
  const partial = projection.receive(delta())!
  expect(partial.text).toContain("Generated")
  const interrupted = projection.interrupt("response")!
  expect(interrupted).toMatchObject({ text: "", interruption: "pending", sequence: partial.sequence })
  expect(
    projection.receive({ ...delta(), type: "response.output_audio_transcript.done", transcript: "unheard" }),
  ).toBeUndefined()
  expect(
    projection.receive({ type: "response.done", response: { id: "response", status: "completed" } }),
  ).toMatchObject({
    interruption: "pending",
    text: "",
  })
  expect(projection.receive(truncate())).toMatchObject({ text: "", interruption: "confirmed", audioEndMs: 1500 })
  expect(projection.receive(truncate("item", 0, 2000))?.audioEndMs).toBe(1500)
  expect(projection.receive(delta())).toBeUndefined()
})

test("authoritative truncation revises done records and tombstones pre-transcript items by exact content index", () => {
  const projection = new NativeProjection()
  expect(projection.receive(truncate("early"))).toBeUndefined()
  expect(projection.receive(delta("early"))).toBeUndefined()
  expect(projection.receive(delta("early", "response", 1))?.text).toContain("Generated")
  const final = projection.receive({
    ...delta("final"),
    type: "response.output_audio_transcript.done",
    transcript: "Final generated words",
  })!
  expect(final.stable).toBe(true)
  expect(projection.receive(truncate("final"))).toMatchObject({
    interruption: "confirmed",
    text: "",
    sequence: final.sequence,
  })
  expect(
    projection.receive({ ...delta("final"), type: "response.output_audio_transcript.done", transcript: "late final" }),
  ).toBeUndefined()
})

test("old partial completion and truncation do not replace newer input or output selection", () => {
  const projection = new NativeProjection()
  projection.receive(delta("old", "older"))
  const input = projection.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "user",
    transcript: "New user words",
  })!
  expect(projection.interrupt("older")).toBeUndefined()
  expect(projection.receive(truncate("old"))).toBeUndefined()
  expect(projection.receive(delta("old", "older"))).toBeUndefined()
  expect(projection.receive(delta("next", "next_response"))!.sequence).toBeGreaterThan(input.sequence!)
  expect(projection.receive({ type: "response.done", response: { id: "older", status: "cancelled" } })).toBeUndefined()
  expect(projection.receive(delta("late_old_item", "older"))).toBeUndefined()
})

test("response cancellation stays distinct from generation completion and applies to late content", () => {
  const projection = new NativeProjection()
  projection.receive(delta())
  projection.receive({ type: "response.done", response: { id: "response", status: "completed" } })
  expect(
    projection.receive({ type: "response.done", response: { id: "response", status: "cancelled" } }),
  ).toMatchObject({
    text: "",
    generation: "cancelled",
    interruption: "pending",
  })
  expect(
    projection.receive({ type: "response.done", response: { id: "response", status: "completed" } })?.generation,
  ).toBe("cancelled")
  expect(projection.receive({ type: "output_audio_buffer.cleared", response_id: "response" })?.text).toBe("")
  expect(projection.receive(delta("late", "response"))).toBeUndefined()
})

test("invalid truncation cannot suppress text and duplicate events do not duplicate partial text", () => {
  const projection = new NativeProjection()
  expect(projection.receive({ ...delta(), response_id: undefined })).toBeUndefined()
  const packet = { ...delta(), event_id: "event" }
  projection.receive(packet)
  expect(projection.receive(packet)).toBeUndefined()
  for (const offset of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])
    expect(projection.receive({ ...truncate(), audio_end_ms: offset })).toBeUndefined()
  expect(projection.receive({ ...truncate(), content_index: -1 })).toBeUndefined()
  expect(projection.receive({ ...truncate(), item_id: "" })).toBeUndefined()
  expect(projection.receive({ ...delta(), event_id: "next", delta: " tail" })?.text).toBe(packet.delta + " tail")
})

test("display bounds are distinct from interruption and capacity fails closed without resurrecting evicted text", () => {
  const projection = new NativeProjection()
  expect(projection.receive({ ...delta(), delta: "x".repeat(9000) })).toMatchObject({
    truncated: true,
    text: "x".repeat(8192),
  })
  expect(projection.receive(truncate())).toMatchObject({ truncated: true, interruption: "confirmed", text: "" })
  for (let count = 1; count < 256; count++) projection.receive(delta(`item_${count}`, `response_${count}`))
  expect(projection.receive(delta("overflow"))).toMatchObject({ limited: true, text: "" })
  expect(projection.receive(delta())).toBeUndefined()
  expect(projection.receive(delta("new"))).toBeUndefined()
  expect(projection.interrupt("response")).toBeUndefined()
  expect(new NativeProjection().receive(delta())?.text).toContain("Generated")
})

test("response and event correlation bounds also fail closed", () => {
  const responses = new NativeProjection()
  for (let count = 0; count < 256; count++) responses.interrupt(`response_${count}`)
  expect(responses.interrupt("overflow")?.limited).toBe(true)
  const events = new NativeProjection()
  for (let count = 0; count < 8192; count++) events.receive({ ...delta(), delta: "", event_id: `event_${count}` })
  expect(events.receive({ ...delta(), event_id: "overflow" })?.limited).toBe(true)
})

test("failed and incomplete generation retain their terminal reason without claiming a confirmed audio cutoff", () => {
  for (const status of ["failed", "incomplete"]) {
    const projection = new NativeProjection()
    projection.receive(delta())
    expect(projection.receive({ type: "response.done", response: { id: "response", status } })).toMatchObject({
      generation: status,
      interruption: "pending",
      text: "",
    })
    expect(
      projection.receive({ type: "response.done", response: { id: "response", status: "completed" } })?.generation,
    ).toBe(status)
    expect(projection.receive(delta())).toBeUndefined()
  }
})
