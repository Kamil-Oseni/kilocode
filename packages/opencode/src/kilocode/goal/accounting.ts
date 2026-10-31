import type { MessageID, SessionID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RayaGoal } from "."
import { isDeepStrictEqual } from "node:util"

const zero = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

/** Summarize one already-validated goal task graph without reading it again. */
export const sum = (rows: readonly SessionV1.WithParts[], sessionID: SessionID) => {
  const first = new Set(
    rows
      .filter((row) => row.info.sessionID === sessionID)
      .flatMap((row) =>
        row.parts.flatMap((part) => {
          if (part.type !== "tool" || part.tool !== "task" || part.state.status === "pending") return []
          const id = part.state.metadata?.sessionId
          return typeof id === "string" ? [id] : []
        }),
      ),
  )
  const tokens = zero()
  const descendants = zero()
  let cost = 0
  let descendantCost = 0
  for (const row of rows) {
    if (row.info.role !== "assistant") continue
    const child = row.info.sessionID !== sessionID
    if (!child) cost += row.info.cost
    if (first.has(row.info.sessionID)) descendantCost += row.info.cost
    const target = child ? descendants : undefined
    for (const value of [tokens, target]) {
      if (!value) continue
      value.input += row.info.tokens.input
      value.output += row.info.tokens.output
      value.reasoning += row.info.tokens.reasoning
      value.cache.read += row.info.tokens.cache.read
      value.cache.write += row.info.tokens.cache.write
    }
  }
  return { cost: Math.max(cost, descendantCost), descendantCost, tokens, descendantTokens: descendants }
}

const controls = new Set(["create_goal", "get_goal", "update_goal", "update_goal_plan"])

/** Deterministic bookkeeping for an already-validated original finished dispatch; never reopens work. */
export function terminal(
  state: RayaGoal.State,
  sessionID: SessionID,
  rows: readonly SessionV1.WithParts[],
  scope: readonly SessionV1.WithParts[],
): RayaGoal.State {
  const dispatch = state.dispatch
  if (
    state.status !== "complete" ||
    !state.intent ||
    state.selfHealID ||
    !state.auditAttempt?.accepted ||
    !state.audit ||
    !dispatch?.messageID ||
    !dispatch.assistantID ||
    dispatch.intent !== state.intent ||
    dispatch.phase !== "finished" ||
    dispatch.outcome !== "completed"
  )
    return state
  const users = rows.filter((row) => row.info.sessionID === sessionID && row.info.role === "user")
  if (users.toSorted((a, b) => a.info.id.localeCompare(b.info.id)).at(-1)?.info.id !== dispatch.messageID) return state
  const replies = scope.filter(
    (row) =>
      row.info.sessionID === sessionID && row.info.role === "assistant" && row.info.parentID === dispatch.messageID,
  )
  const final = replies.toSorted((a, b) => a.info.id.localeCompare(b.info.id)).at(-1)
  if (
    final?.info.role !== "assistant" ||
    final.info.id !== dispatch.assistantID ||
    final.info.finish !== "stop" ||
    final.info.error ||
    final.info.time.completed !== dispatch.finishedAt ||
    replies.some(
      (row) =>
        (row.info.role === "assistant" && row.info.error) ||
        row.parts.some((part) => part.type === "tool" && ["pending", "running"].includes(part.state.status)),
    )
  )
    return state
  const recorded = state.accounted?.userID === dispatch.messageID ? state.accounted.messages : []
  if (recorded.includes(dispatch.assistantID)) return state
  const fresh = replies.filter((row) => !recorded.includes(row.info.id))
  const total = sum(scope, sessionID)
  const added = sum(fresh, sessionID)
  const prior = state.usage.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  return {
    ...state,
    inputs: [...new Set([...(state.inputs ?? []), dispatch.messageID])],
    accounted: { userID: dispatch.messageID, messages: [...recorded, ...fresh.map((row) => row.info.id)] },
    usage: {
      ...state.usage,
      turns: state.usage.turns + 1,
      toolCalls:
        state.usage.toolCalls +
        fresh.flatMap((row) => row.parts).filter((part) => part.type === "tool" && !controls.has(part.tool)).length,
      cost: Math.max((state.usage.cost ?? 0) + added.cost, total.cost),
      descendantCost: total.descendantCost,
      tokens: {
        input: Math.max(prior.input + added.tokens.input, total.tokens.input),
        output: Math.max(prior.output + added.tokens.output, total.tokens.output),
        reasoning: Math.max(prior.reasoning + added.tokens.reasoning, total.tokens.reasoning),
        cache: {
          read: Math.max(prior.cache.read + added.tokens.cache.read, total.tokens.cache.read),
          write: Math.max(prior.cache.write + added.tokens.cache.write, total.tokens.cache.write),
        },
      },
      descendantTokens: total.descendantTokens,
    },
  }
}

/** Accept only the exact deterministic winning close, including its original-turn bookkeeping. */
export function closing(
  prior: RayaGoal.State,
  current: RayaGoal.State,
  sessionID: SessionID,
  messageID: MessageID,
  rows: readonly SessionV1.WithParts[],
  scope: readonly SessionV1.WithParts[],
) {
  const dispatch = current.dispatch
  if (
    !prior.dispatch ||
    dispatch?.phase !== "finished" ||
    !isDeepStrictEqual(dispatch, {
      ...prior.dispatch,
      phase: "finished",
      finishedAt: dispatch.finishedAt,
      assistantID: messageID,
      outcome: "completed",
    })
  )
    return false
  return isDeepStrictEqual(
    { ...current, revision: prior.revision },
    terminal({ ...prior, dispatch }, sessionID, rows, scope),
  )
}
