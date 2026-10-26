import { Cause, Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import type { SessionRunState } from "@/session/run-state"
import * as Log from "@opencode-ai/core/util/log"
import { RayaGoal } from "."
import { Execution } from "@/kilocode/effect/observation"
import { ResultContract } from "@/kilocode/chief/result-contract"
import { gate } from "@/kilocode/session/input-gate"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { record } from "@/kilocode/task/continuation"

const log = Log.create({ service: "raya-goal-turn" })

/** Capture direction before work begins; "none" means no attributable active goal. */
export const observer = Effect.gen(function* () {
  const storage = yield* Storage.Service
  return (sessionID: SessionID) =>
    storage.read<unknown>(["raya", "goal", sessionID]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RayaGoal.State)),
      Effect.map((goal) => (goal.status === "active" ? (goal.intent ?? "unset") : "none")),
      Effect.catchIf(
        (err) => Storage.NotFoundError.isInstance(err),
        () => Effect.succeed("none"),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.sync(() => {
              log.warn("Could not bind this turn to a goal revision.", { sessionID })
              return "none"
            }),
      ),
    )
})

export const node = Storage.node

/** Restore work direction after compaction without changing saved dispatch lineage or tool authority. */
export const compaction = Effect.gen(function* () {
  const storage = yield* Storage.Service
  return Effect.fn("RayaGoal.compactionReminder")(function* (
    session: Pick<Session.Info, "id" | "metadata">,
    parts: SessionV1.WithParts["parts"],
  ) {
    if (!parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.compaction_continue === true))
      return undefined
    const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    if (!identity) return undefined
    const goal = yield* storage.read<unknown>(["raya", "goal", session.id]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RayaGoal.State)),
      Effect.catchIf(
        (err) => Storage.NotFoundError.isInstance(err),
        () => Effect.succeed(undefined),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.sync(() => {
              log.warn("Could not restore the routine's goal reminder after compaction.", { sessionID: session.id })
              return undefined
            }),
      ),
    )
    if (
      goal?.status !== "active" ||
      goal.completion === "reply" ||
      goal.routine?.sessionID !== session.id ||
      goal.routine.agentID !== identity.agentID ||
      goal.routine.runID !== identity.runID
    )
      return undefined
    return "This routine resumed after conversation compaction with an active saved goal. If this resumed turn has not yet called get_goal, call it before further work. Restore its current objective, criteria and budget, then perform the next concrete unmet action. Repair rejected handoff arguments using their actual errors and saved limits. A status summary alone does not complete the work. Preserve all existing permissions and do not repeat a successful action merely because history was compacted."
  })
})

export const associate = Effect.fn("RayaGoal.associate")(
  function* (
    goals: ReturnType<typeof RayaGoal.make>,
    runs: Pick<SessionRunState.Interface, "inspect">,
    sessionID: SessionID,
    sessions?: Pick<Session.Interface, "get" | "messages">,
  ) {
    const execution = yield* Effect.serviceOption(Execution)
    if (execution._tag === "None") return
    const goal = yield* goals.get(sessionID)
    if (!goal) return
    const worker = yield* runs.inspect(sessionID)
    if (worker.phase !== "running" || !worker.id || worker.id !== execution.value.id) return
    const service = yield* Effect.serviceOption(Session.Service)
    const reader = sessions ?? (service._tag === "Some" ? service.value : undefined)
    const intent = goal.intent
    if (reader && goal.status === "active" && intent) {
      const input = (yield* reader.messages({ sessionID, limit: 129 })).findLast((row) => row.info.role === "user")
        ?.info.id
      if (input && !goal.inputs?.includes(input)) {
        const admitted = yield* gate.withLock(sessionID)(
          Effect.gen(function* () {
            const current = yield* goals.get(sessionID)
            const owner = yield* runs.inspect(sessionID)
            if (
              !current ||
              current.status !== "active" ||
              current.intent !== intent ||
              current.createdAt !== goal.createdAt ||
              owner.phase !== "running" ||
              owner.id !== worker.id
            )
              return undefined
            const original = yield* ResultContract.follow(reader, sessionID, input, {
              version: 1,
              sessionID,
              intent,
              createdAt: current.createdAt,
            })
            if (!original) return undefined
            if (original.input && current.inputs?.includes(original.input))
              yield* goals.follow(sessionID, intent, input, worker.id)
            return true
          }),
        )
        // A committed notice from a different goal cannot become the new goal's initial turn.
        if (admitted) return
      }
    }
    if (goal.dispatch && goal.dispatch.phase !== "started") return
    if (goal.dispatch) return yield* goals.bound(sessionID, goal.dispatch.id, worker.id)
    return yield* goals.initial(sessionID, goal.intent ?? "unset", worker.id)
  },
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.interrupt
      : Effect.sync(() => {
          log.warn("Could not associate the running worker with its goal dispatch.", { err: Cause.squash(cause) })
        }),
  ),
)

export const binding = Effect.gen(function* () {
  const storage = yield* Storage.Service
  return (
    sessions: Pick<Session.Interface, "get" | "messages" | "children">,
    runs: Pick<SessionRunState.Interface, "inspect">,
    sessionID: SessionID,
  ) => associate(RayaGoal.make({ storage, sessions }), runs, sessionID, sessions)
})

export function closing(sessions: Pick<Session.Interface, "messages">, sessionID: SessionID) {
  return sessions.messages({ sessionID }).pipe(
    Effect.map(
      (rows) =>
        rows
          .filter((row) => row.info.role === "assistant")
          .toSorted((a, b) => a.info.id.localeCompare(b.info.id))
          .at(-1)?.info.id,
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.sync(() => {
            log.warn("Could not identify the closing turn message.", { sessionID })
            return undefined
          }),
    ),
  )
}
