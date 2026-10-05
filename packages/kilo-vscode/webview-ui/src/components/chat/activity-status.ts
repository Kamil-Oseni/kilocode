import type { Message, ToolPart } from "../../types/messages"
import type { VoiceStatus } from "../../context/voice"

/** Use current-turn tool evidence only; retained tools must not imply live work. */
export function activity(input: {
  voice: VoiceStatus
  error?: string
  busy: boolean
  messages: readonly Message[]
  tools: readonly ToolPart[]
  permission: boolean
  question: boolean
}) {
  if (input.voice === "degraded") return input.error ? "Voice paused" : "Reconnecting voice"
  if (input.voice === "connecting") return "Connecting voice"
  if (input.voice === "speaking") return "Speaking"
  if (input.voice === "listening") return "Listening"
  if (!input.busy) return input.voice === "off" ? "Ready" : "Thinking"
  if (input.permission) return "Waiting for approval"
  if (input.question) return "Waiting for your answer"
  const user = input.messages.findLast((message) => message.role === "user")
  const ids = new Set(
    input.messages
      .filter((message) => message.role === "assistant" && user && message.parentID === user.id)
      .map((message) => message.id),
  )
  const tools = input.tools.filter(
    (part) => part.messageID && ids.has(part.messageID) && ["pending", "running"].includes(part.state.status),
  )
  if (
    tools.some(
      (part) =>
        part.state.status === "running" &&
        /(^|_)(websearch|web_search|search|webfetch|web_fetch)($|_)/i.test(part.tool),
    )
  )
    return "Searching"
  if (tools.some((part) => part.state.status === "running")) return "Using tools"
  return "Thinking"
}

/** Report the executed model, never a saved selection or a user's requested model. */
export function model(messages: readonly Message[]) {
  const message = messages.findLast((item) => item.role === "assistant" && (item.modelID || item.model?.modelID))
  if (!message) return
  const provider = message.providerID ?? message.model?.providerID
  const id = message.modelID ?? message.model?.modelID
  return provider ? `${provider}/${id}` : id
}
