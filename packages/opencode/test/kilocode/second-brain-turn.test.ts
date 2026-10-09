import { expect, test } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { RayaChief } from "../../src/kilocode/chief"
import { settled, acknowledged } from "../../src/kilocode/second-brain/turn"
import { ollama, OllamaBridgeError } from "../../src/kilocode/provider/ollama-bridge"

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

test("explicit recall releases synthesis after the original read while preserving file and light restrictions", () => {
  for (const text of [
    "Recall my saved preferences for delivering Raya builds and choosing how much testing to do. Use my local notes and cite the source. Do not change files or lights.",
    "Please recall my saved preferences. Don't change files.",
  ]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text") throw new Error("Original text required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    expect(settled(original.messages, original.session, uid)).toBe(true)
    expect(original.session.metadata[RayaChief.phaseKey]).toBe("route")
    original.tool.state = { status: "running", input: { query: "preferences" }, time: { start: 12 } }
    expect(settled(original.messages, original.session, uid)).toBe(false)
  }
})

test("an original status read answers only a status question without releasing a work goal", () => {
  for (const text of ["Is my Memory connected?", "Is Memory set up?", "What is Memory's setup status?"]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text" || original.tool.state.status !== "completed") throw new Error("Original fixture required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    expect(settled(original.messages, original.session, uid)).toBe(false)
    original.tool.state = { ...original.tool.state, input: { action: "status" } }
    expect(settled(original.messages, original.session, uid)).toBe(true)
    expect(original.session.metadata[RayaChief.phaseKey]).toBe("route")
    expect(settled(original.messages, { ...original.session, parentID: "parent" }, uid)).toBe(false)
    expect(settled(original.messages, original.session, "foreign")).toBe(false)
    expect(
      settled(
        original.messages,
        { ...original.session, metadata: { ...original.session.metadata, [RayaChief.phaseKey]: "task" } },
        uid,
      ),
    ).toBe(false)
    original.tool.state = { ...original.tool.state, input: { action: "status", query: "invented" } }
    expect(settled(original.messages, original.session, uid)).toBe(false)
  }
  for (const text of [
    "Is Memory ready? Delete old notes.",
    "Is my saved preference remembered?",
    "Which preferences are saved?",
  ]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text" || original.tool.state.status !== "completed") throw new Error("Original fixture required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    original.tool.state = { ...original.tool.state, input: { action: "status" } }
    expect(settled(original.messages, original.session, uid)).toBe(false)
  }
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

test("natural preference wording can acknowledge without acquisition or goal completion", () => {
  for (const text of [
    "For first-time setup, I want Raya to guide me inside the conversation using its existing Ask cards. Keep Memory for manual inspection and settings. Please acknowledge this preference.",
    "My preference is concise replies while I work. Please acknowledge my preference.",
    "I prefer brief build-chat updates, with reports when work is complete rather than frequent messages. Please acknowledge this preference.",
    "I prefer brief build reports and concise update messages. Please acknowledge this preference.",
    "My preference is to keep PC checks on my second display, leaving my main display clear. Please acknowledge my preference.",
    "I would like shorter replies, but I also like clear explanations. Please acknowledge that preference.",
    "I prefer Raya PC checks on my second display so the main display stays clear. Please acknowledge this preference.",
  ]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text") throw new Error("Original text required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    expect(acknowledged(original.messages, original.session, uid)).toBe(true)
    expect(original.session.metadata[RayaChief.phaseKey]).toBe("route")
  }
})

test("the installed preference statement can finish after status without treating status as saved-note evidence", () => {
  const original = fixture()
  const text =
    "For Raya's first-time setup, I prefer brief conversational ask cards instead of long forms with lots of text. Keep the Memory tab for manually inspecting and adjusting settings. Do not change lights or place orders."
  const part = original.messages[0].parts[0]
  if (part.type !== "text" || original.tool.state.status !== "completed") throw new Error("Original fixture required")
  part.text = text
  original.session.metadata[RayaChief.requestKey] = text
  original.tool.state = { ...original.tool.state, input: { action: "status" } }
  expect(acknowledged(original.messages, original.session, uid)).toBe(true)
  expect(settled(original.messages, original.session, uid)).toBe(false)
  expect(original.session.metadata[RayaChief.phaseKey]).toBe("route")
  expect(acknowledged(original.messages, { ...original.session, parentID: "parent" }, uid)).toBe(false)
  for (const value of [
    "I prefer concise replies.",
    "I would prefer brief conversational ask cards.",
    "For first-time setup, I prefer brief ask cards. Do not change lights or place orders.",
    "For first-time Raya setup, I prefer concise conversational ask cards instead of lengthy forms. I also prefer the Memory tab to be for manually inspecting and adjusting settings. Do not change lights or place orders.",
    "I prefer concise replies. I also like clear citations.",
  ]) {
    part.text = value
    original.session.metadata[RayaChief.requestKey] = value
    expect(acknowledged(original.messages, original.session, uid)).toBe(true)
  }
  for (const value of [
    "I prefer concise replies and deploy the app.",
    "I prefer you delete the old notes.",
    "I prefer brief ask cards. Change the settings.",
    "I prefer brief ask cards. Keep the lights on.",
    "I prefer you recall my saved preferences.",
    "I prefer brief ask cards. Do not change lights or place orders, then install the extension.",
    "I prefer concise replies. I also prefer you delete the old notes.",
    "I prefer concise replies. I also prefer brief notes. Deploy the app.",
    "I prefer concise replies. I like citations. I prefer brief notes. I like examples. I prefer more details.",
  ]) {
    part.text = value
    original.session.metadata[RayaChief.requestKey] = value
    expect(acknowledged(original.messages, original.session, uid)).toBe(false)
  }
})

test("compound work, memory retrieval and structured output do not become acknowledgement-only turns", () => {
  for (const text of [
    request,
    "I prefer dark mode. Please install it. Please acknowledge this preference.",
    "I prefer dark mode. Install it. Please acknowledge this preference.",
    "I prefer dark mode. Please acknowledge this preference, then deploy it.",
    "I prefer dark mode and then deploy it. Please acknowledge this preference.",
    "I prefer dark mode and run the installer. Please acknowledge this preference.",
    "I want you to delete the old notes. Please acknowledge this preference.",
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

test("Memory setup status is not a completed note query", () => {
  const original = fixture()
  if (original.tool.state.status !== "completed") throw new Error("Completed fixture required")
  original.tool.state = { ...original.tool.state, input: { action: "status" } }
  expect(settled(original.messages, original.session, uid)).toBe(false)
  original.tool.state = { ...original.tool.state, input: { query: " " } }
  expect(settled(original.messages, original.session, uid)).toBe(false)
})

test("saved-note search continuation releases synthesis only after this turn's completed query", () => {
  const original = fixture()
  const text =
    "Search my saved SecondBrain notes: what are my preferences for first-time Raya setup and for the Memory tab? Cite the saved sources. Do not change anything."
  const part = original.messages[0].parts[0]
  if (part.type !== "text" || original.tool.state.status !== "completed")
    throw new Error("Original completed fixture required")
  part.text = text
  original.session.metadata[RayaChief.requestKey] = text
  expect(settled(original.messages, original.session, uid)).toBe(true)
  expect(original.session.metadata[RayaChief.phaseKey]).toBe("route")
  original.tool.state = { ...original.tool.state, input: { action: "status" } }
  expect(settled(original.messages, original.session, uid)).toBe(false)
  original.tool.state = {
    ...original.tool.state,
    input: { query: "first-time Raya setup preferences and Memory tab settings" },
  }
  expect(settled(original.messages, original.session, uid)).toBe(true)
  original.tool.messageID = MessageID.make("msg_foreign")
  expect(settled(original.messages, original.session, uid)).toBe(false)
})

test("saved-note search prefixes do not release mutation, stale-turn or goal-completion gates", () => {
  for (const text of [
    "Search my saved SecondBrain notes: what are my preferences? Edit the saved sources. Do not change anything.",
    "Search my saved Memory notes: what are my preferences? Do not change anything, then deploy the project.",
    "Search my saved SecondBrain notes: install the preferences. Do not change anything.",
    "Search my saved SecondBrain notes: what are my preferences? Change settings. Do not change anything.",
    "Search my saved SecondBrain notes: what are my preferences? Delete the old notes. Do not change anything.",
    "Search my saved SecondBrain notes: what are my preferences? Send the saved sources. Do not change anything.",
  ]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text") throw new Error("Original text required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    expect(settled(original.messages, original.session, uid)).toBe(false)
  }
  const original = fixture()
  const text = "Search my saved Memory notes: which preferences are in my notes? Do not change anything."
  const part = original.messages[0].parts[0]
  if (part.type !== "text") throw new Error("Original text required")
  part.text = text
  original.session.metadata[RayaChief.requestKey] = text
  expect(settled(original.messages, original.session, uid)).toBe(true)
  expect(settled(original.messages, { ...original.session, parentID: "parent" }, uid)).toBe(false)
  for (const phase of ["task", "verify", "goal", "done"])
    expect(
      settled(
        original.messages,
        { ...original.session, metadata: { ...original.session.metadata, [RayaChief.phaseKey]: phase } },
        uid,
      ),
    ).toBe(false)
  original.session.metadata[RayaChief.requestKey] = request
  expect(settled(original.messages, original.session, uid)).toBe(false)
})

test("actual Ollama bridge permits text continuation after the original Memory query while required acquisition still refuses", async () => {
  const original = fixture()
  const text =
    "Search my saved SecondBrain notes: what are my preferences for first-time Raya setup and for the Memory tab? Cite the saved sources. Do not change anything."
  const part = original.messages[0].parts[0]
  if (part.type !== "text") throw new Error("Original user fixture required")
  part.text = text
  original.session.metadata[RayaChief.requestKey] = text
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      requests.push(await request.json())
      return Response.json({
        model: "fixture",
        message: { role: "assistant", content: "Controlled sourced answer." },
        done: true,
        done_reason: "stop",
      })
    },
  })
  try {
    const send = ollama({ localInference: true, localInferenceAPI: "ollama" }, globalThis.fetch)
    const body = {
      model: "fixture",
      messages: [{ role: "user", content: text }],
      tools: [{ type: "function", function: { name: "second_brain_recall", parameters: { type: "object" } } }],
    }
    const refused = await send(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ ...body, tool_choice: "required" }),
    }).then(
      () => undefined,
      (err: unknown) => err,
    )
    expect(refused).toBeInstanceOf(OllamaBridgeError)
    expect(refused instanceof OllamaBridgeError && refused.diagnostic).toMatchObject({
      reason: "required-acquisition",
      refusal: "tool-missing",
    })
    expect(settled(original.messages, original.session, uid)).toBe(true)
    const response = await send(`${server.url}v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ ...body, tool_choice: "auto" }),
    })
    expect((await response.json()).choices[0].message.content).toBe("Controlled sourced answer.")
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[0].messages)).toContain("call at least one tool")
    expect(JSON.stringify(requests[1].messages)).not.toContain("call at least one tool")
  } finally {
    await server.stop()
  }
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
    "Recall my saved preferences and implement them. Do not change lights.",
    "Recall my saved notes. Do not change files or lights, but run the installer.",
    "Recall my saved preferences. Do not change files or lights. Deploy the project.",
  ]) {
    const original = fixture()
    const part = original.messages[0].parts[0]
    if (part.type !== "text") throw new Error("Original text required")
    part.text = text
    original.session.metadata[RayaChief.requestKey] = text
    expect(settled(original.messages, original.session, uid)).toBe(false)
  }
})
