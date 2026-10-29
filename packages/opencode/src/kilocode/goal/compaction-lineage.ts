import type { Session } from "@/session/session"
import { Schema } from "effect"
import { record } from "@/kilocode/task/continuation"
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

/** Follow only complete copied inputs through a bounded, persisted automatic compaction chain. */
export function replayed(
  rows: readonly SessionV1.WithParts[],
  session: Session.Info,
  goal: RayaGoal.State,
  input: string,
  worker: string,
) {
  const dispatch = goal.dispatch
  if (
    rows.length > 128 ||
    JSON.stringify(rows).length > 2 * 1024 * 1024 ||
    goal.status !== "active" ||
    goal.completion === "reply" ||
    !goal.intent ||
    dispatch?.phase !== "started" ||
    dispatch.intent !== goal.intent ||
    dispatch.worker !== worker ||
    !dispatch.messageID ||
    !goal.inputs?.includes(dispatch.messageID) ||
    rows.findLast((row) => row.info.role === "user")?.info.id !== input ||
    new Set(rows.map((row) => row.info.id)).size !== rows.length ||
    rows.some(
      (row, idx) =>
        row.info.sessionID !== session.id ||
        (idx > 0 &&
          (rows[idx - 1].info.id >= row.info.id || rows[idx - 1].info.time.created > row.info.time.created)) ||
        row.parts.some((part) => part.sessionID !== session.id || part.messageID !== row.info.id),
    )
  )
    return false
  if (goal.routine) {
    const identity = Schema.decodeUnknownOption(record)(session.metadata?.rayaRoutine)
    if (
      identity._tag !== "Some" ||
      goal.routine.sessionID !== session.id ||
      goal.routine.agentID !== identity.value.agentID ||
      goal.routine.runID !== identity.value.runID
    )
      return false
  }
  const user = rows.find((row) => row.info.id === dispatch.messageID)
  if (user?.info.role !== "user") return false
  const part = user.parts.find((part) => part.type === "text" && part.metadata?.["raya.input.complete"])
  const proof = part?.type === "text" ? part.metadata?.["raya.input.complete"] : undefined
  if (!proof || typeof proof !== "object" || !("messageID" in proof) || typeof proof.messageID !== "string")
    return false
  const source = rows.find((row) => row.info.id === proof.messageID)
  if (
    source?.info.role !== "user" ||
    !goal.inputs.includes(source.info.id) ||
    !InputReceipt.complete(source, session.id, source.info.id)
  )
    return false
  const start = rows.indexOf(source)
  const end = rows.findIndex((row) => row.info.id === input)
  if (end <= start || rows.findIndex((row) => row.info.id === user.info.id) < start) return false
  const security = (row: SessionV1.User) => ({
    agent: row.agent,
    model: row.model,
    tools: row.tools,
    system: row.system,
    format: row.format,
  })
  const payload = (row: SessionV1.WithParts) =>
    row.parts.map((part) => {
      const { id: _id, messageID: _message, sessionID: _session, ...body } = part
      return body
    })
  const users = rows.slice(start + 1, end + 1).filter((row) => row.info.role === "user")
  if (!users.length || users.length > 16) return false
  const markers = new Set<string>()
  for (const intake of users) {
    if (intake.parts.length === 1 && intake.parts[0]?.type === "compaction") {
      if (!intake.parts[0].auto || intake.parts[0].overflow === true) return false
      markers.add(intake.info.id)
      continue
    }
    const message = rows.find((row) => row.info.role === "assistant" && row.info.parentID === intake.info.id)
    const idx = rows.indexOf(intake)
    const summary = rows[idx - 1]
    if (
      intake.info.role !== "user" ||
      !message ||
      summary?.info.role !== "assistant" ||
      !markers.delete(summary.info.parentID) ||
      !isDeepStrictEqual(security(source.info), security(intake.info)) ||
      !isDeepStrictEqual(payload(source), payload(intake)) ||
      !compacted(rows, source, intake, message, goal)
    )
      return false
  }
  return markers.size === 0 && users.at(-1)?.info.id === input
}
