import * as Accounting from "./accounting-summary"
// raya_change - project-wide historical model token and cost analytics
import { Database } from "@opencode-ai/core/database/database"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RayaGoal } from "@/kilocode/goal"
import { Storage } from "@/storage/storage"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"

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
    accounting: Schema.optional(Accounting.Summary),
    tokens: Tokens,
  })

  const Model = Schema.Struct({
    providerID: Schema.String,
    modelID: ModelV2.ID,
    ...Usage.fields,
  })

  type Model = typeof Model.Type

  const Charge = Schema.Struct({
    currency: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
    service: Schema.optional(Schema.String),
    source: Schema.String,
    amount: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
    recorded: NonNegativeInt,
    unknown: NonNegativeInt,
  })

  const Charges = Schema.Struct({
    items: Schema.Array(Charge),
    goals: NonNegativeInt,
    unreadable: NonNegativeInt,
    conflicts: NonNegativeInt,
  })

  export const Info = Schema.Struct({
    projectID: Schema.optional(ProjectV2.ID),
    range: Range,
    since: Schema.optional(Schema.Finite),
    until: Schema.Finite,
    timezone: Schema.Literal("UTC"),
    sessions: NonNegativeInt,
    totals: Usage,
    models: Schema.Array(Model),
    charges: Charges,
  })

  type Row = typeof Accounting.Summary.Type & {
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
    accounting: Accounting.empty(),
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  })

  const summarize = Effect.fn("ProjectUsage.charges")(function* (
    projectID: ProjectV2.ID,
    since: number | null,
    until: number,
  ) {
    const { db } = yield* Database.Service
    const storage = yield* Storage.Service
    const rows = yield* db
      .all<{ id: string }>(sql`SELECT id FROM session WHERE project_id = ${projectID}`)
      .pipe(Effect.orDie)
    const sessions = new Set(rows.map((row) => row.id))
    const keys = yield* storage.list(["raya", "goal"]).pipe(Effect.orDie)
    const coverage = { goals: 0, unreadable: 0, conflicts: 0 }
    const receipts = new Map<string, RayaGoal.Charge>()
    const conflicts = new Map<string, Set<number>>()
    for (const key of keys) {
      const sessionID = key[2]
      if (!sessionID || !sessions.has(sessionID)) continue
      coverage.goals++
      const raw = yield* storage.read<unknown>(key).pipe(Effect.option)
      if (Option.isNone(raw)) {
        coverage.unreadable++
        continue
      }
      const state = Schema.decodeUnknownOption(RayaGoal.State)(raw.value, { onExcessProperty: "preserve" })
      if (Option.isNone(state)) {
        coverage.unreadable++
        continue
      }
      const charges = [
        ...(state.value.charges ?? []),
        ...(state.value.history?.flatMap((item) => item.charges ?? []) ?? []),
      ]
      for (const charge of charges) {
        const prior = receipts.get(charge.id)
        if (!prior) {
          receipts.set(charge.id, charge)
          continue
        }
        if (isDeepStrictEqual(prior, charge)) continue
        const times = conflicts.get(charge.id) ?? new Set<number>()
        times.add(prior.at)
        times.add(charge.at)
        conflicts.set(charge.id, times)
      }
    }
    coverage.conflicts = [...conflicts.values()].filter((times) =>
      [...times].some((at) => (since === null || at >= since) && at <= until),
    ).length
    const groups = new Map<
      string,
      {
        currency?: string
        provider?: string
        service?: string
        source: string
        amount: number
        recorded: number
        unknown: number
      }
    >()
    for (const charge of receipts.values()) {
      if (conflicts.has(charge.id) || (since !== null && charge.at < since) || charge.at > until) continue
      const key = JSON.stringify([
        charge.currency ?? null,
        charge.provider ?? null,
        charge.service ?? null,
        charge.source,
      ])
      const item = groups.get(key) ?? {
        ...(charge.currency ? { currency: charge.currency } : {}),
        ...(charge.provider ? { provider: charge.provider } : {}),
        ...(charge.service ? { service: charge.service } : {}),
        source: charge.source ?? "unavailable",
        amount: 0,
        recorded: 0,
        unknown: 0,
      }
      if (charge.coverage === "recorded") {
        item.amount += charge.amount
        item.recorded++
      } else item.unknown++
      groups.set(key, item)
    }
    const items = [...groups.values()]
      .map((item) => {
        if (item.recorded) return item
        return {
          ...(item.currency ? { currency: item.currency } : {}),
          ...(item.provider ? { provider: item.provider } : {}),
          ...(item.service ? { service: item.service } : {}),
          source: item.source,
          recorded: item.recorded,
          unknown: item.unknown,
        }
      })
      .sort((a, b) =>
        JSON.stringify([a.currency, a.provider, a.service, a.source]).localeCompare(
          JSON.stringify([b.currency, b.provider, b.service, b.source]),
        ),
      )
    return { items, ...coverage }
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
        ${Accounting.projection},
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
            AND coalesce(
              cast(json_extract(part.data, '$.time.end') AS INTEGER),
              part.time_created
            ) <= ${until}
        )
        SELECT
          providerID,
          modelID,
          count(*) AS steps,
          coalesce(sum(cost), 0) AS cost,
      ${Accounting.aggregation},
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
        accounting: Accounting.merge(totals.accounting, row),
        tokens: {
          input: row.input,
          output: row.output,
          reasoning: row.reasoning,
          cache: { read: row.read, write: row.write },
        },
      }
    })
    const sessions = rows[0]?.sessions ?? 0

    const charges = yield* summarize(projectID, since, until)
    return {
      projectID,
      range,
      since: since ?? undefined,
      until,
      timezone: "UTC" as const,
      sessions,
      totals,
      models,
      charges,
    }
  })
}
