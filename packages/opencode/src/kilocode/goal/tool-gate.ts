import type { JSONSchema7 } from "@ai-sdk/provider"
import type { Tool as AITool } from "ai"
import { Effect } from "effect"
import type { RayaGoal } from "."
import type { MessageID, SessionID } from "@/session/schema"

type Read = (id: SessionID) => Effect.Effect<RayaGoal.State | undefined>
type Check = () => Effect.Effect<boolean>
const owners = new WeakMap<JSONSchema7, Read>()
const checks = new WeakMap<Record<string, AITool>, Check>()

export function owned(schema: JSONSchema7, read: Read) {
  owners.set(schema, read)
  return schema
}

export const prepare = Effect.fn("GoalToolGate.prepare")(function* (
  schema: JSONSchema7 | undefined,
  session: SessionID,
  message: MessageID,
  current: () => Effect.Effect<MessageID | undefined>,
) {
  const read = schema && owners.get(schema)
  const goal = read ? yield* read(session) : undefined
  const dispatch = goal?.dispatch
  if (!read || !goal || !dispatch || dispatch.messageID !== message || dispatch.intent !== goal.intent)
    return () => Effect.succeed(false)
  return () =>
    Effect.gen(function* () {
      if ((yield* current()) !== message) return false
      const saved = yield* read(session)
      if ((yield* current()) !== message) return false
      return (
        saved?.createdAt === goal.createdAt &&
        saved.intent === goal.intent &&
        saved.dispatch?.id === dispatch.id &&
        saved.dispatch.messageID === message &&
        saved.dispatch.intent === dispatch.intent &&
        saved.status === "complete" &&
        saved.auditAttempt?.accepted === true &&
        saved.audit?.verifiedAt !== undefined
      )
    })
})

export function bind(
  tools: Record<string, AITool>,
  check: Check,
  run: (body: Effect.Effect<boolean>) => Promise<boolean>,
) {
  const result = Object.fromEntries(
    Object.entries(tools).map(([id, item]) => {
      const execute = item.execute
      if (execute)
        item.execute = async (...args: Parameters<typeof execute>) => {
          if (await run(check()))
            throw new Error("This goal dispatch is complete; provide its final response without further tools")
          return execute(...args)
        }
      // SessionTools creates fresh callbacks per dispatch; retain the lazy catalog's exact tool identity.
      return [id, item]
    }),
  )
  checks.set(result, check)
  return result
}

export function closed(tools: Record<string, AITool>) {
  return checks.get(tools)?.() ?? Effect.succeed(false)
}
