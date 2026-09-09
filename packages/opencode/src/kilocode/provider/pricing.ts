import { Schema } from "effect"
import { optional } from "@opencode-ai/core/schema"

const Entry = Schema.Struct({
  rate: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  source: Schema.Literals(["catalog", "configuration"]),
})
export const fields = { evidence: optional(Schema.Record(Schema.String, Entry)) }

type Raw = { input?: number; output?: number; cache_read?: number; cache_write?: number }
type Cost = {
  input: number
  output: number
  cache: { read: number; write: number }
  evidence?: Record<string, typeof Entry.Type>
}
const names = ["input", "output", "cache_read", "cache_write"] as const
const value = (cost: Cost | undefined, name: (typeof names)[number]) =>
  name === "cache_read" ? cost?.cache.read : name === "cache_write" ? cost?.cache.write : cost?.[name]

export function evidence(raw: Raw | undefined, source: (typeof Entry.Type)["source"], base?: Cost) {
  const result: Record<string, typeof Entry.Type> = {}
  for (const name of names) {
    const rate = raw?.[name]
    if (rate !== undefined && rate !== null) {
      if (Number.isFinite(rate) && rate >= 0) result[name] = { rate, source }
      continue
    }
    const prior = base?.evidence?.[name]
    if (prior && prior.rate === value(base, name)) result[name] = prior
  }
  return result
}

export function mode(base: Cost, raw: Raw): Cost {
  return {
    input: raw.input ?? base.input,
    output: raw.output ?? base.output,
    cache: { read: raw.cache_read ?? base.cache.read, write: raw.cache_write ?? base.cache.write },
    evidence: evidence(raw, "catalog", base),
  }
}
