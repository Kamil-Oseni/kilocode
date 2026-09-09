import { Schema } from "effect"
import { Accounting } from "@opencode-ai/schema/kilocode/accounting"
import { describe, expect, test } from "bun:test"
import { Usage } from "@opencode-ai/llm"
import { Session as SessionNs } from "@/session/session"
import type { Provider } from "@/provider/provider"

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const baseUsage = new Usage({
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  totalTokens: 1_100_000,
})

const model = () =>
  createModel({
    context: 100_000,
    output: 32_000,
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  })

const kilo = { id: "kilo" } as Provider.Info

// Calculated cost for the `model()` + `baseUsage` pair: 1M input * $3 + 100k output * $15 = 3 + 1.5
const fallback = 3 + 1.5

describe("KiloSession.providerCost — Anthropic Messages / OpenAI Responses", () => {
  test("uses preserved AI SDK raw usage cost_details", () => {
    const result = SessionNs.getUsage({
      model: model(),
      provider: kilo,
      usage: new Usage({
        inputTokens: baseUsage.inputTokens,
        outputTokens: baseUsage.outputTokens,
        totalTokens: baseUsage.totalTokens,
        providerMetadata: {
          aiSdk: {
            cost: 0.0439847,
            cost_details: { upstream_inference_cost: 0.879694 },
          },
        },
      }),
    })

    expect(result.cost).toBe(0.879694)
  })

  test("ignores provider `cost` when no upstream_inference_cost is reported", () => {
    const result = SessionNs.getUsage({
      model: model(),
      provider: kilo,
      usage: new Usage({
        inputTokens: baseUsage.inputTokens,
        outputTokens: baseUsage.outputTokens,
        totalTokens: baseUsage.totalTokens,
        providerMetadata: { aiSdk: { cost: 0.5 } },
      }),
    })

    expect(result.cost).toBe(fallback)
  })
})

describe("KiloSession.providerCost — Vercel AI Gateway", () => {
  test("uses metadata.gateway.marketCost", () => {
    const result = SessionNs.getUsage({
      model: model(),
      provider: kilo,
      usage: baseUsage,
      metadata: {
        gateway: {
          // Strings, exactly as emitted by the AI Gateway. `cost` is the gateway fee,
          // which Kilo doesn't pass on to end users — must be ignored.
          cost: "0",
          marketCost: "0.35349075",
        },
      },
    })

    expect(result.cost).toBe(0.35349075)
  })

  test("ignores metadata.gateway.cost when marketCost is missing", () => {
    const result = SessionNs.getUsage({
      model: model(),
      provider: kilo,
      usage: baseUsage,
      metadata: {
        gateway: {
          cost: "0.123",
        },
      },
    })

    expect(result.cost).toBe(fallback)
  })
})

describe("KiloSession.providerCost — fallback", () => {
  test("falls back to calculated cost when no provider cost is reported", () => {
    const result = SessionNs.getUsage({
      model: model(),
      provider: kilo,
      usage: baseUsage,
      // No metadata or provider usage cost — should fall back
    })

    expect(result.cost).toBe(fallback)
  })
})

describe("persistable cost evidence", () => {
  test("preserves rate snapshots and disjoint cache/reasoning buckets", () => {
    const result = SessionNs.getUsage({
      model: model(),
      usage: new Usage({ inputTokens: 15000, outputTokens: 3000, reasoningTokens: 1000, cacheReadInputTokens: 5000 }),
    })
    expect(result.accounting).toMatchObject({
      status: "estimated",
      currency: "USD",
      amount: 0.0765,
      source: "model-rate-snapshot:test/test-model",
      issues: [],
    })
    expect(result.accounting.buckets).toEqual([
      { name: "input", tokens: 10000, rate: 3, source: "legacy-model-rate" },
      { name: "output", tokens: 2000, rate: 15, source: "legacy-model-rate" },
      { name: "reasoning", tokens: 1000, rate: 15, source: "legacy-model-rate" },
      { name: "cache_read", tokens: 5000, rate: 0.3, source: "legacy-model-rate" },
      { name: "cache_write", tokens: 0, rate: 3.75, source: "legacy-model-rate" },
    ])
    const updated = model()
    updated.cost.input = 30
    expect(result.accounting.buckets[0].rate).toBe(3)
  })

  test("retains provider zero and rejects malformed monetary evidence", () => {
    const run = (cost: unknown) =>
      SessionNs.getUsage({ model: model(), usage: baseUsage, metadata: { gateway: { marketCost: cost } } as never })
    expect(run("0").accounting).toMatchObject({ status: "reported", amount: 0, source: "gateway.marketCost" })
    for (const value of [-1, "", "  ", false, null, "NaN", Infinity]) {
      expect(run(value).accounting.status).toBe("estimated")
      expect(run(value).cost).toBe(fallback)
    }
  })

  test("distinguishes incomplete rates, absent usage and contradictory normalization", () => {
    const missing = model()
    missing.cost.cache.read = 0
    expect(
      SessionNs.getUsage({
        model: missing,
        usage: new Usage({ inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 10 }),
      }).accounting,
    ).toMatchObject({ status: "partial", amount: 0.00018, issues: ["cache_read_rate_unverified"] })
    expect(SessionNs.getUsage({ model: model(), usage: new Usage({}) }).accounting).toMatchObject({ status: "unknown" })
    expect(
      SessionNs.getUsage({
        model: model(),
        usage: new Usage({ inputTokens: 10, cacheReadInputTokens: 20, outputTokens: 1 }),
      }).accounting,
    ).toMatchObject({ status: "unknown", issues: ["contradictory_usage"] })
    expect(
      SessionNs.getUsage({ model: model(), usage: new Usage({ inputTokens: 10, outputTokens: 1, reasoningTokens: 2 }) })
        .accounting.amount,
    ).toBeUndefined()
  })

  test("optional accounting fields are omitted from wire encoding", () => {
    const value = Schema.encodeSync(Accounting)({
      version: 1,
      status: "unknown",
      source: "test",
      buckets: [],
      issues: [],
      amount: undefined,
      currency: undefined,
    })
    expect(Object.keys(value)).not.toContain("amount")
    expect(Object.keys(value)).not.toContain("currency")
  })

  test("does not label provider credits as dollars", () => {
    expect(
      SessionNs.getUsage({ model: model(), usage: baseUsage, metadata: { copilot: { totalNanoAiu: 12345 } } })
        .accounting,
    ).toMatchObject({
      status: "unknown",
      unit: "nano_aiu",
      quantity: 12345,
      issues: ["currency_conversion_unverified"],
    })
  })
})
