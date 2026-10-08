import type { MessageV2 } from "@/session/message-v2"
import { RayaChief } from "../chief"

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
  if (request !== RayaChief.request(session.metadata) || !question(request)) return false
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
          part.state.status === "completed",
      ),
  )
}

function question(request: string) {
  if (
    request.length > 1000 ||
    !/^(?:what|which|who|when|where|how|did|do|does|have|has|is|are|remind me|can you remind)\b/i.test(request)
  )
    return false
  if (!/\b(?:memory|remember|saved|notes?|preferences?)\b/i.test(request)) return false
  return !/\b(?:install|implement|fix|deploy|delete|forget|save|create|edit|update|send|purchase|buy|execute|run|build|commit|push|merge|schedule|start|stop|change|configure|set up)\b/i.test(
    request,
  )
}
