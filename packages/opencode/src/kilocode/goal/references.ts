import { Cause, Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { RayaTask } from "@/kilocode/task"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "raya-goal-retention" })
const claim = Schema.Struct({
  version: Schema.Literal(1),
  agentID: Schema.String,
  id: Schema.String,
  sessionID: Schema.optional(SessionID),
})

/** Undefined means references are uncertain: retain every cleanup candidate. */
export const references = (storage: Pick<Storage.Interface, "list" | "read">) =>
  Effect.gen(function* () {
    const sessions = new Set<string>()
    for (const key of yield* storage.list(["raya", "agent-runs"])) {
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(RayaTask.Run))(yield* storage.read(key))
      for (const run of rows) sessions.add(run.sessionID)
    }
    for (const key of yield* storage.list(["raya", "agent-claims"])) {
      const row = yield* Schema.decodeUnknownEffect(claim)(yield* storage.read(key))
      // An interrupted start may have created a goal before saving its session link.
      if (!row.sessionID) return undefined
      sessions.add(row.sessionID)
    }
    return sessions
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.sync(() => {
            log.warn("Completed goal cleanup deferred because routine references could not be verified.")
            return undefined
          }),
    ),
    Effect.orDie,
  )
