import { expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { RayaChief } from "../../src/kilocode/chief"
import { settled, acknowledged } from "../../src/kilocode/second-brain/turn"

const sid = SessionID.make("ses_recall_turn")
const uid = MessageID.make("msg_user")
const aid = MessageID.make("msg_reader")
const request = "Which local speech engine and fallback did I choose? Please use saved Memory and cite the note."
const preference =
  "I prefer first-time Raya setup inside the conversation, using the existing Ask cards with minimal text. The Memory tab should be for inspecting and managing settings later. Please acknowledge this preference; do not run setup or control any lights."
function fixture() {
  const user: MessageV2.WithParts = {
    info: {
      id: uid,
      sessionID: sid,
      role: "user",
      time: { created: 10 },
      agent: "auto",
      model: { providerID: ProviderV2.ID.make("local"), modelID: ModelV2.ID.make("qwen") },
    },
    parts: [{ id: PartID.make("prt_user"), sessionID: sid, messageID: uid, type: "text", text: request }],
  }
  const tool: MessageV2.ToolPart = {
    id: PartID.make("prt_recall"),
    sessionID: sid,
    messageID: aid,
    type: "tool",
    tool: "second_brain_recall",
    callID: "call_original",
    state: {
      status: "completed",
      input: { query: "local speech engine fallback" },
      output: "{}",
      title: "Second Brain recall",
      metadata: { count: 1 },
      time: { start: 12, end: 13 },
    },
  }
  const assistant: MessageV2.WithParts = {
    info: {
      id: aid,
      sessionID: sid,
      role: "assistant",
      parentID: uid,
      time: { created: 11, completed: 14 },
      providerID: ProviderV2.ID.make("local"),
      modelID: ModelV2.ID.make("qwen"),
      mode: "auto",
      agent: "auto",
      path: { cwd: "/repo", root: "/repo" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
    },
    parts: [tool],
  }
  const session = { id: sid, metadata: { [RayaChief.phaseKey]: "route", [RayaChief.requestKey]: request } }
  return { messages: [user, assistant], session, tool }
}

test("original completed Memory read releases conversational synthesis without changing goal state", () => {
  const original = fixture()
  expect(settled(original.messages, original.session, uid)).toBe(true)
  expect(original.session.metadata[RayaChief.phaseKey]).toBe("route")
  if (original.tool.state.status !== "completed") throw new Error("Completed fixture required")
  original.tool.state = { ...original.tool.state, metadata: { count: 0 } }
  expect(settled(original.messages, original.session, uid)).toBe(true)
})

test("the actual installed preference acknowledgement needs no acquisition or goal completion", () => {
  const original = fixture()
  const part = original.messages[0].parts[0]
  if (part.type !== "text") throw new Error("Original text required")
  part.text = preference
  original.session.metadata[RayaChief.requestKey] = preference
  expect(acknowledged(original.messages, original.session, uid)).toBe(true)
  expect(original.session.metadata[RayaChief.phaseKey]).toBe("route")
  expect(acknowledged(original.messages, original.session, "foreign")).toBe(false)
  expect(acknowledged(original.messages, { ...original.session, parentID: "parent" }, uid)).toBe(false)
  for (const phase of ["task", "verify", "goal", "done"])
    expect(
      acknowledged(
        original.messages,
        { ...original.session, metadata: { ...original.session.metadata, [RayaChief.phaseKey]: phase } },
        uid,
      ),
    ).toBe(false)
  original.messages.push({
    ...original.messages[0],
    info: { ...original.messages[0].info, id: MessageID.make("msg_successor") },
  })
  expect(acknowledged(original.messages, original.session, uid)).toBe(false)
})

test("compound work, memory retrieval and structured output do not become acknowledgement-only turns", () => {
  for (const text of [
    request,
    "I prefer dark mode. Please install it. Please acknowledge this preference.",
    "I prefer dark mode. Install it. Please acknowledge this preference.",
    "I prefer dark mode. Please acknowledge this preference, then deploy it.",
    "I prefer dark mode and then deploy it. Please acknowledge this preference.",
    "Please acknowledge this preference and save a note.",
  ]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text") throw new Error("Original text required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    expect(acknowledged(original.messages, original.session, uid)).toBe(false)
  }
  const original = fixture()
  const part = original.messages[0].parts[0]
  if (part.type !== "text" || original.messages[0].info.role !== "user") throw new Error("Original user required")
  part.text = preference
  original.session.metadata[RayaChief.requestKey] = preference
  original.messages[0].info.format = { type: "json_schema", schema: {} }
  expect(acknowledged(original.messages, original.session, uid)).toBe(false)
})

test("historical, foreign and queued successor reads never release the original turn", () => {
  const original = fixture()
  expect(settled(original.messages, original.session, "another-user")).toBe(false)
  expect(settled(original.messages, { ...original.session, id: "another-session" }, uid)).toBe(false)
  expect(settled(original.messages, { ...original.session, parentID: "parent" }, uid)).toBe(false)
  original.messages.push({
    ...original.messages[0],
    info: { ...original.messages[0].info, id: MessageID.make("msg_next") },
  })
  expect(settled(original.messages, original.session, uid)).toBe(false)
})

test("pending, failed and substituted tools cannot release synthesis", () => {
  for (const status of ["pending", "running", "error"] as const) {
    const original = fixture()
    original.tool.state =
      status === "error"
        ? { status, input: {}, error: "unavailable", time: { start: 12, end: 13 } }
        : status === "running"
          ? { status, input: {}, time: { start: 12 } }
          : { status, input: {}, raw: "" }
    expect(settled(original.messages, original.session, uid)).toBe(false)
  }
  const original = fixture()
  original.tool.messageID = MessageID.make("msg_other_assistant")
  expect(settled(original.messages, original.session, uid)).toBe(false)
})

test("work, verification, goal completion and compound action requests keep their gates", () => {
  for (const phase of ["task", "verify", "goal", "done"]) {
    const original = fixture()
    expect(
      settled(
        original.messages,
        { ...original.session, metadata: { ...original.session.metadata, [RayaChief.phaseKey]: phase } },
        uid,
      ),
    ).toBe(false)
  }
  for (const text of [
    "Which saved Memory note applies? Implement its plan.",
    "Use Memory and install the speech engine.",
    "What is in my notes? Delete outdated entries.",
  ]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text") throw new Error("Original text required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    expect(settled(original.messages, original.session, uid)).toBe(false)
  }
})
