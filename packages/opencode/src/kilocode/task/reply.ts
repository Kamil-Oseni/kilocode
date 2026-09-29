import { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineDelegationTable } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { record } from "./continuation"
import { RayaTask } from "."

/** An answer must restore the original assignment's authority before its waiting tool continues. */
export function make(input: { database: Database.Interface; storage: Storage.Interface }, waiting = false) {
  return (id: SessionID): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const session = yield* input.database.db.select().from(SessionTable).where(eq(SessionTable.id, id)).get()
      const rows = yield* input.database.db
        .select({ id: RayaRoutineDelegationTable.id })
        .from(RayaRoutineDelegationTable)
        .where(eq(RayaRoutineDelegationTable.session_id, id))
        .limit(2)
        .all()
      const raw = session?.metadata?.rayaRoutine
      const marked = typeof raw === "object" && raw !== null && Object.hasOwn(raw, "delegationID")
      if (!marked && rows.length === 0) return true
      if (!session || rows.length !== 1) return false
      const identity = yield* Schema.decodeUnknownEffect(record)(raw).pipe(Effect.orElseSucceed(() => undefined))
      if (!identity?.delegationID || identity.delegationID !== rows[0].id) return false
      const mod = yield* Effect.promise(() => import("@/session/session"))
      const service = yield* Effect.serviceOption(mod.Session.Service)
      if (Option.isNone(service)) return false
      const tasks = RayaTask.make(input)
      yield* tasks.get(identity.agentID)
      const run = (yield* tasks.runsFor(identity.agentID)).find((item) => item.id === identity.runID)
      if (!run || run.sessionID !== id || !RayaTask.pending(run)) return false
      const runner = yield* Effect.promise(() => import("./runner"))
      yield* runner.RayaTaskRunner.make({ ...input, sessions: service.value }).park(id, waiting)
      return true
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Worker reply refused: current assignment authority could not be confirmed.").pipe(
              Effect.as(false),
            ),
      ),
    )
}

/** Keep the existing reply API while reporting an explicit, safe request failure. */
export function approve(gate: (id: SessionID) => Effect.Effect<boolean>, id: SessionID) {
  return gate(id).pipe(
    Effect.flatMap((allowed) =>
      allowed
        ? Effect.void
        : Effect.die(
            new Error(
              "This worker cannot continue. Review its assignment, permissions, or recovery status before answering.",
            ),
          ),
    ),
  )
}

/** Once admitted, pending removal and waiter settlement share one interruption-free decision. */
export function accept<ID, T>(pending: Map<ID, T>, id: ID, entry: T, release: Effect.Effect<boolean>) {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      if (pending.get(id) !== entry) return false
      pending.delete(id)
      return yield* release
    }),
  )
}
