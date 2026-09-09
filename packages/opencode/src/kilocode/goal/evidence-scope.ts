import { Effect } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"

/** Follow persisted task invocations, not every conversation in a descendant session. */
export const collect = (
  sessions: Pick<Session.Interface, "messages" | "children">,
  sessionID: SessionID,
  createdAt: number,
  inputs?: readonly MessageID[],
) =>
  Effect.gen(function* () {
    const result: SessionV1.WithParts[] = []
    const queue: { id: SessionID; inputs?: Set<string> }[] = [
      { id: sessionID, inputs: inputs === undefined ? undefined : new Set(inputs) },
    ]
    const seen = new Set<string>()
    while (queue.length) {
      const item = queue.shift()!
      if (seen.has(item.id)) continue
      seen.add(item.id)
      const saved = yield* sessions.messages({ sessionID: item.id })
      const ids = new Map<string, number>()
      for (const row of saved) ids.set(row.info.id, (ids.get(row.info.id) ?? 0) + 1)
      const unique = saved.filter((row) => row.info.sessionID === item.id && ids.get(row.info.id) === 1)
      const users = new Set(
        unique
          .filter(
            (row) =>
              row.info.role === "user" &&
              (item.id === sessionID || row.info.time.created >= createdAt) &&
              (!item.inputs || item.inputs.has(row.info.id)),
          )
          .map((row) => row.info.id),
      )
      const rows = unique
        .filter((row) => row.info.role === "assistant" && users.has(row.info.parentID))
        .map((row) => ({
          ...row,
          parts: row.parts.filter((part) => part.sessionID === item.id && part.messageID === row.info.id),
        }))
      result.push(...rows)
      const edges = new Map<string, Set<string>>()
      for (const row of rows) {
        const calls = new Map<string, number>()
        const parts = new Map<string, number>()
        for (const part of row.parts) {
          parts.set(part.id, (parts.get(part.id) ?? 0) + 1)
          if (part.type === "tool") calls.set(part.callID, (calls.get(part.callID) ?? 0) + 1)
        }
        for (const part of row.parts) {
          if (
            part.type !== "tool" ||
            part.tool !== "task" ||
            part.state.status === "pending" ||
            part.state.time.start < createdAt
          )
            continue
          if (calls.get(part.callID) !== 1 || parts.get(part.id) !== 1) continue
          const metadata = part.state.metadata
          if (
            !metadata ||
            metadata.parentSessionId !== item.id ||
            typeof metadata.sessionId !== "string" ||
            typeof metadata.childMessageID !== "string"
          )
            continue
          const allowed = edges.get(metadata.sessionId) ?? new Set<string>()
          allowed.add(metadata.childMessageID)
          edges.set(metadata.sessionId, allowed)
        }
      }
      if (!edges.size) continue
      const children = yield* sessions.children(item.id)
      for (const child of children) {
        const allowed = edges.get(child.id)
        if (allowed?.size) queue.push({ id: child.id, inputs: allowed })
      }
    }
    return result
  })
