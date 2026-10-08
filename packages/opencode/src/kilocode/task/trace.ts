import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RayaGoal } from "@/kilocode/goal"
import { Codec } from "./schema"
import { Schema } from "effect"

/** Enumerate identity only from the exact saved goal's bound inputs and persisted message parts. */
export function trace(run: Codec.Run, goal: RayaGoal.State | undefined, rows: readonly SessionV1.WithParts[]) {
  if (run.goalCreatedAt === undefined || run.goalCreatedAt !== goal?.createdAt || !goal.inputs?.length) return undefined
  const ids = new Set(goal.inputs)
  if (ids.size !== goal.inputs.length || ids.size > 128) return undefined
  const users = rows.filter((row) => row.info.role === "user" && ids.has(row.info.id))
  if (users.length !== ids.size || new Set(users.map((row) => row.info.id)).size !== ids.size) return undefined
  if (users.some((row) => row.info.sessionID !== run.sessionID || row.info.time.created < goal.createdAt))
    return undefined
  const selected = rows.filter((row) => row.info.role === "assistant" && ids.has(row.info.parentID))
  if (selected.length > 128 || new Set(selected.map((row) => row.info.id)).size !== selected.length) return undefined
  const parts = new Set<string>()
  const turns: Codec.Trace["turns"][number][] = []
  for (const user of users.toSorted((a, b) => a.info.id.localeCompare(b.info.id))) {
    const messages: Codec.Trace["turns"][number]["messages"][number][] = []
    for (const row of selected.toSorted((a, b) => a.info.id.localeCompare(b.info.id))) {
      if (row.info.role !== "assistant" || row.info.parentID !== user.info.id) continue
      if (row.info.sessionID !== run.sessionID || row.info.time.created < user.info.time.created) return undefined
      const actions: Codec.Trace["turns"][number]["messages"][number]["actions"][number][] = []
      for (const part of row.parts) {
        if (part.sessionID !== run.sessionID || part.messageID !== row.info.id || parts.has(part.id)) return undefined
        parts.add(part.id)
        if (part.type !== "tool") continue
        actions.push({ actionID: part.id, status: part.state.status })
      }
      if (parts.size > 256) return undefined
      messages.push({
        messageID: row.info.id,
        actions: actions.toSorted((a, b) => a.actionID.localeCompare(b.actionID)),
      })
    }
    turns.push({ turnID: user.info.id, messages })
  }
  const value: Codec.Trace = { version: 1, goalCreatedAt: goal.createdAt, turns }
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 || !Schema.is(Codec.Trace)(value)) return undefined
  return value
}
