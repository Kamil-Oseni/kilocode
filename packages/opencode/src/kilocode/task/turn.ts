import type { MessageV2 } from "@/session/message-v2"
import { RayaChief } from "../chief"

export const instruction =
  "The requested organization work was saved and assigned. Acknowledge its observed saved state briefly. Assignment is not completion of the worker's job: do not claim that deliverables are finished, verified, sent or published. Do not assign the same work again or poll merely to finish this chat turn."

/** Release only the current root request after its actual saved work assignment. */
export function assigned(
  messages: readonly MessageV2.WithParts[],
  session: { id: string; parentID?: string; metadata?: Record<string, unknown> },
  user: string,
) {
  if (
    session.parentID ||
    session.metadata?.rayaRoutine !== undefined ||
    session.metadata?.["raya.goal.open"] === true ||
    RayaChief.phase(session.metadata) !== "route"
  )
    return false
  const current = messages.findLast((row) => row.info.role === "user")
  if (
    !current ||
    current.info.role !== "user" ||
    current.info.agent !== "auto" ||
    current.info.id !== user ||
    current.info.sessionID !== session.id ||
    current.info.format?.type === "json_schema"
  )
    return false
  const request = RayaChief.requestText(current.parts)
  if (request !== RayaChief.request(session.metadata) || !RayaChief.routine(request)) return false
  const parts = messages.flatMap((row) =>
    row.info.role === "assistant" &&
    row.info.parentID === user &&
    row.info.sessionID === session.id &&
    !row.info.error &&
    !row.info.summary
      ? row.parts.filter(
          (part) => part.type === "tool" && part.messageID === row.info.id && part.sessionID === session.id,
        )
      : [],
  )
  if (parts.some((part) => part.type === "tool" && ["pending", "running"].includes(part.state.status))) return false
  const part = parts.findLast(
    (part) =>
      part.type === "tool" &&
      ["schedule_task", "create_organization", "update_routine", "update_organization", "assign_organization_work"].includes(
        part.tool,
      ),
  )
  if (part?.type !== "tool" || part.tool !== "assign_organization_work" || part.state.status !== "completed") return false
  const result = part.state.metadata
  const input = part.state.input
  return (
    result.requestStatus === "complete" &&
    typeof result.delegationID === "string" &&
    result.delegationID.trim().length > 0 &&
    typeof result.organizationID === "string" &&
    result.organizationID === input.organizationID &&
    Number.isSafeInteger(result.organizationRevision) &&
    result.organizationRevision === input.expectedRevision &&
    typeof result.senderID === "string" &&
    result.senderID === input.senderID &&
    typeof result.recipientID === "string" &&
    result.recipientID === input.recipientID &&
    typeof result.state === "string" &&
    ["queued", "accepted", "running", "needs_input", "completed"].includes(result.state)
  )
}
