import type { MessageV2 } from "@/session/message-v2"
import { Result as Decode, Schema } from "effect"
import { RayaChief } from "../chief"
import { Request, Result } from "./protocol"
import { valid } from "./reply"
import { requested } from "./setup"

export const acknowledgement =
  "This turn states a personal preference. Briefly acknowledge the user's actual preference in one sentence. Treat references to first-time setup as the preference being described; do not begin setup or ask configuration questions. Preserve the user's restrictions. Do not claim that anything was changed or saved: separately authorized automatic Memory saving runs after the reply and must confirm its own result."

/** An explicit preference acknowledgement has no tool action or goal-completion authority. */
export function acknowledged(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; parentID?: string; metadata?: Record<string, unknown> },
  user: string,
) {
  if (session.parentID || RayaChief.phase(session.metadata) !== "route") return false
  const current = messages.findLast((row) => row.info.role === "user")
  if (!current || current.info.id !== user || current.info.sessionID !== session.id) return false
  if (current.info.role !== "user" || current.info.format?.type === "json_schema") return false
  if (current.parts.some((part) => part.type !== "text")) return false
  const request = RayaChief.requestText(current.parts)
  if (request !== RayaChief.request(session.metadata) || request.length > 1000) return false
  const match =
    /^([^?!`]+?)\s+Please (?:just )?acknowledge (?:this|my|that) preference(?:[.;]\s*(?:do not|don't)\b[^.!?]*)?[.!]?$/i.exec(
      request,
    )
  if (!match) return statement(request)
  if (!/\b(?:I (?:prefer|like|dislike|want|would prefer|would like)|My preference is)\b/i.test(match[1])) return false
  return !/\bplease\b|(?:^|[.;]\s*|\b(?:and|then|also|now)\s+(?:then\s+)?|\b(?:you|Raya|SecondBrain) (?:(?:to|must|should|needs? to) )?)(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|order|place|pay|checkout|transfer|book|make|call|contact|execute|run|build|commit|push|merge|schedule|start|stop|configure|control|apply|revert|undo|redo)\b/i.test(
    match[1],
  )
}

/** A bounded preference statement supplies its own facts; status is not saved-note evidence. */
function statement(request: string) {
  const text = request
    .replace(/\.\s*Do not change lights or place orders\.?$/i, "")
    .replace(/\.\s*Keep the Memory tab for manually inspecting and adjusting settings\.?$/i, "")
  const rows = text.replace(/\.$/, "").split(/\.\s+/)
  if (rows.length > 4) return false
  const items =
    "(?:what I (?:lack|need)|(?:(?:the|my) )?(?:(?:missing|needed) )?(?:groceries|items)(?: (?:that )?I (?:lack|need))?)"
  const list = "(?:(?:a|my|the) )?(?:shopping list|grocery list|list to buy)"
  const assistance = new RegExp(`^(?:remember|track|keep track of) ${items} and (?:keep|maintain) ${list}$`, "i")
  return rows.every((row) => {
    const help =
      /^(?:For [^.!?`]{1,120}, )?(?:I (?:also )?(?:prefer|would prefer) (?:Raya|SecondBrain) to |(?:Raya|SecondBrain) should help me )([^.!?`]+)$/i.exec(
        row,
      )
    // Ongoing assistance is a complete missing-item and list-maintenance description, without an action tail.
    if (
      help &&
      /\b(?:groceries|grocery|shopping)\b/i.test(row) &&
      /\b(?:missing|lack|need)\b/i.test(help[1]) &&
      assistance.test(help[1])
    ) {
      return true
    }
    if (!/^(?:For [^.!?`]{1,120}, )?I (?:also )?(?:prefer|like|dislike|would prefer) [^.!?`]+$/i.test(row)) return false
    return !/\b(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|order|orders|pay|checkout|transfer|book|make|call|contact|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|control|apply|revert|undo|redo|turn|place|adjust|keep|maintain|track|recall|remember|retrieve)\b/i.test(
      row,
    )
  })
}

/** A personal-memory question can finish after its own read, without closing a work goal. */
export function settled(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; directory: string; parentID?: string; metadata?: Record<string, unknown> },
  user: string,
) {
  if (session.parentID || RayaChief.phase(session.metadata) !== "route") return false
  const current = messages.findLast((row) => row.info.role === "user")
  if (!current || current.info.id !== user || current.info.sessionID !== session.id) return false
  const request = RayaChief.requestText(current.parts)
  const state = status(request)
  const configuring = requested(request)
  if (request !== RayaChief.request(session.metadata) || (!state && !configuring && !question(request))) return false
  return messages.some(
    (row) =>
      row.info.role === "assistant" &&
      row.info.parentID === user &&
      row.info.sessionID === session.id &&
      !row.info.error &&
      !row.info.summary &&
      row.parts.some((part) => {
        if (
          part.type !== "tool" ||
          part.tool !== "second_brain_recall" ||
          part.messageID !== row.info.id ||
          part.sessionID !== session.id ||
          part.state.status !== "completed"
        )
          return false
        const input = part.state.input
        if (
          state || configuring
            ? input.action !== (configuring ? "setup" : "status") || Object.keys(input).length !== 1
            : Object.keys(input).some((key) => key !== "query" && key !== "budget")
        )
          return false
        const command = Schema.decodeUnknownResult(Request, { onExcessProperty: "error" })({
          id: part.callID,
          sessionID: session.id,
          project: session.directory,
          command: configuring
            ? { action: "setup", stage: "inspect" }
            : state
              ? input
              : { ...input, action: "context", budget: input.budget ?? 6000 },
        })
        if (Decode.isFailure(command) || Buffer.byteLength(part.state.output, "utf8") > 200000) return false
        const value = (() => {
          try {
            return JSON.parse(part.state.output) as unknown
          } catch {
            return undefined
          }
        })()
        const decoded = Schema.decodeUnknownResult(Result, { onExcessProperty: "error" })(value)
        return Decode.isSuccess(decoded) && valid(command.success, decoded.success)
      }),
  )
}

/** Setup state can answer only an explicit status question, never a question about saved facts. */
function status(request: string) {
  return /^(?:is (?:my |personal |raya(?:'s)? )?memory (?:configured|connected|ready|enabled|disabled|paused|saving|working|set up)|what is (?:my |personal |raya(?:'s)? )?memory(?:'s)? (?:setup )?status)\??$/i.test(
    request,
  )
}

function question(request: string) {
  const original = request
    .replace(/[.!?]\s*(?:do not|don't)\s+change (?:anything|files|lights)(?: or (?:files|lights))?[.!]?$/i, "")
    .replace(/^(?:please )?search (?:my |the )?saved (?:SecondBrain|Memory) notes?\s*:\s*/i, "")
  // Only a single factual preference-purpose question may describe a list "to buy".
  // A second imperative or an urgency/action tail cannot be normalized into recall.
  const topic =
    "(?:(?:(?:the|my|local|Canadian|preferred|available) )?(?:(?:grocery|shopping|delivery) (?:services|options|providers)|stores|retailers|vendors|suppliers))"
  const purpose = new RegExp(
    `\\b(?:for|about|regarding) (?:keeping|maintaining|using|having) (?:a|my|the) (?:grocery |shopping )?list to buy(?: and ${topic}){0,2}(?: in [\\p{L}]+(?: [\\p{L}]+){0,2})?(?=\\??(?:\\s+Cite (?:the saved |the |my )?sources[.!]?)?$)`,
    "iu",
  )
  const text =
    purpose.test(original) &&
    /^[^.!?;`]+\??(?:\s+Cite (?:the saved |the |my )?sources[.!]?)?$/i.test(original) &&
    !/\b(?:then|now|today|tonight|tomorrow|immediately|at once|right away)\b/i.test(original)
      ? original.replace(purpose, (value) => value.replace(/\blist to buy\b/i, "shopping list"))
      : original
  if (
    request.length > 1000 ||
    !/^(?:please )?(?:recall|what|which|who|when|where|how|did|do|does|have|has|is|are|remind me|can you remind)\b/i.test(
      text,
    )
  )
    return false
  if (!/\b(?:memory|remember|saved|notes?|preferences?)\b/i.test(request)) return false
  return !/\b(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|order|orders|place|pay|checkout|transfer|book|make|call|contact|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|set up)\b/i.test(
    text,
  )
}
