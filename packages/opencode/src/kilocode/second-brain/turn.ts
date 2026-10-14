import type { MessageV2 } from "@/session/message-v2"
import path from "node:path"
import { Result as Decode, Schema } from "effect"
import { RayaChief } from "../chief"
import { Request, Result } from "./protocol"
import { valid } from "./reply"
import { requested } from "./setup"
import { selected } from "./capture-state"
import { requested as managing, command as managed, Params } from "./management"
import { current as projection } from "./management-source"
import { current as refusal } from "./refusal"

/** Local pre-dispatch command refusals cannot close goals or authorize replacement facts. */
export function refused(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; directory: string; parentID?: string; metadata?: Record<string, unknown> },
  user: string,
) {
  if (session.parentID || session.metadata?.rayaRoutine !== undefined || RayaChief.phase(session.metadata) !== "route")
    return undefined
  const source = projection(messages, session, user)
  if (!source || source.text !== RayaChief.request(session.metadata)) return undefined
  return refusal(messages, source, session.directory)
}

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
    /^([^?!`]+?)\s+Please (?:just )?acknowledge (?:(?:this|my|that) preference|it|that)(?: in one sentence)?(?:[.;]\s*(?:do not|don't)\b[^.!?]*)?[.!]?$/i.exec(
      request,
    )
  if (!match) return statement(request)
  const stated = /^My (?:(?:saved|stated) )?(?:(?:voice|speech|reply) )?preference is\s+[^.!?;`:\s]/i.test(match[1])
  if (
    stated &&
    /(?:^|[.;]\s*|\b(?:and|then|also|now)\s+(?:then\s+)?|\b(?:you|Raya|SecondBrain) (?:(?:to|must|should|needs? to) )?)(?:recall|retrieve|remember|search|query|tell|remind)\b/i.test(
      match[1],
    )
  )
    return false
  if (!/\bI (?:prefer|like|dislike|want|would prefer|would like)\b/i.test(match[1]) && !stated) return false
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
  const mode = selected(request)
  const change = managing(request)
  if (
    request !== RayaChief.request(session.metadata) ||
    (!state && !configuring && !mode && !change && !question(request))
  )
    return false
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
          part.tool !== (change ? "second_brain_manage" : "second_brain_recall") ||
          part.messageID !== row.info.id ||
          part.sessionID !== session.id ||
          part.state.status !== "completed"
        )
          return false
        const input = part.state.input
        if (change) {
          const args = Schema.decodeUnknownResult(Params, { onExcessProperty: "error" })(input)
          const source = projection(messages, session, user)
          if (Decode.isFailure(args) || !source || Buffer.byteLength(part.state.output, "utf8") > 200000) return false
          const original = (() => {
            try {
              return managed(source, args.success)
            } catch {
              return undefined
            }
          })()
          if (!original) return false
          const value = (() => {
            try {
              return JSON.parse(part.state.output) as unknown
            } catch {
              return undefined
            }
          })()
          const decoded = Schema.decodeUnknownResult(Result, { onExcessProperty: "error" })(value)
          const receipt = Schema.decodeUnknownResult(Request, { onExcessProperty: "error" })({
            id: part.callID,
            sessionID: current.info.sessionID,
            project: session.directory,
            command: original,
          })
          return (
            Decode.isSuccess(receipt) &&
            Decode.isSuccess(decoded) &&
            decoded.success.action === "manage" &&
            !decoded.success.question &&
            valid(receipt.success, decoded.success)
          )
        }
        if (
          state || configuring || mode
            ? input.action !== (mode ?? (configuring ? "setup" : "status")) || Object.keys(input).length !== 1
            : Object.keys(input).some(
                (key) => key !== "query" && key !== "budget" && (key !== "action" || input.action !== "query"),
              )
        )
          return false
        if (Buffer.byteLength(part.state.output, "utf8") > 200000) return false
        const value = (() => {
          try {
            return JSON.parse(part.state.output) as unknown
          } catch {
            return undefined
          }
        })()
        const decoded = Schema.decodeUnknownResult(Result, { onExcessProperty: "error" })(value)
        if (Decode.isFailure(decoded)) return false
        // Session storage can retain forward slashes while the actual read uses
        // InstanceState's resolved directory. Never derive authority from the reply.
        const project =
          !state &&
          !configuring &&
          !mode &&
          decoded.success.action === "context" &&
          path.isAbsolute(session.directory) &&
          path.resolve(session.directory) === decoded.success.project
            ? path.resolve(session.directory)
            : session.directory
        const command = Schema.decodeUnknownResult(Request, { onExcessProperty: "error" })({
          id: part.callID,
          sessionID: session.id,
          project,
          command: mode
            ? { action: "captureState", mode }
            : configuring
              ? { action: "setup", stage: "inspect" }
              : state
                ? input
                : { ...input, action: "context", budget: input.budget ?? 6000 },
        })
        return Decode.isSuccess(command) && valid(command.success, decoded.success)
      }),
  )
}

/** Setup state can answer only an explicit status question, never a question about saved facts. */
function status(request: string) {
  return /^(?:is (?:my |personal |raya(?:'s)? )?memory (?:configured|connected|ready|enabled|disabled|paused|saving|working|set up)|what is (?:my |personal |raya(?:'s)? )?memory(?:'s)? (?:setup )?status)\??$/i.test(
    request,
  )
}

/** Familiar personal fact questions do not require the user to mention the Memory implementation. */
function personal(request: string) {
  const text = request.replace(/\s+Cite (?:the saved |the |my )?sources[.!]?$/i, "").replace(/^please /i, "")
  return (
    /^(?:what|which) (?:(?:local|preferred|selected) )?(?:voice|speech engine|transcription engine|TTS engine|STT engine|embedding model|memory model|fallback)(?: and (?:fallback|voice|speech engine))? did I (?:choose|pick|select)\??$/i.test(
      text,
    ) ||
    /^(?:what (?:is|was)|what's) my (?:(?:current|preferred) )?(?:shopping list|grocery list|timezone|time zone|city|voice|speech engine|transcription engine|embedding model|fallback)\??$/i.test(
      text,
    ) ||
    /^what (?:groceries|grocery items) (?:am I missing|do I lack|do I need|are missing from my shopping list)\??$/i.test(
      text,
    ) ||
    /^where (?:do|did) I live\??$/i.test(text)
  )
}

/** A checkpoint summary reports saved facts, without requesting the actions it records. */
function checkpoint(request: string) {
  const text = request.replace(/\.\s*Do not save anything or change settings or devices\.?$/i, "")
  const match =
    /^(?:please )?(?:use|consult) (?:my |the )?(?:(?:saved|local) )?(?:SecondBrain|Memory) notes? to (?:summarize|recap) ((?:the |my |a )?(?:dated )?(?:project )?(?:checkpoint|outcome|status|history|preferences|decision)(?: (?:for|on|from|of) [^.!?;`]{1,160})?)\.\s*(?:Tell me what was verified(?: and mention the tool-call recovery recorded there)?\.\s*)?Cite (?:the saved |the |my )?(?:note|notes|sources)\.?$/i.exec(
      text,
    )
  if (!match) return false
  return !/\b(?:install|implement|fix|deploy|delete|forget|save|create|edit|send|purchase|buy|order|pay|checkout|transfer|book|make|call|contact|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|control|apply|revert|undo|redo|then|now|immediately)\b/i.test(
    match[1],
  )
}

function question(request: string) {
  if (request.length <= 1000 && checkpoint(request)) return true
  const original = request
    .replace(
      /[.!?]\s*(?:do not|don't)\s+(?:change (?:anything|files|lights|(?:any )?settings)(?: or (?:files|lights|control (?:any )?devices))?|control (?:any )?devices)[.!]?$/i,
      "",
    )
    .replace(/^(?:please )?search (?:my |the )?saved (?:SecondBrain|Memory) notes?\s*:\s*/i, "")
    .replace(
      /^(?:please )?(?:use|consult) (?:my |the )?(?:(?:saved|local) )?(?:(?:SecondBrain|Memory)(?: notes?)?|notes?) to (?:tell me|explain)\s+/i,
      "",
    )
    .replace(/^(?:please )?tell me (?=(?:what|which|who|when|where|how|did|do|does|have|has|is|are)\b)/i, "")
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
  if (!/\b(?:memory|remember|saved|notes?|preferences?)\b/i.test(request) && !personal(text)) return false
  return (
    !/\b(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|order|orders|place|pay|checkout|transfer|book|make|call|contact|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|set up)\b/i.test(
      text,
    ) &&
    !/(?:^|[.!?;,]\s*|\b(?:and|then|also|now)\s+(?:then\s+)?|\b(?:you|Raya|SecondBrain) (?:(?:to|must|should|needs? to) )?)(?:please )?(?:control|apply|revert|undo|redo)\b/i.test(
      text,
    )
  )
}
