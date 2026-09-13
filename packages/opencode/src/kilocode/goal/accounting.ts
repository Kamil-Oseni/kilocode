import { Effect } from "effect"
import type { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { collect } from "./evidence-scope"

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

/** Usage for the persisted task graph admitted by the goal's exact root inputs. */
export const totals = (
  sessions: Pick<Session.Interface, "messages" | "children">,
  sessionID: SessionID,
  createdAt: number,
  inputs: readonly MessageID[],
  root: readonly SessionV1.WithParts[],
) => collect(sessions, sessionID, createdAt, inputs, root).pipe(Effect.map((rows) => sum(rows, sessionID)))
