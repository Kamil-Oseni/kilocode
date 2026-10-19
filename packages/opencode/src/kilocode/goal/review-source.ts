import type { RayaGoal } from "."

/** Capture only the currently authorized original Routine turn, before review rotates authority. */
export function capture(goal: RayaGoal.State) {
  const dispatch = goal.dispatch
  if (
    !goal.routine ||
    !goal.intent ||
    !dispatch?.messageID ||
    dispatch.intent !== goal.intent ||
    (dispatch.phase !== "started" && dispatch.phase !== "finished") ||
    !goal.inputs?.includes(dispatch.messageID)
  )
    return undefined
  return {
    goalCreatedAt: goal.createdAt,
    dispatchID: dispatch.id,
    messageID: dispatch.messageID,
    intent: dispatch.intent,
  }
}

/** A saved review may retain its original turn across explicit authority rotations only. */
export function bound(goal: RayaGoal.State) {
  const review = goal.review
  const source = review?.source
  const dispatch = goal.dispatch
  if (
    !goal.routine ||
    !source ||
    !dispatch?.messageID ||
    source.goalCreatedAt !== goal.createdAt ||
    source.dispatchID !== dispatch.id ||
    source.messageID !== dispatch.messageID ||
    source.intent !== dispatch.intent ||
    !review ||
    !goal.inputs?.includes(source.messageID) ||
    !Number.isFinite(review.at) ||
    review.at < (dispatch.startedAt ?? dispatch.queuedAt)
  )
    return false
  if (
    review.status === "accepted" &&
    (review.acceptedAt === undefined || !Number.isFinite(review.acceptedAt) || review.acceptedAt < review.at)
  )
    return false
  const criteria =
    goal.criteria
      ?.filter(
        (item) => item.review && goal.audit?.requirements.some((req) => req.criterionID === item.id && req.passed),
      )
      .map((item) => item.id) ?? []
  return (
    criteria.length > 0 &&
    criteria.length === review.criteria.length &&
    criteria.every((id, index) => id === review.criteria[index])
  )
}
