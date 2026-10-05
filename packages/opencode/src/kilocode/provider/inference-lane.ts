import { Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"

export type Lane = "interactive" | "background"
export const header = "x-raya-inference-lane"

/** Scheduling classification is a resource hint, never Routine execution authority. */
export function lane(input: { sessionID: string; small?: boolean }, database: Database.Interface) {
  return Effect.gen(function* () {
    if (input.small) return "background" as const
    const seen = new Set<string>()
    let id: string | undefined = input.sessionID
    while (id && seen.size < 128) {
      if (seen.has(id)) return "background" as const
      seen.add(id)
      const row: { parent: string | null; metadata: Record<string, unknown> | null } | undefined = yield* database.db
        .select({ parent: SessionTable.parent_id, metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(id)))
        .get()
      if (!row) return "interactive" as const
      // Unknown Routine metadata also stays in the background; it grants no elevated priority.
      if (row.metadata?.rayaRoutine !== undefined) return "background" as const
      id = row.parent ?? undefined
    }
    return id ? ("background" as const) : ("interactive" as const)
  })
}

/** The internal tag is stripped by localFetch before either provider transport sees it. */
export function headers<A extends Record<string, string>>(input: A, selected: Lane, local: boolean) {
  if (!local) return input
  return { ...input, [header]: selected }
}
