import { createHash } from "node:crypto"
import { Schema } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import { MemoryRedact } from "@kilocode/kilo-memory/redact"
import { CaptureEntries, CaptureSource } from "./capture-protocol"
import { CaptureRejected } from "./capture-errors"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "capture.source" })

export function digest(observed: string, source: CaptureSource) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        observed,
        source.user.id,
        source.user.text,
        source.assistant.id,
        source.assistant.text,
        source.tools.map((tool) => [tool.id, tool.name, tool.status, tool.text]),
      ]),
    )
    .digest("hex")
}

export function identity(project: string, session: string, message: string) {
  const hash = createHash("sha256")
    .update(JSON.stringify([project, session, message]))
    .digest("hex")
    .slice(0, 32)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20)}`
}

/** Read one stored completed reply; queued successors and synthetic text are excluded. */
export function source(messages: MessageV2.WithParts[], session: string, message: string) {
  const end = messages.findIndex((row) => row.info.id === message && row.info.sessionID === session)
  if (end < 0) return undefined
  const reply = messages[end]
  if (
    reply.info.role !== "assistant" ||
    reply.info.error ||
    reply.info.summary ||
    reply.info.finish !== "stop" ||
    typeof reply.info.time.completed !== "number" ||
    !Number.isFinite(reply.info.time.completed)
  )
    return undefined
  const parent = reply.info.parentID
  const index = messages.findIndex((row) => row.info.id === parent && row.info.sessionID === session)
  if (index < 0 || index >= end) return undefined
  const user = messages[index]
  if (user.info.role !== "user") return undefined
  const text = (parts: MessageV2.Part[], id: string) =>
    MemoryRedact.text(
      parts
        .filter(
          (part) =>
            part.sessionID === session &&
            part.messageID === id &&
            part.type === "text" &&
            !part.synthetic &&
            !part.ignored,
        )
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n\n")
        .trim(),
    )
  const parts = messages
    .slice(index + 1, end + 1)
    .filter(
      (row) =>
        row.info.sessionID === session &&
        row.info.role === "assistant" &&
        row.info.parentID === user.info.id &&
        !row.info.summary,
    )
    .flatMap((row) => row.parts.filter((part) => part.sessionID === session && part.messageID === row.info.id))
  // A manual Memory change owns this turn even when declined or unconfirmed.
  // Automatic extraction must not append the same facts after that decision.
  if (parts.some((part) => part.type === "tool" && part.tool === "second_brain_manage")) return undefined
  const tools = parts.flatMap((part) => {
    if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return []
    const value = part.state.status === "completed" ? part.state.output : part.state.error
    return [
      {
        id: part.id,
        name: part.tool,
        status: part.state.status,
        text: MemoryRedact.text(value).trim(),
      },
    ]
  })
  const value = {
    user: { id: user.info.id, text: text(user.parts, user.info.id) },
    assistant: { id: reply.info.id, text: text(reply.parts, reply.info.id) },
    tools,
  }
  if (
    value.user.text.length > 16000 ||
    value.assistant.text.length > 16000 ||
    tools.length > 16 ||
    tools.some((tool) => tool.text.length > 4000) ||
    Buffer.byteLength(JSON.stringify(value)) > 24000
  )
    throw new Error("Personal capture omitted: original source exceeds the bounded extraction size")
  if (!Schema.is(CaptureSource)(value)) return undefined
  const observed = new Date(reply.info.time.completed).toISOString()
  return { source: value, observed_utc: observed, source_sha256: digest(observed, value) }
}

/** Model attribution must point to actual spans of the appropriate original source. */
export function entries(value: unknown, source: CaptureSource) {
  if (!Schema.is(CaptureEntries)(value)) throw new Error("Capture extraction does not match the bounded entry schema")
  const keys = new Set<string>()
  for (const [index, entry] of value.entries()) {
    const reason = keys.has(entry.key)
      ? "duplicate_key"
      : MemoryRedact.has(entry.text)
        ? "secret_text"
        : /(^|[-_])(password|secret|credential|token|medical|health|financial|bank)([-_]|$)/.test(entry.key)
          ? "restricted_key"
          : undefined
    if (reason) {
      log.warn("capture entry rejected", { reason, index, origin: entry.origin })
      throw new CaptureRejected(reason)
    }
    keys.add(entry.key)
    const sources =
      entry.origin === "user_statement"
        ? [source.user]
        : entry.origin === "assistant_interpretation"
          ? [source.assistant]
          : source.tools
    for (const evidence of entry.evidence) {
      const original = sources.find((row) => row.id === evidence.id)
      if (
        !original ||
        evidence.start >= evidence.end ||
        evidence.end > original.text.length ||
        !original.text.slice(evidence.start, evidence.end).trim()
      )
        throw new Error("Capture evidence does not identify an actual original source span")
    }
  }
  return value
}
