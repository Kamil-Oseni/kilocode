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

test("checkpoint publishes an exact empty receipt and freezes trusted provenance", async () => {
  const f = fixture()
  const empty = await f.collector.checkpoint()
  expect(empty).toMatchObject({ version: 1, revision: 1, ready: true, items: [] })
  expect(f.snapshots).toHaveLength(1)
  const same = await f.collector.checkpoint()
  expect(same.fingerprint).toBe(empty.fingerprint)
  expect(same.revision).toBe(empty.revision)
  f.collector.receive(link("item", null))
  expect((await f.collector.checkpoint()).ready).toBe(false)
  f.collector.receive(final("item", "Trusted text"))
  const state = await f.collector.checkpoint()
  expect(state.ready).toBe(true)
  expect(state.items).toEqual([{ id: "item", previous: null, role: "user", state: "final", text: "Trusted text" }])
  expect(state.fingerprint).not.toBe(empty.fingerprint)
  expect(state.epoch).toBeGreaterThan(empty.epoch)
  expect(Object.isFrozen(state)).toBe(true)
  expect(Object.isFrozen(state.items)).toBe(true)
  expect(Object.isFrozen(state.items[0])).toBe(true)
})

test("checkpoint refuses unresolved linkage, unheard audio and malformed identity", async () => {
  const f = fixture()
  f.collector.receive(final("child", "Unlinked text"))
  expect((await f.collector.checkpoint()).ready).toBe(false)
  f.collector.receive(link("child", null, "user"))
  expect((await f.collector.checkpoint()).ready).toBe(true)
  f.collector.receive(link("assistant", "child", "assistant"))
  f.collector.receive({
    type: "response.output_audio_transcript.done",
    item_id: "assistant",
    response_id: "response",
    transcript: "Unheard words",
  })
  f.collector.receive({ type: "response.done", response: { id: "response", status: "completed" } })
  const unheard = await f.collector.checkpoint()
  expect(unheard.ready).toBe(false)
  expect(JSON.stringify(unheard)).not.toContain("Unheard words")
  f.collector.receive({ type: "output_audio_buffer.started", response_id: "response" })
  f.collector.receive({ type: "output_audio_buffer.stopped", response_id: "response" })
  expect((await f.collector.checkpoint()).ready).toBe(true)
  f.collector.receive({ type: "conversation.item.truncated", item_id: "assistant" })
  const omitted = await f.collector.checkpoint()
  expect(omitted.ready).toBe(true)
  expect(omitted.incomplete).toBe(true)
  expect(omitted.fingerprint).not.toBe(unheard.fingerprint)
  expect(JSON.stringify(omitted)).not.toContain("Unheard words")
  f.collector.receive({ type: "response.done", response: { id: "bad id", status: "completed" } })
  expect((await f.collector.checkpoint()).ready).toBe(false)
})

test("checkpoint refuses source activity during save and never fabricates failed persistence", async () => {
  let release!: () => void
  const saving = new Promise<void>((resolve) => {
    release = resolve
  })
  const collector = new OpenAITranscript(async () => saving)
  collector.receive(link("item", null))
  collector.receive(final("item", "Original"))
  const pending = collector.checkpoint()
  await Promise.resolve()
  collector.receive({ type: "conversation.item.deleted", item_id: "item" })
  release()
  const changed = await pending
  expect(changed.ready).toBe(false)
  expect(changed.items[0]?.state).toBe("omitted")
  expect((await collector.checkpoint()).ready).toBe(true)
  const failed = new OpenAITranscript(async () => {
    throw new Error("Missing exact receipt")
  })
  await expect(failed.checkpoint()).rejects.toThrow("Missing exact receipt")
  await expect(failed.checkpoint()).rejects.toThrow("Missing exact receipt")
  await collector.close()
  expect((await collector.checkpoint()).ready).toBe(false)
})

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
  await f.collector.flush()
  expect(f.snapshots).toEqual([])
  f.collector.receive(link("live", "context"))
  f.collector.receive(final("live", "Live speech"))
  await f.collector.flush()
  expect(f.latest()).toMatchObject({
    incomplete: true,
    items: [{ id: "live", previous: "context", text: "Live speech" }],
  })
})

test("synthetic context with a provider predecessor remains a metadata bridge", async () => {
  const f = fixture()
  f.collector.ignore("context")
  f.collector.receive(link("context", null))
  f.collector.receive(link("live", "context"))
  f.collector.receive(final("live", "Live speech"))
  await f.collector.flush()
  expect(f.latest().items).toEqual([
    { id: "context", previous: null, role: "other", state: "omitted" },
    { id: "live", previous: "context", role: "user", text: "Live speech", state: "final" },
  ])
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
  const checkpoint = await f.collector.checkpoint()
  expect(checkpoint.incomplete).toBe(true)
  expect(checkpoint.ready).toBe(false)
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
  const checkpoint = await f.collector.checkpoint()
  expect(checkpoint.incomplete).toBe(true)
  expect(checkpoint.ready).toBe(true)
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

test("sealed retirement preserves the exact committed checkpoint", async () => {
  const f = fixture()
  f.collector.receive(link("user", null))
  f.collector.receive(final("user", "Saved user turn"))
  const checkpoint = await f.collector.checkpoint()
  const count = f.snapshots.length
  await f.collector.close(true)
  expect(f.snapshots).toHaveLength(count)
  expect(f.latest().revision).toBe(checkpoint.revision)
  expect(f.latest().items[0].text).toBe("Saved user turn")
})

test("sealed retirement still flushes actual late transcript publication", async () => {
  const f = fixture()
  await f.collector.checkpoint()
  f.collector.receive(link("late", null))
  f.collector.receive(final("late", "Actual late turn"))
  await f.collector.close(true)
  expect(f.latest().items).toMatchObject([{ id: "late", state: "final", text: "Actual late turn" }])
})
