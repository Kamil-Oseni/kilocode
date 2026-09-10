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
  expect(f.state.errors).toHaveLength(2)
  f.result("later")
  expect(f.state.events).toHaveLength(1)
  f.speech.close()
  f.advance(60_000)
  expect(f.state.errors).toHaveLength(2)
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
  expect(f.state.events).toHaveLength(2)
  f.speech.close()
})
