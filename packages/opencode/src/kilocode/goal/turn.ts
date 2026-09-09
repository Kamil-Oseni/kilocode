import { Cause, Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionRunState } from "@/session/run-state"
import * as Log from "@opencode-ai/core/util/log"
import { RayaGoal } from "."
import { Execution } from "@/kilocode/effect/observation"

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

export const associate = Effect.fn("RayaGoal.associate")(
  function* (
    goals: ReturnType<typeof RayaGoal.make>,
    runs: Pick<SessionRunState.Interface, "inspect">,
    sessionID: SessionID,
  ) {
    const execution = yield* Effect.serviceOption(Execution)
    if (execution._tag === "None") return
    const goal = yield* goals.get(sessionID)
    if (!goal || (goal.dispatch && goal.dispatch.phase !== "started")) return
    const worker = yield* runs.inspect(sessionID)
    if (worker.phase !== "running" || !worker.id || worker.id !== execution.value.id) return
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
  ) => associate(RayaGoal.make({ storage, sessions }), runs, sessionID)
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
