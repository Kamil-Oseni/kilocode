import type { MessageV2 } from "@/session/message-v2"
import { RayaChief } from "../chief"

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
  return !/\bplease\b|(?:^|[.;]\s*|\b(?:and|then|also|now)\s+(?:then\s+)?|\byou (?:to|must|should|need to)\s+)(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|execute|run|build|commit|push|merge|schedule|start|stop|configure|control|apply|revert|undo|redo)\b/i.test(
    match[1],
  )
}

/** A bounded preference statement supplies its own facts; status is not saved-note evidence. */
function statement(request: string) {
  const text = request
    .replace(/\.\s*Do not change lights or place orders\.?$/i, "")
    .replace(/\.\s*Keep the Memory tab for manually inspecting and adjusting settings\.?$/i, "")
  if (!/^(?:For [^.!?`]{1,120}, )?I (?:prefer|like|dislike|would prefer) [^.!?`]+\.?$/i.test(text)) return false
  return !/\b(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|control|apply|revert|undo|redo|turn|place|adjust|keep|recall|remember|retrieve)\b/i.test(
    text,
  )
}

/** A personal-memory question can finish after its own read, without closing a work goal. */
export function settled(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; parentID?: string; metadata?: Record<string, unknown> },
  user: string,
) {
  if (session.parentID || RayaChief.phase(session.metadata) !== "route") return false
  const current = messages.findLast((row) => row.info.role === "user")
  if (!current || current.info.id !== user || current.info.sessionID !== session.id) return false
  const request = RayaChief.requestText(current.parts)
  const state = status(request)
  if (request !== RayaChief.request(session.metadata) || (!state && !question(request))) return false
  return messages.some(
    (row) =>
      row.info.role === "assistant" &&
      row.info.parentID === user &&
      row.info.sessionID === session.id &&
      !row.info.error &&
      !row.info.summary &&
      row.parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool === "second_brain_recall" &&
          part.messageID === row.info.id &&
          part.sessionID === session.id &&
          part.state.status === "completed" &&
          (state
            ? part.state.input.action === "status" && Object.keys(part.state.input).length === 1
            : !("action" in part.state.input) &&
              typeof part.state.input.query === "string" &&
              !!part.state.input.query.trim()),
      ),
  )
}

/** Setup state can answer only an explicit status question, never a question about saved facts. */
function status(request: string) {
  return /^(?:is (?:my |personal |raya(?:'s)? )?memory (?:configured|connected|ready|enabled|disabled|paused|saving|working|set up)|what is (?:my |personal |raya(?:'s)? )?memory(?:'s)? (?:setup )?status)\??$/i.test(
    request,
  )
}

function question(request: string) {
  if (
    request.length > 1000 ||
    !/^(?:please )?(?:recall|what|which|who|when|where|how|did|do|does|have|has|is|are|remind me|can you remind)\b/i.test(
      request,
    )
  )
    return false
  if (!/\b(?:memory|remember|saved|notes?|preferences?)\b/i.test(request)) return false
  const text = request.replace(/[.!?]\s*(?:do not|don't)\s+change (?:files|lights)(?: or (?:files|lights))?[.!]?$/i, "")
  return !/\b(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|set up)\b/i.test(
    text,
  )
}
