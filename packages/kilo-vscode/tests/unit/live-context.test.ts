import { expect, test } from "bun:test"
import { LiveContext } from "../../src/shared/live-context"

function user(sequence: number, text = "Please summarize the file") {
  return {
    type: "session.input_transcript.delta",
    event_id: `evt_user_${sequence}`,
    delta: text,
    start_ms: (sequence - 1) * 800,
    end_ms: sequence * 800,
  }
}

function created(id: string, offset: number) {
  return {
    type: "session.delegation.created",
    event_id: `evt_dlg_${id}`,
    offset_ms: offset,
    delegation: { id, type: "delegation", target: "client" },
  }
}

test("LiveContext selects fresh user evidence once and refuses consumed sequence", () => {
  const context = new LiveContext()
  expect(context.receive(user(1))).toBe("transcript")
  expect(context.receive(user(1))).toBe("ignored")
  expect(context.select("dlg_1")).toBeUndefined()
  expect(context.receive(created("dlg_1", 800))).toBe("delegation")
  const first = context.select("dlg_1")
  expect(first).toMatchObject({ version: 1, delegation: "dlg_1", incomplete: true, omitted: false })
  expect(first?.fragments).toHaveLength(1)
  expect(first?.fragments[0]).toMatchObject({ speaker: "user", text: "Please summarize the file", sequence: 1 })
  expect(context.select("dlg_1")).toEqual(first)
  expect(context.receive(created("dlg_2", 800))).toBe("delegation")
  expect(context.select("dlg_2")).toBeUndefined()
  expect(context.receive(user(2, "Follow up on the summary"))).toBe("transcript")
  const next = context.select("dlg_2")
  expect(next?.fragments.some((fragment) => fragment.sequence === 2)).toBe(true)
  expect(next?.fragments.some((fragment) => fragment.sequence === 1)).toBe(true)
  const steered = new LiveContext()
  expect(steered.receive(user(1))).toBe("transcript")
  expect(steered.receive(created("dlg_1", 800))).toBe("delegation")
  expect(steered.later("dlg_1")).toBe(false)
  expect(steered.receive(user(3, "Change that request"))).toBe("transcript")
  expect(steered.later("dlg_1")).toBe(true)
  const conflict = new LiveContext()
  expect(conflict.receive(user(1))).toBe("transcript")
  expect(conflict.receive({ ...user(1), delta: "Changed" })).toBe("invalid")
  expect(conflict.receive(created("dlg_1", 800))).toBe("delegation")
  expect(conflict.select("dlg_1")).toBeUndefined()
})

test("LiveContext ignores client-correlated fragments and blocks selection after a gap", () => {
  const context = new LiveContext()
  expect(
    context.receive({
      type: "session.input_transcript.delta",
      event_id: "evt_cmd_1",
      client_event_id: "mute_1",
      delta: "Mute acknowledgement echo",
      start_ms: 0,
      end_ms: 100,
    }),
  ).toBe("transcript")
  expect(context.receive(created("dlg_1", 100))).toBe("delegation")
  expect(context.select("dlg_1")).toBeUndefined()
  expect(context.receive(user(1))).toBe("transcript")
  expect(context.select("dlg_1")?.fragments.some((fragment) => fragment.client)).toBe(true)
  expect(context.select("dlg_1")?.fragments.some((fragment) => !fragment.client && fragment.speaker === "user")).toBe(
    true,
  )
  const other = new LiveContext()
  expect(other.receive(user(1))).toBe("transcript")
  expect(other.receive(created("dlg_1", 800))).toBe("delegation")
  other.gap()
  expect(other.select("dlg_1")).toBeUndefined()
})

test("LiveContext ignores non-client delegation targets and conflicting offsets", () => {
  const context = new LiveContext()
  expect(context.receive(user(1))).toBe("transcript")
  expect(
    context.receive({
      type: "session.delegation.created",
      event_id: "evt_resp_1",
      offset_ms: 800,
      delegation: { id: "dlg_resp", type: "delegation", target: "responses" },
    }),
  ).toBe("ignored")
  expect(context.receive(created("dlg_1", 800))).toBe("delegation")
  expect(context.receive(created("dlg_1", 800))).toBe("ignored")
  expect(context.receive({ ...created("dlg_1", 900), event_id: "evt_conflict" })).toBe("invalid")
  expect(context.select("dlg_1")).toBeUndefined()
})
