import { eq } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineDelegationTable as Delegation } from "@opencode-ai/core/kilocode/routine.sql"
import type { SessionID } from "@/session/schema"
import { Effect } from "effect"

const live = new Set(["queued", "accepted", "running", "needs_input"])

/**
 * Return the model cost currently committed to organization workers below a
 * delegated goal. Live branches reserve their full saved ceiling; terminal
 * branches use recorded spend and recursively include their finished children.
 */
export function sum(database: Database.Interface | undefined, sessionID: SessionID, runID?: string) {
  if (!database) return Effect.succeed(undefined)
  const db = database.db
  return Effect.gen(function* () {
    const owner = yield* db
      .select({ id: Delegation.id })
      .from(Delegation)
      .where(eq(Delegation.session_id, sessionID))
      .get()
    const rows = (id: string) => db.select().from(Delegation).where(eq(Delegation.parent_id, id)).all()
    const committed = (items: readonly (typeof Delegation.$inferSelect)[]): Effect.Effect<number, unknown> =>
      Effect.gen(function* () {
        let total = 0
        for (const row of items) {
          if (live.has(row.state)) {
            total += row.budget ?? 0
            continue
          }
          if (row.cost === null) {
            // A terminal request that reached a session but has no receipt is
            // uncertain. Retain its ceiling instead of inventing a zero cost.
            total += row.session_id ? (row.budget ?? 0) : 0
            continue
          }
          total += row.cost + (yield* committed(yield* rows(row.id)))
        }
        return total
      })
    if (owner) return yield* committed(yield* rows(owner.id))
    if (!runID) return undefined
    return yield* committed(yield* db.select().from(Delegation).where(eq(Delegation.parent_run_id, runID)).all())
  })
}
