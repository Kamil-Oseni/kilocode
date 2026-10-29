import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import type { RayaGoal } from "@/kilocode/goal"
import type { RayaTask } from "."
import type { RayaTaskSnapshot } from "./snapshot"
import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"
import { record } from "./continuation"

/** Identify a failed original final turn, never a successful report or an unfinished reply. */
export function failure(
  run: RayaTask.Run,
  goal: RayaGoal.State,
  session: Session.Info,
  snapshot: typeof RayaTaskSnapshot.Info.Type,
  rows: readonly SessionV1.WithParts[],
) {
  const dispatch = goal.dispatch
  const identity = Schema.decodeUnknownOption(record)(session.metadata?.rayaRoutine)
  const location = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
  const agent =
    snapshot.definition.mode?.trim() ||
    (snapshot.definition.role === "designer"
      ? "designer"
      : ["coder", "code"].includes(snapshot.definition.role)
        ? "coder"
        : "generalist")
  if (
    !["running", "error"].includes(run.status) ||
    goal.status !== "complete" ||
    !goal.intent ||
    goal.replyRecovery ||
    goal.review ||
    goal.budgetHit ||
    goal.createdAt !== run.goalCreatedAt ||
    goal.routine?.agentID !== run.agentID ||
    goal.routine.runID !== run.id ||
    goal.routine.sessionID !== run.sessionID ||
    !isDeepStrictEqual(goal.routine.contract, run.contract) ||
    session.id !== run.sessionID ||
    session.agent !== agent ||
    identity._tag !== "Some" ||
    identity.value.agentID !== run.agentID ||
    identity.value.runID !== run.id ||
    identity.value.scheduleVersion !== (run.scheduleVersion ?? 1) ||
    !isDeepStrictEqual(identity.value.trigger, run.trigger) ||
    snapshot.runID !== run.id ||
    snapshot.agentID !== run.agentID ||
    snapshot.sessionID !== run.sessionID ||
    snapshot.at !== run.at ||
    snapshot.definition.id !== run.agentID ||
    (snapshot.definition.scheduleVersion ?? 1) !== (run.scheduleVersion ?? 1) ||
    snapshot.objective !== goal.objective ||
    !isDeepStrictEqual(snapshot.contract, run.contract) ||
    !isDeepStrictEqual(identity.value.contract, run.contract) ||
    !isDeepStrictEqual(snapshot.outputs, identity.value.outputs) ||
    (snapshot.definition.dir !== undefined && location(snapshot.definition.dir) !== location(session.directory)) ||
    dispatch?.phase !== "finished" ||
    dispatch.outcome !== "error" ||
    dispatch.intent !== goal.intent ||
    !dispatch.worker ||
    !dispatch.messageID ||
    !dispatch.assistantID ||
    !dispatch.startedAt ||
    !dispatch.finishedAt ||
    dispatch.startedAt < goal.createdAt ||
    dispatch.finishedAt < dispatch.startedAt ||
    !goal.inputs?.includes(dispatch.messageID) ||
    rows.length > 128 ||
    rows.some(
      (row) =>
        row.info.sessionID !== run.sessionID ||
        row.parts.length > 256 ||
        row.parts.some((part) => part.sessionID !== run.sessionID || part.messageID !== row.info.id),
    ) ||
    Buffer.byteLength(JSON.stringify(rows)) > 2 * 1024 * 1024 ||
    new Set(rows.map((row) => row.info.id)).size !== rows.length
  )
    return undefined
  const user = rows.findLast((row) => row.info.role === "user")
  const answer = rows.findLast((row) => row.info.role === "assistant")
  if (
    user?.info.role !== "user" ||
    user.info.id !== dispatch.messageID ||
    user.info.agent !== agent ||
    answer?.info.role !== "assistant" ||
    answer.info.parentID !== user.info.id ||
    answer.info.id !== dispatch.assistantID ||
    answer.info.agent !== agent ||
    answer.info.providerID !== user.info.model.providerID ||
    answer.info.modelID !== user.info.model.modelID ||
    !answer.info.error ||
    answer.info.time.completed !== dispatch.finishedAt ||
    answer.info.time.created < dispatch.startedAt ||
    (snapshot.definition.model &&
      (snapshot.definition.model.providerID !== user.info.model.providerID ||
        snapshot.definition.model.id !== user.info.model.modelID)) ||
    rows.some(
      (row) =>
        row.info.role === "assistant" &&
        row.info.parentID === user.info.id &&
        row.parts.some((part) => part.type === "tool" && ["pending", "running"].includes(part.state.status)),
    )
  )
    return undefined
  const error = answer.info.error
  const data = "data" in error ? error.data : undefined
  const detail =
    data && typeof data === "object" && "message" in data && typeof data.message === "string"
      ? data.message
      : error.name
  const summary = `The worker's original final reply failed: ${detail.slice(0, 2000)}`
  if (
    run.status === "error" &&
    (run.blockedReason !== summary || run.outcome?.summary !== summary || run.outcome?.report || run.outcome.reply)
  )
    return undefined
  return { summary }
}
