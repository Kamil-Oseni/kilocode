import { expect, test } from "bun:test"
import { OpenAISpeech } from "../../src/speech/openai-speech"

function fixture() {
  const state = { now: 0, current: true, events: [] as Record<string, unknown>[], errors: [] as string[] }
  const timers = new Set<{ at: number; run: () => void }>()
  const speech = new OpenAISpeech(
    (event) => state.events.push(event),
    () => state.current,
    (error) => state.errors.push(error),
    {
      now: () => state.now,
      after: (run, ms) => {
        const timer = { at: state.now + ms, run }
        timers.add(timer)
        return () => timers.delete(timer)
      },
    },
  )
  const event = (value: Record<string, unknown>) => {
    const handled = speech.event(value)
    speech.flush()
    return handled
  }
  return {
    state,
    speech,
    event,
    advance(ms: number) {
      state.now += ms
      for (const timer of [...timers]) {
        if (timer.at > state.now || !timers.has(timer)) continue
        timers.delete(timer)
        timer.run()
      }
    },
    done(status = "completed") {
      const request = state.events.at(-1)!
      const response = request.response as Record<string, unknown>
      event({ type: "response.created", response: { id: request.event_id, metadata: response.metadata } })
      return event({
        type: "response.done",
        response: { id: request.event_id, metadata: response.metadata, status, output: [] },
      })
    },
    result(id = "result_1") {
      speech.result(id, "call_1", "{}")
      event({
        type: "conversation.item.created",
        item: { id, type: "function_call_output", call_id: "call_1", output: "{}" },
      })
    },
  }
}

test("quiet boundary tracks audio ownership without stopping admitted work", () => {
  const f = fixture()
  const initial = f.speech.boundary()
  expect(initial).toEqual({ version: 1, epoch: 0, quiet: true })
  expect(Object.isFrozen(initial)).toBe(true)
  f.speech.start("call")
  expect(f.speech.boundary().quiet).toBe(true)
  expect(f.speech.boundary().epoch).toBeGreaterThan(initial.epoch)
  f.event({ type: "input_audio_buffer.speech_started" })
  expect(f.speech.boundary().quiet).toBe(false)
  f.event({ type: "input_audio_buffer.speech_stopped" })
  expect(f.speech.boundary().quiet).toBe(false) // Pending user turn still belongs to source.
  f.event({ type: "response.created", response: { id: "turn" } })
  f.event({ type: "output_audio_buffer.started", response_id: "turn" })
  f.event({ type: "response.done", response: { id: "turn", status: "completed" } })
  expect(f.speech.boundary().quiet).toBe(false) // Generation completion is not playback completion.
  f.event({ type: "output_audio_buffer.stopped", response_id: "turn" })
  expect(f.speech.boundary().quiet).toBe(true)
  f.speech.result("retained", "call", "{}")
  expect(f.speech.boundary().quiet).toBe(false)
  f.event({
    type: "conversation.item.created",
    item: { id: "retained", type: "function_call_output", call_id: "call", output: "{}" },
  })
  expect(f.speech.boundary().quiet).toBe(false)
  f.done()
  expect(f.speech.boundary().quiet).toBe(true)
  f.state.current = false
  expect(f.speech.boundary().quiet).toBe(false)
  f.speech.close()
  f.state.current = true
  expect(f.speech.boundary().quiet).toBe(false)
})

test("malformed and unconfirmed states permanently refuse a quiet boundary", () => {
  for (const event of [
    { type: "response.created", response: { id: "bad id" } },
    { type: "response.done", response: { id: "unknown", status: "completed" } },
    { type: "output_audio_buffer.started", response_id: null },
    { type: "output_audio_buffer.stopped", response_id: "unknown" },
    { type: "input_audio_buffer.speech_stopped" },
    { type: "error", error: { event_id: "unknown" } },
  ]) {
    const f = fixture()
    f.event(event)
    expect(f.speech.boundary().quiet).toBe(false)
    f.event({ type: "response.created", response: { id: "later" } })
    f.event({ type: "response.done", response: { id: "later", status: "completed" } })
    expect(f.speech.boundary().quiet).toBe(false)
    f.speech.close()
  }
  const f = fixture()
  f.speech.result("missing", "call", "{}")
  f.advance(30_000)
  expect(f.speech.boundary().quiet).toBe(false)
  f.speech.close()
})

test("elapsed narration uses only admitted facts, coalesces delayed rungs and backgrounds at five seconds", () => {
  const f = fixture()
  f.speech.start("call_1")
  f.advance(399)
  expect(f.state.events).toEqual([])
  f.advance(1)
  expect(f.state.events).toEqual([]) // No admission receipt yet.
  f.speech.observe("other", "running")
  expect(f.state.events).toEqual([])
  f.speech.observe("call_1", "accepted")
  expect(f.state.events).toHaveLength(1)
  expect(f.state.events[0].response).toMatchObject({
    tools: [],
    tool_choice: "none",
    conversation: "none",
    input: [],
    output_modalities: ["audio"],
  })
  expect(JSON.stringify(f.state.events[0])).toContain("The work was accepted.")
  f.done()
  f.advance(2101) // Skip the 1200 ms callback: send only the latest rung.
  expect(f.state.events).toHaveLength(2)
  expect(f.speech.background).toBe(false)
  f.done()
  f.event({ type: "input_audio_buffer.speech_started" })
  f.advance(2498)
  expect(f.speech.background).toBe(false)
  f.advance(1)
  expect(f.speech.background).toBe(true)
  expect(f.state.events).toHaveLength(2)
  f.event({ type: "input_audio_buffer.speech_stopped" })
  expect(f.state.events).toHaveLength(2) // Wait for automatic VAD response, not just silence.
  f.event({ type: "response.created", response: { id: "user_turn" } })
  f.event({ type: "response.done", response: { id: "user_turn", status: "completed" } })
  expect(f.state.events).toHaveLength(3)
  expect(JSON.stringify(f.state.events[2])).toContain("the user can keep talking")
  expect(f.done()).toBe(true)
  f.advance(60_000)
  expect(f.state.events).toHaveLength(3)
  f.speech.close()
})

test("final output acknowledgement supersedes deferred narration and waits for generation plus playback", () => {
  const f = fixture()
  f.event({ type: "response.created", response: { id: "playing" } })
  f.event({ type: "output_audio_buffer.started", response_id: "playing" })
  f.speech.start("call_1")
  f.speech.observe("call_1", "running")
  f.advance(5000)
  f.speech.finish()
  f.speech.result("result_1", "call_1", "{}")
  f.event({
    type: "conversation.item.created",
    item: { id: "wrong", type: "function_call_output", call_id: "call_1", output: "{}" },
  })
  expect(f.state.events).toEqual([])
  f.event({
    type: "conversation.item.created",
    item: { id: "result_1", type: "function_call_output", call_id: "call_1", output: "{}" },
  })
  f.event({ type: "response.done", response: { id: "playing", status: "completed" } })
  expect(f.state.events).toEqual([])
  f.event({ type: "output_audio_buffer.stopped", response_id: "old_playback" })
  expect(f.state.events).toEqual([])
  f.event({ type: "output_audio_buffer.stopped", response_id: "playing" })
  expect(f.state.events).toHaveLength(1)
  expect(f.state.events[0].response).toMatchObject({ metadata: { raya_kind: "result" } })
  expect(f.done()).toBe(true)
  f.advance(60_000)
  expect(f.state.events).toHaveLength(1)
  f.speech.close()
})

test("unrelated provider responses and errors cannot clear the outstanding response request", () => {
  const f = fixture()
  f.result()
  const first = f.state.events[0]
  f.result("result_2")
  f.event({ type: "response.created", response: { id: "unrelated" } })
  f.event({ type: "response.done", response: { id: "unrelated", status: "completed" } })
  f.event({ type: "error", event_id: first.event_id, error: { event_id: "unrelated" } })
  expect(f.state.events).toHaveLength(1)
  expect(f.state.errors).toEqual([])
  f.event({ type: "error", error: { event_id: first.event_id } })
  expect(f.state.errors).toHaveLength(1)
  expect(f.state.events).toHaveLength(2) // New retained result, never a replay of the rejected response.
  f.event({ type: "error", error: { event_id: first.event_id } })
  expect(f.state.events).toHaveLength(2)
  f.done()
  f.speech.close()
})

test("unconfirmed audio acknowledgement fences new speech and output rejection never replays work", () => {
  const f = fixture()
  f.speech.result("rejected", "call_1", "{}")
  f.event({ type: "error", error: { event_id: "rejected" } })
  expect(f.state.events).toEqual([])
  expect(f.state.errors).toHaveLength(1)
  f.result()
  f.advance(30_000)
  expect(f.state.errors).toHaveLength(1)
  f.result("later")
  expect(f.state.events).toHaveLength(0)
  expect(f.speech.delivery("rejected")!.phase).toBe("uncertain")
  expect(f.speech.boundary().quiet).toBe(false)
  f.speech.close()
  f.advance(60_000)
  expect(f.state.errors).toHaveLength(1)
})

test("receipt arrival, terminal completion, stale scope and closure cannot resurrect holding speech", () => {
  const f = fixture()
  f.speech.start("call_1")
  f.advance(5000)
  expect(f.speech.background).toBe(true)
  expect(f.state.events).toEqual([])
  f.speech.observe("call_1", "running")
  expect(f.state.events).toHaveLength(1)
  f.speech.finish()
  f.result()
  f.state.current = false
  f.done()
  expect(f.state.events).toHaveLength(1)
  f.speech.close()
  f.state.current = true
  f.event({ type: "output_audio_buffer.cleared", response_id: "old" })
  f.advance(60_000)
  expect(f.state.events).toHaveLength(1)
})

test("a late owned response yields to a user turn without cancelling parent work or unrelated speech", () => {
  const f = fixture()
  f.result()
  const sent = f.state.events[0]
  const response = sent.response as Record<string, unknown>
  f.event({ type: "input_audio_buffer.speech_started" })
  f.event({ type: "response.created", response: { id: "late", metadata: response.metadata } })
  expect(f.state.events[1]).toMatchObject({ type: "response.cancel", response_id: "late" })
  f.event({ type: "output_audio_buffer.started", response_id: "late" })
  expect(f.state.events[2]).toMatchObject({ type: "output_audio_buffer.clear" })
  f.event({ type: "error", error: { event_id: f.state.events[1].event_id, code: "response_cancel_not_active" } })
  f.event({ type: "response.done", response: { id: "late", status: "cancelled", metadata: response.metadata } })
  f.event({ type: "output_audio_buffer.cleared", response_id: "late" })
  f.event({ type: "input_audio_buffer.speech_stopped" })
  expect(f.state.events).toHaveLength(3)
  expect(f.state.errors).toEqual([])
  f.speech.close()
})

for (const item of [
  { call_id: "wrong", output: "{}" },
  { call_id: "call_1", output: '{"changed":true}' },
]) {
  test(`result acknowledgement rejects mismatched content ${JSON.stringify(item)}`, () => {
    const f = fixture()
    f.speech.result("result_1", "call_1", "{}")
    f.event({ type: "conversation.item.created", item: { id: "result_1", type: "function_call_output", ...item } })
    expect(f.state.errors).toHaveLength(1)
    expect(f.state.events).toEqual([])
    f.speech.close()
    f.speech.result("late", "call_1", "{}")
    f.advance(60_000)
    expect(f.state.errors).toHaveLength(1)
  })
}

test("malformed response and playback IDs cannot own or release the speech lane", () => {
  const f = fixture()
  for (const id of ["", "with space", "x".repeat(129), 12, {}, null]) {
    f.event({ type: "response.created", response: { id } })
    f.event({ type: "output_audio_buffer.started", response_id: id })
  }
  f.result()
  expect(f.state.events).toHaveLength(1)
  const response = f.state.events[0].response as Record<string, unknown>
  f.result("later")
  f.event({
    type: "response.done",
    response: { id: "invalid id", metadata: response.metadata, status: "completed" },
  })
  expect(f.state.events).toHaveLength(1)
  f.done()
  expect(f.state.events).toHaveLength(1)
  expect(f.speech.delivery("result_1")!.phase).toBe("uncertain")
  f.speech.close()
})

test("quiesce hold suppresses narration while provider activity invalidates the epoch", () => {
  const f = fixture()
  f.speech.start("call")
  const prior = f.speech.boundary()
  f.speech.hold(true)
  expect(f.speech.boundary().epoch).toBeGreaterThan(prior.epoch)
  expect(f.speech.boundary().quiet).toBe(true)
  f.advance(30_000)
  expect(f.state.events).toHaveLength(0)
  const held = f.speech.boundary().epoch
  f.event({ type: "input_audio_buffer.speech_started" })
  expect(f.speech.boundary().epoch).toBeGreaterThan(held)
  expect(f.speech.boundary().quiet).toBe(false)
  f.speech.hold(false)
  expect(f.speech.boundary().quiet).toBe(false)
})

test("inherited narration restores the original elapsed timeline without replaying prior holding statements", () => {
  const source = fixture()
  source.speech.start("source_provider_call")
  source.speech.observe("source_provider_call", "running")
  source.advance(1200)
  source.done()
  const checkpoint = source.speech.narration()!
  expect(Object.isFrozen(checkpoint)).toBe(true)
  expect(checkpoint).toMatchObject({ version: 1, started: 0, rung: 2, background: false, status: "running" })
  expect(JSON.stringify(checkpoint)).not.toContain("source_provider_call")
  const target = fixture()
  target.state.now = 2000
  target.speech.hold(true)
  target.speech.restore("local_work", checkpoint)
  expect(target.speech.narration()).toEqual(checkpoint)
  target.speech.hold(false)
  target.speech.flush()
  expect(target.state.events).toHaveLength(0)
  target.advance(499)
  expect(target.state.events).toHaveLength(0)
  target.advance(1)
  expect(target.state.events).toHaveLength(1)
  expect(JSON.stringify(target.state.events[0])).toContain("without repeating earlier acknowledgements")
  target.done()
  target.advance(2500)
  expect(target.speech.background).toBe(true)
  const next = fixture()
  next.state.now = 6000
  next.speech.restore("next_local_work", target.speech.narration()!)
  expect(next.state.events).toHaveLength(0)
  expect(next.speech.background).toBe(true)
})

test("malformed inherited narration fails closed without importing private provenance", () => {
  for (const value of [
    { version: 1, started: 100, rung: 0, background: false },
    { version: 1, started: 0, rung: 2, background: false },
    { version: 1, started: 0, rung: 0, background: false, status: "complete" },
    { version: 1, started: 0, rung: 0, background: false, providerCallID: "private" },
  ]) {
    const f = fixture()
    expect(() => f.speech.restore("local", value as Parameters<OpenAISpeech["restore"]>[1])).toThrow("timing boundary")
    expect(f.speech.boundary().quiet).toBe(false)
    expect(f.state.events).toHaveLength(0)
  }
})

function semantic(id: string, text: string) {
  return {
    type: "conversation.item.done",
    item: { id, type: "message", role: "user", content: [{ type: "input_text", text }] },
  }
}

test("inherited results refuse mismatched or unordered response completion without repeat", () => {
  for (const ordered of [true, false]) {
    const f = fixture()
    f.speech.semantic("local", "Verified result", 30_000)
    f.event(semantic("local", "Verified result"))
    const response = f.state.events[0].response as Record<string, unknown>
    if (ordered) f.event({ type: "response.created", response: { id: "bound", metadata: response.metadata } })
    f.event({
      type: "response.done",
      response: { id: ordered ? "wrong" : "bound", metadata: response.metadata, status: "completed", output: [] },
    })
    expect(f.speech.delivery("local")!.phase).toBe("uncertain")
    expect(f.speech.boundary().quiet).toBe(false)
    f.event({ type: "response.created", response: { id: "bound", metadata: response.metadata } })
    f.event({ type: "output_audio_buffer.started", response_id: "bound" })
    f.event({
      type: "response.done",
      response: { id: "bound", metadata: response.metadata, status: "completed", output: [] },
    })
    f.event({ type: "output_audio_buffer.stopped", response_id: "bound" })
    f.advance(30_000)
    expect(f.speech.delivery("local")!.phase).toBe("uncertain")
    expect(f.state.events).toHaveLength(1)
  }
})

test("inherited semantic result ACK creates one tools-disabled continuation and keeps generation separate from provider settlement", () => {
  const f = fixture()
  f.speech.semantic("local_result", "Verified canonical result", 30_000)
  expect(f.speech.delivery("local_result")).toEqual({ phase: "pending", deadline: 30_000, providerSettled: false })
  expect(f.speech.boundary().quiet).toBe(false)
  f.event(semantic("other", "Verified canonical result"))
  expect(f.state.events).toHaveLength(0)
  f.event(semantic("local_result", "Verified canonical result"))
  expect(f.state.events).toHaveLength(1)
  const request = f.state.events[0]
  const response = request.response as Record<string, unknown>
  expect(response).toMatchObject({ tools: [], tool_choice: "none" })
  expect(f.speech.delivery("local_result")!.phase).toBe("accepted")
  f.event(semantic("local_result", "Verified canonical result"))
  expect(f.state.events).toHaveLength(1)
  f.event({ type: "response.created", response: { id: "generated", metadata: response.metadata } })
  f.event({ type: "output_audio_buffer.started", response_id: "generated" })
  f.event({
    type: "response.done",
    response: { id: "generated", metadata: response.metadata, status: "completed", output: [] },
  })
  expect(f.speech.delivery("local_result")).toEqual({ phase: "generated", deadline: 30_000, providerSettled: false })
  expect(f.speech.boundary().quiet).toBe(false)
  f.event({ type: "output_audio_buffer.stopped", response_id: "generated" })
  expect(f.speech.delivery("local_result")).toEqual({ phase: "generated", deadline: 30_000, providerSettled: true })
  expect(Object.isFrozen(f.speech.delivery("local_result"))).toBe(true)
  expect(f.speech.boundary().quiet).toBe(true)
  expect("played" in f.speech.delivery("local_result")!).toBe(false)
  f.advance(60_000)
  expect(f.state.events).toHaveLength(1)
})

for (const change of ["role", "type", "text", "content"]) {
  test(`inherited semantic ACK refuses changed ${change} and never requests speech`, () => {
    const f = fixture()
    f.speech.semantic("local", "exact", 5000)
    const event = semantic("local", "exact")
    if (change === "role") event.item.role = "assistant"
    if (change === "type") event.item.type = "function_call_output"
    if (change === "text") event.item.content[0].text = "changed"
    if (change === "content") event.item.content.push({ type: "input_text", text: "extra" })
    f.event(event)
    expect(f.speech.delivery("local")!.phase).toBe("uncertain")
    expect(f.state.events).toHaveLength(0)
    expect(f.speech.boundary().quiet).toBe(false)
  })
}

test("inherited semantic deadlines survive elapsed time and unknown response creation is never retried", () => {
  const f = fixture()
  f.state.now = 4500
  f.speech.semantic("local", "exact", 5000)
  f.advance(499)
  expect(f.speech.delivery("local")!.phase).toBe("pending")
  f.advance(1)
  expect(f.speech.delivery("local")!.phase).toBe("uncertain")
  f.event(semantic("local", "exact"))
  expect(f.state.events).toHaveLength(0)
  const next = fixture()
  next.speech.semantic("local", "exact", 5000)
  next.event(semantic("local", "exact"))
  next.advance(30_000)
  expect(next.speech.delivery("local")!.phase).toBe("uncertain")
  next.advance(60_000)
  expect(next.state.events).toHaveLength(1)
})

test("a user's interruption makes inherited result presentation uncertain without replay", () => {
  const f = fixture()
  f.speech.semantic("local", "exact", 5000)
  f.event(semantic("local", "exact"))
  const response = f.state.events[0].response as Record<string, unknown>
  f.event({ type: "response.created", response: { id: "generated", metadata: response.metadata } })
  f.event({ type: "output_audio_buffer.started", response_id: "generated" })
  f.event({ type: "input_audio_buffer.speech_started" })
  expect(f.speech.delivery("local")!.phase).toBe("uncertain")
  f.event({ type: "output_audio_buffer.cleared", response_id: "generated" })
  f.event({ type: "response.done", response: { id: "generated", metadata: response.metadata, status: "completed" } })
  expect(f.speech.delivery("local")!.phase).toBe("uncertain")
  expect(f.speech.delivery("local")!.providerSettled).toBe(false)
  expect(f.state.events.filter((event) => event.type === "response.create")).toHaveLength(1)
})

test("duplicate or stale inherited narration cannot rewind progress, repeat speech or restart timers", () => {
  const f = fixture()
  const initial = { version: 1 as const, started: 0, rung: 0, background: false, status: "accepted" as const }
  f.speech.restore("local_work", initial)
  const epoch = f.speech.boundary().epoch
  f.speech.restore("local_work", initial)
  expect(f.speech.boundary().epoch).toBe(epoch)
  f.advance(1200)
  f.done()
  expect(f.speech.narration()!.rung).toBe(2)
  const count = f.state.events.length
  f.speech.restore("local_work", initial)
  expect(f.speech.narration()!.rung).toBe(2)
  expect(f.state.events).toHaveLength(count)
  f.advance(1300)
  f.done()
  expect(f.state.events).toHaveLength(count + 1)
  f.advance(2500)
  f.done()
  const terminal = f.speech.narration()!
  f.speech.restore("local_work", initial)
  expect(f.speech.narration()).toEqual(terminal)
  expect(f.state.events).toHaveLength(count + 2)
  const settled = f.speech.boundary().epoch
  f.speech.restore("local_work", terminal)
  expect(f.speech.boundary().epoch).toBe(settled)
  f.advance(1000)
  expect(() => f.speech.restore("local_work", { ...terminal, started: 1 })).toThrow("timing identity")
  expect(f.speech.boundary().quiet).toBe(false)
})

test("inherited results reject pending ordinary output collisions without losing its acknowledgement", () => {
  const f = fixture()
  f.speech.result("existing", "call", "{}")
  expect(() => f.speech.semantic("existing", "result", 5000)).toThrow("delivery boundary")
  expect(f.speech.delivery("existing")!.phase).toBe("pending")
  f.event({
    type: "conversation.item.created",
    item: { id: "existing", type: "function_call_output", call_id: "call", output: "{}" },
  })
  expect(f.state.events).toHaveLength(1)
  f.done()
  f.advance(30_000)
  expect(f.state.errors).toEqual([])
  expect(f.speech.boundary().quiet).toBe(false)
})

for (const kind of ["ordinary", "semantic"]) {
  test(`${kind} delivery retains immutable exact provider acceptance and generation observations`, () => {
    const f = fixture()
    if (kind === "ordinary") f.speech.result("exact", "call", "{}", 5000)
    if (kind === "semantic") f.speech.semantic("exact", "verified", 5000)
    const item =
      kind === "ordinary"
        ? {
            type: "conversation.item.created",
            item: { id: "exact", type: "function_call_output", call_id: "call", output: "{}" },
          }
        : semantic("exact", "verified")
    f.event({ ...item, event_id: "server_accept" })
    const accepted = f.speech.delivery("exact")!.accepted!
    expect(accepted).toEqual({ eventID: "server_accept" })
    expect(Object.isFrozen(accepted)).toBe(true)
    f.event({ ...item, type: "conversation.item.done", event_id: "server_duplicate" })
    expect(f.speech.delivery("exact")!.accepted).toBe(accepted)
    expect(f.state.events).toHaveLength(1)
    const metadata = (f.state.events[0].response as Record<string, unknown>).metadata
    f.event({ type: "response.created", event_id: "server_created", response: { id: "response_exact", metadata } })
    f.event({
      type: "response.done",
      event_id: "server_generated",
      response: { id: "response_exact", metadata, status: "completed" },
    })
    const generated = f.speech.delivery("exact")!.generated!
    expect(generated).toEqual({ eventID: "server_generated", responseID: "response_exact" })
    expect(Object.isFrozen(generated)).toBe(true)
    f.event({
      type: "response.done",
      event_id: "server_duplicate_done",
      response: { id: "response_exact", metadata, status: "completed" },
    })
    expect(f.speech.delivery("exact")!.generated).toBe(generated)
    expect(f.speech.delivery("exact")!.providerSettled).toBe(false)
    expect("played" in f.speech.delivery("exact")!).toBe(false)
  })
}

test("missing or invalid server event identities cannot manufacture durable provider observations", () => {
  for (const eventID of [undefined, "", "界", "a".repeat(129)]) {
    const f = fixture()
    f.speech.result("exact", "call", "{}")
    f.event({
      type: "conversation.item.created",
      event_id: eventID,
      item: { id: "exact", type: "function_call_output", call_id: "call", output: "{}" },
    })
    expect(f.speech.delivery("exact")!.accepted).toBeUndefined()
    const metadata = (f.state.events[0].response as Record<string, unknown>).metadata
    f.event({ type: "response.created", response: { id: "response_exact", metadata } })
    f.event({
      type: "response.done",
      event_id: eventID,
      response: { id: "response_exact", metadata, status: "completed" },
    })
    expect(f.speech.delivery("exact")!.generated).toBeUndefined()
    expect(f.speech.delivery("exact")!.phase).toBe("generated")
  }
})

test("a later exact acceptance event may fill a missing receipt without requesting speech twice", () => {
  const f = fixture()
  f.result("exact")
  f.event({
    type: "conversation.item.done",
    event_id: "server_late_accept",
    item: { id: "exact", type: "function_call_output", call_id: "call_1", output: "{}" },
  })
  expect(f.speech.delivery("exact")!.accepted).toEqual({ eventID: "server_late_accept" })
  expect(f.state.events).toHaveLength(1)
})

for (const fault of ["missing-created", "metadata", "status", "response"]) {
  test(`generation observation refuses ${fault} correlation`, () => {
    const f = fixture()
    f.result("exact")
    const metadata = (f.state.events[0].response as Record<string, unknown>).metadata
    if (fault !== "missing-created") f.event({ type: "response.created", response: { id: "response_exact", metadata } })
    f.event({
      type: "response.done",
      event_id: "server_done",
      response: {
        id: fault === "response" ? "other_response" : "response_exact",
        metadata: fault === "metadata" ? {} : metadata,
        status: fault === "status" ? "cancelled" : "completed",
      },
    })
    expect(f.speech.delivery("exact")!.generated).toBeUndefined()
    expect(f.speech.delivery("exact")!.phase).toBe("uncertain")
    expect(f.state.events).toHaveLength(1)
  })
}

test("ordinary results preserve one absolute deadline through acknowledgement and response creation", () => {
  const f = fixture()
  f.state.now = 4500
  f.speech.result("exact", "call", "{}", 5000)
  f.event({
    type: "conversation.item.created",
    event_id: "server_accept",
    item: { id: "exact", type: "function_call_output", call_id: "call", output: "{}" },
  })
  f.advance(499)
  expect(f.speech.delivery("exact")!.phase).toBe("accepted")
  f.advance(1)
  expect(f.speech.delivery("exact")!.phase).toBe("uncertain")
  expect(f.speech.delivery("exact")!.deadline).toBe(5000)
  f.advance(30_000)
  expect(f.state.events).toHaveLength(1)
  expect(() => f.speech.result("exact", "call", "{}", f.state.now + 5000)).toThrow("delivery boundary")
})

test("accepted delivery cannot begin generation after its original deadline while held", () => {
  const f = fixture()
  f.speech.hold(true)
  f.result("exact")
  expect(f.state.events).toEqual([])
  f.advance(30_000)
  f.speech.hold(false)
  f.speech.flush()
  expect(f.state.events).toEqual([])
  expect(f.speech.delivery("exact")!.phase).toBe("uncertain")
  expect(f.state.errors).toHaveLength(1)
})

for (const kind of ["ordinary", "semantic"]) {
  test(`${kind} observed response creation cannot extend the original generation deadline`, () => {
    const f = fixture()
    f.state.now = 4500
    if (kind === "ordinary") f.speech.result("exact", "call", "{}", 5000)
    if (kind === "semantic") f.speech.semantic("exact", "verified", 5000)
    const item =
      kind === "ordinary"
        ? {
            type: "conversation.item.created",
            item: { id: "exact", type: "function_call_output", call_id: "call", output: "{}" },
          }
        : semantic("exact", "verified")
    f.event({ ...item, event_id: "server_accept" })
    const metadata = (f.state.events[0].response as Record<string, unknown>).metadata
    f.event({ type: "response.created", event_id: "server_created", response: { id: "response_exact", metadata } })
    f.advance(499)
    expect(f.speech.delivery("exact")!.phase).toBe("accepted")
    f.advance(1)
    expect(f.speech.delivery("exact")!.phase).toBe("uncertain")
    expect(f.speech.delivery("exact")!.deadline).toBe(5000)
    expect(f.speech.delivery("exact")!.generated).toBeUndefined()
    expect(f.speech.delivery("exact")!.providerSettled).toBe(false)
    expect(f.state.errors).toHaveLength(1)
    f.event({
      type: "response.done",
      event_id: "server_late_done",
      response: { id: "response_exact", metadata, status: "completed" },
    })
    f.advance(60_000)
    expect(f.speech.delivery("exact")!.phase).toBe("uncertain")
    expect(f.speech.delivery("exact")!.generated).toBeUndefined()
    expect(f.state.events).toHaveLength(1)
    expect(f.state.errors).toHaveLength(1)
  })
}

test("inherited results require meaningful UTF-8 text within the byte limit", () => {
  for (const text of ["", " \n\t", "界".repeat(5462)]) {
    const f = fixture()
    expect(() => f.speech.semantic("local", text, 5000)).toThrow("delivery boundary")
    expect(f.speech.delivery("local")).toBeUndefined()
    expect(f.state.events).toEqual([])
  }
})

test("a newer inherited narration snapshot merges only forward without scheduling duplicate timers", () => {
  const f = fixture()
  f.speech.hold(true)
  f.speech.restore("local", { version: 1, started: 0, rung: 0, background: false, status: "accepted" })
  f.advance(2500)
  f.speech.restore("local", { version: 1, started: 0, rung: 3, background: false, status: "running" })
  expect(f.speech.narration()).toMatchObject({ rung: 3, status: "running" })
  f.speech.hold(false)
  f.speech.flush()
  expect(f.state.events).toHaveLength(0)
  f.advance(2500)
  expect(f.state.events).toHaveLength(1)
  expect(f.speech.background).toBe(true)
})
