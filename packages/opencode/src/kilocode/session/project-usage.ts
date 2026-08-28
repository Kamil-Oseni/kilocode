// raya_change - project-wide historical model token and cost analytics
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"

export namespace ProjectUsage {
  export const Range = Schema.Literals(["24h", "7d", "30d", "all"])
  export type Range = typeof Range.Type

  const Tokens = Schema.Struct({
    input: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cache: Schema.Struct({
      read: NonNegativeInt,
      write: NonNegativeInt,
    }),
  })

  const Usage = Schema.Struct({
    steps: NonNegativeInt,
    cost: Schema.Finite,
    tokens: Tokens,
  })

  const Model = Schema.Struct({
    providerID: Schema.String,
    modelID: ModelV2.ID,
    ...Usage.fields,
  })

  type Model = typeof Model.Type

  export const Info = Schema.Struct({
    range: Range,
    since: Schema.optional(Schema.Finite),
    until: Schema.Finite,
    timezone: Schema.Literal("UTC"),
    sessions: NonNegativeInt,
    totals: Usage,
    models: Schema.Array(Model),
  })

  type Row = {
    providerID: string
    modelID: ModelV2.ID
    steps: number
    cost: number
    input: number
    output: number
    reasoning: number
    read: number
    write: number
    sessions: number
  }

  const cutoff = (range: Range, now: number) => {
    if (range === "all") return null
    const days = range === "24h" ? 1 : range === "7d" ? 7 : 30
    return now - days * 24 * 60 * 60 * 1_000
  }

  const empty = () => ({
    steps: 0,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })

  export const get = Effect.fn("ProjectUsage.get")(function* (
    projectID: ProjectV2.ID,
    range: Range,
    until = Date.now(),
  ) {
    const { db } = yield* Database.Service
    const since = cutoff(range, until)
    const rows = yield* db
      .all<Row>(
        sql`
        WITH step AS (
          SELECT
            part.session_id AS sessionID,
            coalesce(json_extract(part.data, '$.model.providerID'), json_extract(message.data, '$.providerID')) AS providerID,
            coalesce(json_extract(part.data, '$.model.modelID'), json_extract(message.data, '$.modelID')) AS modelID,
            max(0.0, cast(coalesce(json_extract(part.data, '$.cost'), 0) AS REAL)) AS cost,
            max(0, cast(coalesce(json_extract(part.data, '$.tokens.input'), 0) AS INTEGER)) AS input,
            max(0, cast(coalesce(json_extract(part.data, '$.tokens.output'), 0) AS INTEGER)) AS output,
            max(0, cast(coalesce(json_extract(part.data, '$.tokens.reasoning'), 0) AS INTEGER)) AS reasoning,
            max(0, cast(coalesce(json_extract(part.data, '$.tokens.cache.read'), 0) AS INTEGER)) AS cache_read,
            max(0, cast(coalesce(json_extract(part.data, '$.tokens.cache.write'), 0) AS INTEGER)) AS cache_write
          FROM part
          JOIN message ON message.id = part.message_id AND message.session_id = part.session_id
          JOIN session ON session.id = part.session_id
          WHERE session.project_id = ${projectID}
            AND json_extract(part.data, '$.type') = 'step-finish'
            AND json_extract(message.data, '$.role') = 'assistant'
            AND (${since} IS NULL OR coalesce(
              cast(json_extract(part.data, '$.time.end') AS INTEGER),
              part.time_created
            ) >= ${since})
        )
        SELECT
          providerID,
          modelID,
          count(*) AS steps,
          coalesce(sum(cost), 0) AS cost,
          coalesce(sum(input), 0) AS input,
          coalesce(sum(output), 0) AS output,
          coalesce(sum(reasoning), 0) AS reasoning,
          coalesce(sum(cache_read), 0) AS read,
          coalesce(sum(cache_write), 0) AS write,
          (SELECT count(DISTINCT sessionID) FROM step) AS sessions
        FROM step
        WHERE providerID IS NOT NULL AND modelID IS NOT NULL
        GROUP BY providerID, modelID
        ORDER BY cost DESC, providerID, modelID`,
      )
      .pipe(Effect.orDie)
    const totals = empty()
    const models = rows.map((row): Model => {
      totals.steps += row.steps
      totals.cost += row.cost
      totals.tokens.input += row.input
      totals.tokens.output += row.output
      totals.tokens.reasoning += row.reasoning
      totals.tokens.cache.read += row.read
      totals.tokens.cache.write += row.write
      return {
        providerID: row.providerID,
        modelID: row.modelID,
        steps: row.steps,
        cost: row.cost,
        tokens: {
          input: row.input,
          output: row.output,
          reasoning: row.reasoning,
          cache: { read: row.read, write: row.write },
        },
      }
    })
    const sessions = rows[0]?.sessions ?? 0

    return { range, since: since ?? undefined, until, timezone: "UTC" as const, sessions, totals, models }
  })
}
