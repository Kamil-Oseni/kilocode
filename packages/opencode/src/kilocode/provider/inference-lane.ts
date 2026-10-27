import { Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@/session/schema"

export type Lane = "interactive" | "background"
export const header = "x-raya-inference-lane"
export const originHeader = "x-raya-inference-origin"
export type Origin = { sessionID: string; messageID: string }

/** Bounded attribution only; it never identifies execution authority. */
export function origin(value: unknown): Origin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 2) return undefined
  if (
    typeof row.sessionID !== "string" ||
    typeof row.messageID !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(row.sessionID) ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(row.messageID)
  )
    return undefined
  return { sessionID: row.sessionID, messageID: row.messageID }
}

export function decode(value: unknown): Origin | undefined {
  if (typeof value !== "string" || value.length > 1024) return undefined
  try {
    return origin(JSON.parse(value))
  } catch {
    return undefined
  }
}

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
export function headers<A extends Record<string, string>>(
  input: A,
  selected: Lane,
  local: boolean,
  attribution?: Origin,
) {
  if (!local) return input
  const parsed = origin(attribution)
  const clean = { ...input }
  for (const name of Object.keys(clean)) {
    if (name.toLowerCase() === originHeader) Reflect.deleteProperty(clean, name)
  }
  return { ...clean, [header]: selected, ...(parsed ? { [originHeader]: JSON.stringify(parsed) } : {}) }
}
