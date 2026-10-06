import type { JSONSchema7 } from "@ai-sdk/provider"
import type { Tool as AITool } from "ai"
import { Effect, Option, Schema } from "effect"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import { record } from "@/kilocode/task/continuation"
import type { Session } from "@/session/session"
import { RayaGoal } from "."
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

export const key = "raya.goal.observation"
const proof = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: Schema.String,
  messageID: Schema.String,
  revision: Schema.optional(Schema.String),
  digest: Schema.String,
})
const output = Schema.fromJsonString(Schema.Struct({ goal: RayaGoal.State }))
const identity = (goal: RayaGoal.State) =>
  digest({
    tool: "goal",
    state: {
      createdAt: goal.createdAt,
      intent: goal.intent,
      objective: goal.objective,
      criteria: goal.criteria,
      completion: goal.completion,
      dispatch: goal.dispatch && {
        id: goal.dispatch.id,
        messageID: goal.dispatch.messageID,
        intent: goal.dispatch.intent,
      },
    },
  })

export function observation(goal: RayaGoal.State, sessionID: SessionID, messageID: MessageID) {
  return { version: 1, sessionID, messageID, revision: goal.revision, digest: identity(goal) }
}

/** Restrict timer callbacks only; existing continuation ownership remains the authority to run a timer turn. */
export const first = Effect.fn("GoalToolGate.first")(function* (
  schema: JSONSchema7 | undefined,
  session: Session.Info,
  message: MessageID,
  sessions: Pick<Session.Interface, "get" | "messages">,
) {
  const timer = Option.getOrUndefined(Schema.decodeUnknownOption(record)(session.metadata?.rayaRoutine))
  if (timer?.trigger.kind !== "timer") return (_id?: string) => Effect.succeed(true)
  const read = schema && owners.get(schema)
  return (id?: string) =>
    Effect.gen(function* () {
      if (id === "get_goal") return true
      if (!read) return false
      const current = yield* sessions.get(session.id).pipe(Effect.orDie)
      if (
        digest({ tool: "routine", state: current.metadata?.rayaRoutine }) !==
        digest({ tool: "routine", state: session.metadata?.rayaRoutine })
      )
        return false
      const goal = yield* read(session.id)
      if (!goal) return false
      if (goal.completion === "reply") return true
      const rows = yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
      if (rows.findLast((row) => row.info.role === "user")?.info.id !== message) return false
      const accepted = rows.some(
        (row) =>
          row.info.role === "assistant" &&
          row.info.parentID === message &&
          row.parts.some((part) => {
            if (
              part.type !== "tool" ||
              part.sessionID !== session.id ||
              part.messageID !== row.info.id ||
              part.tool !== "get_goal" ||
              part.state.status !== "completed"
            )
              return false
            const saved = Option.getOrUndefined(Schema.decodeUnknownOption(proof)(part.state.metadata[key]))
            const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(output)(part.state.output))
            return (
              saved !== undefined &&
              parsed !== undefined &&
              saved.sessionID === session.id &&
              saved.messageID === row.info.id &&
              saved.revision === parsed.goal.revision &&
              saved.digest === identity(parsed.goal) &&
              saved.digest === identity(goal) &&
              part.state.time.start >= goal.createdAt &&
              part.state.time.end >= part.state.time.start
            )
          }),
      )
      if (!accepted) return false
      const latest = yield* read(session.id)
      const after = yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
      const retained = yield* sessions.get(session.id).pipe(Effect.orDie)
      return (
        digest({ tool: "routine", state: retained.metadata?.rayaRoutine }) ===
          digest({ tool: "routine", state: session.metadata?.rayaRoutine }) &&
        latest !== undefined &&
        identity(latest) === identity(goal) &&
        after.findLast((row) => row.info.role === "user")?.info.id === message
      )
    })
})

/** Per-step advertisement; a new resolve observes the original durable get_goal result. */
export const select = Effect.fn("GoalToolGate.select")(function* (tools: Record<string, AITool>, ready: Check) {
  if (yield* ready()) return tools
  return tools.get_goal ? { get_goal: tools.get_goal } : {}
})

export function bind(
  tools: Record<string, AITool>,
  check: Check,
  run: (body: Effect.Effect<boolean>) => Promise<boolean>,
  admit: (id: string) => Effect.Effect<boolean> = () => Effect.succeed(true),
) {
  const result = Object.fromEntries(
    Object.entries(tools).map(([id, item]) => {
      const execute = item.execute
      if (execute)
        item.execute = async (...args: Parameters<typeof execute>) => {
          if (await run(check()))
            throw new Error("This goal dispatch is complete; provide its final response without further tools")
          if (!(await run(admit(id))))
            return {
              title: "Read goal first",
              output:
                "Complete get_goal in this timer session before performing other work. Its saved result establishes the current goal for this dispatch.",
              metadata: {},
            }
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
