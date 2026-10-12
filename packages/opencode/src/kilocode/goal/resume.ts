import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import { record } from "@/kilocode/task/continuation"

/** A control edit must not claim to resume a Routine whose retained run is terminal. */
export const allowed = Effect.fn("GoalResume.allowed")(function* (
  input: { sessions: Pick<Session.Interface, "get">; tasks: Pick<ReturnType<typeof RayaTask.make>, "runsFor"> },
  id: SessionID,
) {
  const session = yield* input.sessions.get(id)
  const raw = session.metadata?.rayaRoutine
  if (raw === undefined) return true
  const identity = yield* Schema.decodeUnknownEffect(record)(raw).pipe(Effect.orElseSucceed(() => undefined))
  if (!identity) return false
  const history = yield* input.tasks.runsFor(identity.agentID)
  const run = history.find((run) => run.id === identity.runID)
  return (
    run !== undefined &&
    run.sessionID === id &&
    run.scheduleVersion === identity.scheduleVersion &&
    isDeepStrictEqual(run.trigger, identity.trigger) &&
    RayaTask.pending(run)
  )
})
