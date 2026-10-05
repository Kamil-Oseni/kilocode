import { expect, test } from "bun:test"
import { activity, model } from "../../webview-ui/src/components/chat/activity-status"
import type { Message, ToolPart } from "../../webview-ui/src/types/messages"

const messages: Message[] = [
  { id: "old", role: "assistant", sessionID: "chat", createdAt: "", parentID: "previous" },
  { id: "user", role: "user", sessionID: "chat", createdAt: "" },
  { id: "answer", role: "assistant", sessionID: "chat", createdAt: "", parentID: "user" },
]
const tool = (messageID: string, status: "running" | "pending" | "completed" = "running"): ToolPart => ({
  id: "tool",
  type: "tool",
  messageID,
  tool: "websearch",
  state: status === "completed" ? { status, input: {}, output: "done", title: "Search" } : { status, input: {} },
})
const input = {
  voice: "thinking" as const,
  busy: true,
  messages,
  tools: [tool("answer")],
  permission: false,
  question: false,
}

test("searching requires running evidence in the current user turn", () => {
  expect(activity(input)).toBe("Searching")
  expect(activity({ ...input, tools: [tool("old")] })).toBe("Thinking")
  expect(activity({ ...input, tools: [tool("answer", "pending")] })).toBe("Thinking")
  expect(activity({ ...input, tools: [tool("answer", "completed")] })).toBe("Thinking")
  expect(activity({ ...input, voice: "off", busy: false })).toBe("Ready")
})
test("voice playback and explicit attention take precedence over retained tools", () => {
  expect(activity({ ...input, voice: "speaking" })).toBe("Speaking")
  expect(activity({ ...input, voice: "listening" })).toBe("Listening")
  expect(activity({ ...input, permission: true })).toBe("Waiting for approval")
  expect(activity({ ...input, question: true })).toBe("Waiting for your answer")
  expect(activity({ ...input, voice: "degraded", error: "service unavailable" })).toBe("Voice paused")
})
test("worker model is the latest executed assistant model, never a user selection", () => {
  expect(model([{ ...messages[1], model: { providerID: "local", modelID: "requested" } }])).toBeUndefined()
  expect(
    model([
      { ...messages[0], providerID: "local", modelID: "4b" },
      { ...messages[2], model: { providerID: "local", modelID: "9b" } },
    ]),
  ).toBe("local/9b")
})
