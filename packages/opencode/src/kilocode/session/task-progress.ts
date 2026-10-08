import { Effect } from "effect"
import type { Session } from "@/session/session"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { MessageID, SessionID } from "@/session/schema"
import type * as TaskWorker from "./task-worker"

const future =
  /^I(?:['’]ll| will| am going to|['’]m going to)\s+(?:(?:first|now)\s+)?(?:read|write|edit|inspect|check|search|run|execute|create|save|verify|test|update|delete|remove|copy|open|look)\b/i

/** An announced next action is provisional, not evidence that the action happened. */
export function announced(message: SessionV1.WithParts, objective: string) {
  if (
    message.info.role !== "assistant" ||
    message.info.finish !== "stop" ||
    message.info.error ||
    message.info.structured !== undefined ||
    message.parts.some((part) => part.type === "tool")
  )
    return false
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
  return future.test(text) && !objective.includes(text)
}

const reminder =
  "Your previous response announced work you would do; it did not finish that work. Continue the assigned objective now within this same worker input using the existing authorized tools. Finish dependent operations and verify their results before returning. If a concrete blocker prevents progress, report it explicitly. Respect cancellation, permissions and the existing step cap. Do not create another Task or ask the parent to repeat this assignment. If the assignment only requests an explanation or literal text, give that requested final response directly."

/** Only an exact live Task receipt can request this same-input checkpoint. */
export const checkpoint = (
  sessions: Pick<Session.Interface, "get" | "messages">,
  workers: Pick<TaskWorker.Interface, "current">,
  sessionID: SessionID,
  messageID: MessageID,
  message: SessionV1.WithParts | undefined,
) =>
  Effect.gen(function* () {
    if (!message || message.info.role !== "assistant" || message.info.parentID !== messageID) return undefined
    const current = yield* workers.current
    if (current?.sessionID !== sessionID || current.messageID !== messageID) return undefined
    const child = yield* sessions.get(sessionID)
    if (!child.parentID) return undefined
    const history = yield* sessions.messages({ sessionID })
    const input = history.find((row) => row.info.id === messageID && row.info.role === "user")
    if (!input) return undefined
    if (!announced(message, "")) return undefined
    const rows = yield* sessions.messages({ sessionID: child.parentID })
    const parts = rows.flatMap((row) => (row.info.role === "assistant" ? row.parts : []))
    const receipts = parts.filter(
      (part) =>
        part.type === "tool" &&
        part.tool === "task" &&
        part.state.status === "running" &&
        part.state.metadata?.parentSessionId === child.parentID &&
        part.state.metadata?.sessionId === sessionID &&
        part.state.metadata?.childMessageID === messageID,
    )
    if (receipts.length !== 1) return undefined
    const receipt = receipts[0]
    if (receipt.type !== "tool" || receipt.state.status !== "running") return undefined
    const brief = receipt.state.input.brief
    const objective =
      typeof brief === "object" && brief !== null && "objective" in brief && typeof brief.objective === "string"
        ? brief.objective
        : typeof receipt.state.input.prompt === "string"
          ? receipt.state.input.prompt
          : ""
    if (!announced(message, objective)) return undefined
    if (
      parts.filter(
        (part) => part.type === "tool" && part.messageID === receipt.messageID && part.callID === receipt.callID,
      ).length !== 1
    )
      return undefined
    return reminder
  })
