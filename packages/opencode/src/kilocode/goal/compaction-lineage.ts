import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RayaGoal } from "."
import { RayaChief } from "@/kilocode/chief"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"
import { isDeepStrictEqual } from "node:util"

/** Only the durable automatic compaction producer chain retains the original authored request. */
export function compacted(
  rows: readonly SessionV1.WithParts[],
  user: SessionV1.WithParts,
  intake: SessionV1.WithParts,
  message: SessionV1.WithParts,
  goal?: RayaGoal.State,
) {
  if (
    (goal && (goal.status !== "active" || goal.completion === "reply")) ||
    user.info.role !== "user" ||
    intake.info.role !== "user" ||
    message.info.role !== "assistant"
  )
    return false
  const idx = rows.findIndex((row) => row.info.id === intake.info.id)
  const summary = rows[idx - 1]
  if (
    summary?.info.role !== "assistant" ||
    !summary.info.summary ||
    summary.info.agent !== "compaction" ||
    summary.info.finish !== "stop" ||
    summary.info.error ||
    !summary.info.time.completed ||
    summary.info.time.completed > intake.info.time.created
  )
    return false
  const origin = summary.info.parentID
  const parent = rows.findIndex((row) => row.info.id === origin)
  const authored = rows.findIndex((row) => row.info.id === user.info.id)
  const marker = rows[parent]
  if (
    authored < 0 ||
    parent <= authored ||
    parent >= idx - 1 ||
    marker?.info.role !== "user" ||
    marker.info.agent !== user.info.agent ||
    intake.info.agent !== user.info.agent ||
    marker.info.model.providerID !== user.info.model.providerID ||
    marker.info.model.modelID !== user.info.model.modelID ||
    intake.info.model.providerID !== user.info.model.providerID ||
    intake.info.model.modelID !== user.info.model.modelID ||
    marker.parts.length !== 1 ||
    marker.parts[0]?.type !== "compaction" ||
    !marker.parts[0].auto ||
    marker.parts[0].overflow === true ||
    rows.slice(authored + 1, idx).some((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts)) ||
    !summary.parts.some((part) => part.type === "text" && !!part.text.trim())
  )
    return false
  const part = intake.parts[0]
  if (InputReceipt.complete(user, user.info.sessionID, user.info.id)) {
    const payload = (row: SessionV1.WithParts) =>
      row.parts.map((part) => {
        const clean = InputReceipt.clean(part)
        const { id: _id, messageID: _message, sessionID: _session, ...body } = clean
        return body
      })
    if (
      intake.parts.length === user.parts.length &&
      isDeepStrictEqual(payload(user), payload(intake)) &&
      [user, marker, summary, intake, message].every((row) => row.info.sessionID === message.info.sessionID)
    )
      return true
  }
  return (
    intake.parts.length === 1 &&
    part?.type === "text" &&
    part.synthetic === true &&
    part.ignored !== true &&
    part.metadata?.compaction_continue === true &&
    part.text ===
      "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed." &&
    [user, marker, summary, intake, message].every((row) => row.info.sessionID === message.info.sessionID)
  )
}
