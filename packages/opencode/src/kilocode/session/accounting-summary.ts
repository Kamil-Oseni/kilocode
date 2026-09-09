import { Schema } from "effect"
import { sql } from "drizzle-orm"
import { NonNegativeInt } from "@opencode-ai/core/schema"

export const Summary = Schema.Struct({
  amount: Schema.Finite,
  reported: NonNegativeInt,
  estimated: NonNegativeInt,
  partial: NonNegativeInt,
  unknown: NonNegativeInt,
  legacy: NonNegativeInt,
})

export const projection = sql`json_extract(part.data, '$.accounting.status') AS accounting_status,
  CASE WHEN json_extract(part.data, '$.accounting.currency') = 'USD'
    THEN max(0.0, cast(coalesce(json_extract(part.data, '$.accounting.amount'), 0) AS REAL))
    ELSE 0 END AS accounting_amount`

export const aggregation = sql`coalesce(sum(accounting_amount), 0) AS amount,
  sum(CASE WHEN accounting_status = 'reported' THEN 1 ELSE 0 END) AS reported,
  sum(CASE WHEN accounting_status = 'estimated' THEN 1 ELSE 0 END) AS estimated,
  sum(CASE WHEN accounting_status = 'partial' THEN 1 ELSE 0 END) AS partial,
  sum(CASE WHEN accounting_status = 'unknown' THEN 1 ELSE 0 END) AS unknown,
  sum(CASE WHEN accounting_status IS NULL THEN 1 ELSE 0 END) AS legacy`

export function empty() {
  return { amount: 0, reported: 0, estimated: 0, partial: 0, unknown: 0, legacy: 0 }
}

export function merge(total: ReturnType<typeof empty>, row: typeof Summary.Type) {
  const item = {
    amount: row.amount,
    reported: row.reported,
    estimated: row.estimated,
    partial: row.partial,
    unknown: row.unknown,
    legacy: row.legacy,
  }
  for (const key of Object.keys(item) as Array<keyof typeof item>) total[key] += item[key]
  return item
}
