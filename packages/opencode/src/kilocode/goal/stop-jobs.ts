import { Cause, Effect, Schema } from "effect"
import type { BackgroundJob } from "@/background/job"

export const Observation = Schema.Struct({
  at: Schema.Number,
  status: Schema.Literals(["checked", "unavailable"]),
  jobs: Schema.Array(Schema.Struct({ id: Schema.String, type: Schema.String, title: Schema.optional(Schema.String) })),
})

// Relationship metadata is evidence of related work, not authority to cancel it.
export const outstanding = (session: string, background: Pick<BackgroundJob.Interface, "list">) =>
  Effect.gen(function* () {
    const rows = yield* background.list()
    const sessions = new Set([session])
    const related = new Set<string>()
    for (;;) {
      const size = related.size
      for (const row of rows) {
        if (related.has(row.id)) continue
        const parent = row.metadata?.parentSessionId
        const child = row.metadata?.sessionId
        if (
          !sessions.has(row.id) &&
          !(typeof parent === "string" && sessions.has(parent)) &&
          !(typeof child === "string" && sessions.has(child))
        )
          continue
        related.add(row.id)
        if (typeof child === "string") sessions.add(child)
        sessions.add(row.id)
      }
      if (related.size === size) break
    }
    return {
      at: Date.now(),
      status: "checked" as const,
      jobs: rows
        .filter((row) => related.has(row.id) && row.status === "running")
        .map((row) => ({ id: row.id, type: row.type, ...(row.title ? { title: row.title } : {}) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.succeed({ at: Date.now(), status: "unavailable" as const, jobs: [] }),
    ),
  )
