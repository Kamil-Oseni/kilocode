import { createHash } from "node:crypto"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RayaGoal } from "@/kilocode/goal"
import type { RayaTask } from "."
import { bound as reviewed } from "@/kilocode/goal/review-source"
import { isDeepStrictEqual } from "node:util"

/** Bind saved output to the original completed turn; this does not verify its claims. */
export function final(
  run: RayaTask.Run,
  goal: RayaGoal.State,
  rows: readonly SessionV1.WithParts[],
  blank = false,
  missing = false,
) {
  const dispatch = goal.dispatch
  const accepted = goal.review?.status === "accepted" && reviewed(goal)
  if (
    goal.status !== "complete" ||
    run.goalCreatedAt !== goal.createdAt ||
    goal.routine?.agentID !== run.agentID ||
    goal.routine.runID !== run.id ||
    goal.routine.sessionID !== run.sessionID ||
    !isDeepStrictEqual(goal.routine.contract, run.contract) ||
    !goal.intent ||
    !dispatch ||
    (dispatch.intent !== goal.intent && !accepted) ||
    dispatch.phase !== "finished" ||
    dispatch.outcome !== "completed" ||
    !dispatch.messageID ||
    !dispatch.assistantID ||
    !Number.isFinite(dispatch.finishedAt)
  )
    return undefined
  const user = rows.find((row) => row.info.id === dispatch.messageID)
  if (user?.info.role !== "user" || user.info.sessionID !== run.sessionID) return undefined
  const replies = rows.filter((row) => row.info.role === "assistant" && row.info.parentID === dispatch.messageID)
  const answer = replies.toSorted((a, b) => a.info.id.localeCompare(b.info.id)).at(-1)
  if (
    !answer ||
    answer.info.role !== "assistant" ||
    answer.info.id !== dispatch.assistantID ||
    answer.info.sessionID !== run.sessionID ||
    answer.info.error ||
    answer.info.finish !== "stop" ||
    answer.info.time.completed !== dispatch.finishedAt ||
    answer.info.time.completed === undefined ||
    answer.info.time.completed < (dispatch.startedAt ?? dispatch.queuedAt) ||
    replies.some((row) =>
      row.parts.some(
        (part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
      ),
    )
  )
    return undefined
  if (
    run.trace &&
    (run.trace.goalCreatedAt !== goal.createdAt ||
      !run.trace.turns.some(
        (turn) =>
          turn.turnID === dispatch.messageID && turn.messages.some((message) => message.messageID === answer.info.id),
      ))
  )
    return undefined
  const parts = answer.parts.filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
  if (parts.some((part) => part.sessionID !== run.sessionID || part.messageID !== answer.info.id)) return undefined
  const summary = parts.map((part) => (part.type === "text" ? part.text : "")).join("")
  if (parts.length ? !blank && !summary.trim() : !missing) return undefined
  return {
    summary,
    report: {
      version: 1 as const,
      sessionID: run.sessionID,
      messageID: answer.info.id,
      parentID: dispatch.messageID,
      at: answer.info.time.completed,
      partIDs: parts.map((part) => part.id),
      dispatchID: dispatch.id,
      goalCreatedAt: goal.createdAt,
      goalIntent: dispatch.intent,
      ...(accepted ? { acceptedIntent: goal.intent } : {}),
      sha256: createHash("sha256").update(summary).digest("hex"),
    },
  }
}
