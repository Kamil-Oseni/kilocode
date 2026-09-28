import { expect, test } from "bun:test"
import { OpenAITranscript } from "../../src/speech/openai-transcript"

function fixture() {
  const snapshots: Parameters<ConstructorParameters<typeof OpenAITranscript>[0]>[0][] = []
  const collector = new OpenAITranscript(async (snapshot) => {
    snapshots.push(snapshot)
  })
  return { collector, snapshots, latest: () => snapshots.at(-1)! }
}

function link(id: string, previous: string | null, role = "user") {
  return { type: "conversation.item.added", previous_item_id: previous, item: { id, type: "message", role } }
}
function final(id: string, text: string) {
  return {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: id,
    content_index: 0,
    transcript: text,
  }
}

test("final transcription arrival does not reorder the provider item chain", async () => {
  const f = fixture()
  f.collector.receive(final("second", "Second spoken turn"))
  f.collector.receive(link("first", null))
  f.collector.receive(link("second", "first"))
  f.collector.receive(final("first", "First spoken turn"))
  await f.collector.flush()
  expect(f.latest().items).toEqual([
    { id: "first", previous: null, role: "user", state: "final", text: "First spoken turn" },
    { id: "second", previous: "first", role: "user", state: "final", text: "Second spoken turn" },
  ])
  const count = f.snapshots.length
  f.collector.receive(final("first", "First spoken turn"))
  await f.collector.flush()
  expect(f.snapshots).toHaveLength(count)
})

test("generation alone never makes assistant text final and later truncation is irreversible", async () => {
  const f = fixture()
  f.collector.receive(link("assistant", null, "assistant"))
  f.collector.receive({
    type: "response.output_audio_transcript.done",
    item_id: "assistant",
    response_id: "response",
    transcript: "Generated words",
  })
  f.collector.receive({ type: "response.done", response: { id: "response", status: "completed" } })
  await f.collector.flush()
  expect(f.latest().items[0]).toEqual({ id: "assistant", previous: null, role: "assistant", state: "pending" })
  f.collector.receive({ type: "output_audio_buffer.started", response_id: "response" })
  f.collector.receive({ type: "output_audio_buffer.stopped", response_id: "response" })
  await f.collector.flush()
  expect(f.latest().items[0]?.state).toBe("final")
  f.collector.receive({
    type: "conversation.item.truncated",
    item_id: "assistant",
    content_index: 0,
    audio_end_ms: 400,
  })
  await f.collector.flush()
  expect(f.latest().items[0]).toEqual({ id: "assistant", previous: null, role: "assistant", state: "omitted" })
  f.collector.receive({
    type: "response.output_audio_transcript.done",
    item_id: "assistant",
    response_id: "response",
    transcript: "Late final",
  })
  f.collector.receive({ type: "response.done", response: { id: "response", status: "completed" } })
  await f.collector.close()
  expect(f.latest().items[0]?.state).toBe("omitted")
  expect(JSON.stringify(f.latest())).not.toContain("Generated words")
})

test("a predecessor arriving after its successor resolves without publishing the successor as a root", async () => {
  const f = fixture()
  f.collector.receive(link("second", "first"))
  f.collector.receive(final("second", "Second"))
  await f.collector.flush()
  expect(f.latest().items).toEqual([])
  expect(f.latest().incomplete).toBe(true)
  f.collector.receive(link("first", null))
  f.collector.receive(final("first", "First"))
  await f.collector.flush()
  expect(f.latest().items.map((item) => item.id)).toEqual(["first", "second"])
})

test("a known synthetic context boundary can bridge live speech without copying historical text", async () => {
  const f = fixture()
  f.collector.ignore("context")
  f.collector.receive({ type: "conversation.item.done", item: { id: "context", type: "message", role: "user" } })
  f.collector.receive(link("live", "context"))
  f.collector.receive(final("live", "Live speech"))
  await f.collector.flush()
  expect(f.latest()).toMatchObject({
    incomplete: true,
    items: [{ id: "live", previous: "context", text: "Live speech" }],
  })
})

test("conflicting event reuse tombstones a finalized user transcript without replacement", async () => {
  const f = fixture()
  f.collector.receive(link("first", null))
  f.collector.receive({ ...final("first", "Original"), event_id: "event" })
  await f.collector.flush()
  f.collector.receive({ ...final("first", "Changed"), event_id: "event" })
  await f.collector.flush()
  expect(f.latest()).toMatchObject({ incomplete: true, items: [{ state: "omitted" }] })
  f.collector.receive(final("first", "Other changed text"))
  await f.collector.flush()
  expect(f.latest().items[0]?.text).toBeUndefined()
})

test("deleted or conflicting finalized user text is terminally omitted", async () => {
  for (const event of [{ type: "conversation.item.deleted", item_id: "first" }, final("first", "Conflicting text")]) {
    const f = fixture()
    f.collector.receive(link("first", null))
    f.collector.receive(final("first", "Original"))
    await f.collector.flush()
    expect(f.latest().items[0]?.state).toBe("final")
    f.collector.receive(event)
    f.collector.receive(final("first", "Original"))
    await f.collector.flush()
    expect(f.latest().items[0]).toEqual({ id: "first", previous: null, role: "user", state: "omitted" })
  }
})

test("conflicting response event reuse invalidates previously finalized assistant text", async () => {
  const f = fixture()
  f.collector.receive(link("assistant", null, "assistant"))
  f.collector.receive({
    type: "response.output_audio_transcript.done",
    item_id: "assistant",
    response_id: "response",
    transcript: "Candidate",
  })
  f.collector.receive({ type: "response.done", event_id: "done", response: { id: "response", status: "completed" } })
  f.collector.receive({ type: "output_audio_buffer.started", response_id: "response" })
  f.collector.receive({ type: "output_audio_buffer.stopped", response_id: "response" })
  await f.collector.flush()
  expect(f.latest().items[0]?.state).toBe("final")
  f.collector.receive({ type: "response.done", event_id: "done", response: { id: "response", status: "cancelled" } })
  await f.collector.flush()
  expect(f.latest().items[0]).toEqual({ id: "assistant", previous: null, role: "assistant", state: "omitted" })
})

test("bounded replay tracking stops admitting uncertain history while retaining invalidations", async () => {
  const f = fixture()
  for (let index = 0; index < 1105; index++) {
    f.collector.receive(link(`item_${index}`, index ? `item_${index - 1}` : null))
    f.collector.receive(final(`item_${index}`, `Turn ${index}`))
  }
  await f.collector.flush()
  const prior = f.latest().items.map((item) => item.id)
  expect(prior).toHaveLength(100)
  f.collector.receive(link("item_0", null))
  f.collector.receive(final("item_0", "Resurrected"))
  f.collector.receive(link("new_item", prior.at(-1)!))
  await f.collector.flush()
  expect(f.latest().items.map((item) => item.id)).toEqual(prior)
  expect(f.latest().incomplete).toBe(true)
  expect(JSON.stringify(f.latest())).not.toContain("Resurrected")
})

test("clearance before transcripts and local interruption cannot be undone by later completions", async () => {
  const f = fixture()
  f.collector.interrupt("response")
  f.collector.receive(link("assistant", null, "assistant"))
  f.collector.receive({
    type: "response.output_audio_transcript.done",
    item_id: "assistant",
    response_id: "response",
    transcript: "Unheard candidate",
  })
  f.collector.receive({ type: "response.done", response: { id: "response", status: "completed" } })
  f.collector.receive({ type: "output_audio_buffer.started", response_id: "response" })
  f.collector.receive({ type: "output_audio_buffer.stopped", response_id: "response" })
  await f.collector.flush()
  expect(f.latest().items[0]?.state).toBe("omitted")
})

test("rolling history drops only an old prefix and preserves its original boundary", async () => {
  const f = fixture()
  for (let index = 0; index < 105; index++) {
    f.collector.receive(link(`item_${index}`, index ? `item_${index - 1}` : null))
    f.collector.receive(final(`item_${index}`, `Turn ${index}`))
  }
  await f.collector.flush()
  expect(f.latest().items).toHaveLength(100)
  expect(f.latest().items[0]).toMatchObject({ id: "item_5", previous: "item_4" })
  expect(f.latest().items.at(-1)?.id).toBe("item_104")
  expect(f.latest().incomplete).toBe(true)
  f.collector.receive(final("item_0", "Late evicted text"))
  await f.collector.flush()
  expect(f.latest().items).toHaveLength(100)
})

test("serial snapshots coalesce behind an in-flight acknowledgement and shutdown waits for it", async () => {
  const gate = Promise.withResolvers<void>()
  const snapshots: Parameters<ConstructorParameters<typeof OpenAITranscript>[0]>[0][] = []
  const collector = new OpenAITranscript(async (snapshot) => {
    snapshots.push(snapshot)
    if (snapshot.revision === 1) await gate.promise
  })
  collector.receive(link("first", null))
  await Promise.resolve()
  collector.receive(final("first", "Final first"))
  collector.receive(link("second", "first"))
  collector.receive(final("second", "Final second"))
  const closed = collector.close()
  expect(snapshots).toHaveLength(1)
  gate.resolve()
  await closed
  expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2])
  expect(snapshots[1]?.items.map((item) => item.text)).toEqual(["Final first", "Final second"])
})

test("recovered prefill is bounded historical role/text only and cannot leak provenance", () => {
  const text = OpenAITranscript.context({
    version: 1,
    incomplete: true,
    items: [
      { bindingID: "private_binding", itemID: "private_item", role: "user", text: "Historical request" },
      { bindingID: "private_binding", itemID: "private_reply", role: "assistant", text: "Historical response" },
    ],
  })
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8192)
  expect(text).not.toContain("private_binding")
  expect(text).not.toContain("private_item")
  expect(JSON.parse(text)).toMatchObject({
    incomplete: true,
    messages: [
      { role: "user", text: "Historical request" },
      { role: "assistant", text: "Historical response" },
    ],
  })
})
