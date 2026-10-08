import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { SessionID } from "@/session/schema"
import { Codec } from "./schema"
import type { RayaGoal } from "."
import type { Session } from "@/session/session"
import * as TaskWorker from "@/kilocode/session/task-worker"
import { Execution } from "@/kilocode/effect/observation"
import { gate } from "@/kilocode/session/input-gate"

export const key = "rayaGoalInput"
const Scope = Schema.Struct({
  version: Schema.Literal(1),
  sessionID: Schema.String,
  intent: Schema.String,
  createdAt: Schema.Number,
})
export type Scope = typeof Scope.Type

/** Host-authored Task metadata fences retained inputs to one parent goal intent. */
export const stamp = (storage: Pick<Storage.Interface, "read"> | undefined, sessionID: SessionID) =>
  Effect.gen(function* () {
    if (!storage) return {}
    const value = yield* storage.read<unknown>(["raya", "goal", sessionID]).pipe(
      Effect.catchIf(
        (err) => Storage.NotFoundError.isInstance(err),
        () => Effect.succeed(undefined),
      ),
    )
    if (!Schema.is(Codec.State)(value) || value.status !== "active" || !value.intent) return {}
    return { [key]: { version: 1 as const, sessionID, intent: value.intent, createdAt: value.createdAt } }
  })

/** Only a live retained Task with the original parent's unchanged goal may extend evidence intake. */
export const repair = (
  goals: ReturnType<typeof RayaGoal.make>,
  sessions: Pick<Session.Interface, "get" | "messages">,
  sessionID: SessionID,
) =>
  Effect.gen(function* () {
    const workers = yield* Effect.serviceOption(TaskWorker.Service)
    const execution = yield* Effect.serviceOption(Execution)
    if (workers._tag === "None" || execution._tag === "None") return
    const current = yield* workers.value.current
    if (current?.sessionID !== sessionID) return
    const goal = yield* goals.get(sessionID)
    if (
      !goal ||
      goal.status !== "active" ||
      !goal.intent ||
      !goal.inputs?.length ||
      goal.inputs.includes(current.messageID)
    )
      return
    if (goal.selfHealID || goal.completion === "reply") return
    const first = goal.inputs[0]
    const intent = goal.intent
    const child = yield* sessions.get(sessionID)
    if (!child.parentID) return
    const owner = child.parentID
    yield* gate.withLock(owner)(
      Effect.gen(function* () {
        const bound = yield* workers.value.current
        if (bound?.sessionID !== sessionID || bound.messageID !== current.messageID) return
        const parent = yield* goals.get(owner)
        if (!parent || parent.status !== "active" || !parent.intent) return
        const rows = yield* sessions.messages({ sessionID: owner })
        const parts = rows.flatMap((row) => (row.info.role === "assistant" ? row.parts : []))
        const choose = (input: string) =>
          parts.filter(
            (part) =>
              part.type === "tool" &&
              part.tool === "task" &&
              ["running", "completed", "error"].includes(part.state.status) &&
              part.state.status !== "pending" &&
              part.state.metadata?.parentSessionId === owner &&
              part.state.metadata?.sessionId === sessionID &&
              part.state.metadata?.childMessageID === input,
          )
        const original = choose(first)
        const incoming = choose(current.messageID)
        if (original.length !== 1 || incoming.length !== 1) return
        for (const part of [...original, ...incoming]) {
          if (part.type !== "tool" || part.state.status === "pending") return
          if (
            parts.filter(
              (item) => item.type === "tool" && item.messageID === part.messageID && item.callID === part.callID,
            ).length !== 1
          )
            return
          const scope = part.state.metadata?.[key]
          if (
            !Schema.is(Scope)(scope) ||
            scope.sessionID !== owner ||
            scope.intent !== parent.intent ||
            scope.createdAt !== parent.createdAt
          )
            return
        }
        const admitted = incoming[0]
        if (admitted.type !== "tool" || admitted.state.status !== "running") return
        const source = original[0]
        if (source.type !== "tool" || source.state.status === "pending" || source.state.time.start > goal.createdAt)
          return
        if (admitted.state.time.start < goal.createdAt) return
        yield* goals.follow(sessionID, intent, current.messageID, execution.value.id)
      }),
    )
  })
