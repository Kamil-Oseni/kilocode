import type { Types } from "effect"
import { Decimal } from "decimal.js"
import type { Accounting } from "@opencode-ai/schema/kilocode/accounting"
import type { Provider } from "@/provider/provider"
import type { Usage } from "@opencode-ai/llm"

type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

export function count(value: unknown) {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value)
        : undefined
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0 ? amount : undefined
}

export function validate(input: { usage: Usage; tokens: Tokens; write: unknown }) {
  const raw = [
    input.usage.inputTokens,
    input.usage.outputTokens,
    input.usage.reasoningTokens,
    input.usage.cacheReadInputTokens,
    input.usage.cacheWriteInputTokens,
    input.usage.nonCachedInputTokens,
    input.usage.totalTokens,
  ]
  const invalid =
    raw.some((value) => value !== undefined && (typeof value !== "number" || count(value) === undefined)) ||
    (input.usage.inputTokens !== undefined &&
      input.tokens.cache.read + input.tokens.cache.write > input.usage.inputTokens) ||
    (input.usage.outputTokens !== undefined && input.tokens.reasoning > input.usage.outputTokens) ||
    (input.usage.inputTokens !== undefined &&
      input.usage.nonCachedInputTokens !== undefined &&
      input.usage.nonCachedInputTokens !== input.tokens.input)
  return [
    ...(count(input.write) === undefined ? ["cache_write_usage_invalid"] : []),
    ...(invalid ? ["contradictory_usage"] : []),
  ]
}

export function reported(amount: number, source: string, issues: string[]): Types.DeepMutable<Accounting> {
  return { version: 1, status: "reported", source, currency: "USD", amount, buckets: [], issues }
}

export function estimate(input: {
  model: Pick<Provider.Model, "id" | "providerID">
  usage: Usage
  tokens: Tokens
  issues: string[]
  rates: Pick<Provider.Model["cost"], "input" | "output" | "cache" | "evidence"> | undefined
  nano: unknown
}): Types.DeepMutable<Accounting> {
  const base = {
    version: 1 as const,
    source: `model-rate-snapshot:${input.model.providerID}/${input.model.id}`,
    buckets: [],
    issues: [],
  }
  // The legacy numeric field has a Copilot conversion. Retain its original unit
  // here until a versioned conversion contract is available to this ledger.
  if (typeof input.nano === "number" && Number.isFinite(input.nano) && input.nano >= 0) {
    return {
      ...base,
      status: "unknown",
      source: "copilot.totalNanoAiu",
      unit: "nano_aiu",
      quantity: input.nano,
      issues: [...input.issues, "currency_conversion_unverified"],
    }
  }
  const buckets = [
    { name: "input", tokens: input.tokens.input, rate: input.rates?.input },
    { name: "output", tokens: input.tokens.output, rate: input.rates?.output },
    { name: "reasoning", tokens: input.tokens.reasoning, rate: input.rates?.output },
    { name: "cache_read", tokens: input.tokens.cache.read, rate: input.rates?.cache?.read },
    { name: "cache_write", tokens: input.tokens.cache.write, rate: input.rates?.cache?.write },
  ].map((item) => {
    const origin = input.rates?.evidence?.[item.name === "reasoning" ? "output" : item.name]
    const known = origin && origin.rate === item.rate
    const priced =
      typeof item.rate === "number" && Number.isFinite(item.rate) && item.rate >= 0 && (item.rate > 0 || known)
    return {
      name: item.name,
      tokens: item.tokens,
      ...(priced ? { rate: item.rate, source: known ? origin.source : "legacy-model-rate" } : {}),
    }
  })
  if (input.issues.length) return { ...base, buckets, status: "unknown", issues: input.issues }
  const issues = [
    ...(input.usage.inputTokens === undefined ? ["input_usage_missing"] : []),
    ...(input.usage.outputTokens === undefined ? ["output_usage_missing"] : []),
    ...buckets
      .filter((item) => item.tokens > 0 && item.rate === undefined)
      .map((item) => `${item.name}_rate_unverified`),
  ]
  const priced = buckets.filter((item) => item.tokens > 0 && item.rate !== undefined)
  const amount = priced
    .reduce((sum, item) => sum.add(new Decimal(item.tokens).mul(item.rate!).div(1_000_000)), new Decimal(0))
    .toNumber()
  if (!Number.isFinite(amount)) return { ...base, buckets, status: "unknown", issues: [...issues, "amount_overflow"] }
  const empty =
    input.usage.inputTokens === 0 &&
    input.usage.outputTokens === 0 &&
    buckets.every((item) => item.tokens === 0) &&
    buckets[0].rate !== undefined &&
    buckets[1].rate !== undefined
  if (!priced.length && !empty)
    return { ...base, buckets, status: "unknown", issues: [...issues, "no_verified_priced_usage"] }
  return { ...base, currency: "USD", amount, buckets, issues, status: issues.length ? "partial" : "estimated" }
}
