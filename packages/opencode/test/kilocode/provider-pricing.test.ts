import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Models from "@opencode-ai/core/models-dev"
import { Usage } from "@opencode-ai/llm"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { evidence } from "@/kilocode/provider/pricing"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { testEffect } from "../lib/effect"

const model = (cost?: unknown, experimental?: unknown) => ({
  id: "priced",
  name: "Priced",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  limit: { context: 200000, output: 10000 },
  cost,
  experimental,
})
const catalog = (raw: ReturnType<typeof model>) =>
  Provider.fromModelsDevProvider(
    Schema.decodeUnknownSync(Models.Provider)({
      id: "test",
      name: "Test",
      env: [],
      models: { priced: raw },
    }),
  ).models
const usage = new Usage({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50 })

describe("price evidence before normalization", () => {
  test("distinguishes absent pricing, explicit zero, and a missing cache rate", () => {
    const unknown = catalog(model()).priced
    expect(Session.getUsage({ model: unknown, usage }).accounting.status).toBe("unknown")
    const free = catalog(model({ input: 0, output: 0, cache_read: 0 })).priced
    const result = Session.getUsage({ model: free, usage })
    expect(result.accounting).toMatchObject({ status: "estimated", amount: 0, issues: [] })
    expect(result.accounting.buckets.find((item) => item.name === "cache_read")).toEqual({
      name: "cache_read",
      tokens: 50,
      rate: 0,
      source: "catalog",
    })
    const partial = catalog(model({ input: 0, output: 0 })).priced
    expect(Session.getUsage({ model: partial, usage }).accounting).toMatchObject({
      status: "partial",
      amount: 0,
      issues: ["cache_read_rate_unverified"],
    })
    free.cost.input = 10
    expect(result.accounting.buckets.find((item) => item.name === "input")?.rate).toBe(0)
  })

  test("preserves inherited mode rates while replacing supplied tier evidence atomically", () => {
    const models = catalog(
      model(
        { input: 1, output: 2, cache_read: 0.5, context_over_200k: { input: 10, output: 20, cache_read: 0 } },
        {
          modes: {
            free: { cost: { input: 0, output: 0, context_over_200k: { input: 0, output: 0 } } },
            inherited: { cost: { input: 0, output: 0 } },
          },
        },
      ),
    )
    const mode = models["priced-free"]
    expect(mode.cost.cache.read).toBe(0.5)
    expect(mode.cost.evidence?.cache_read).toEqual({ rate: 0.5, source: "catalog" })
    expect(mode.cost.experimentalOver200K?.evidence?.cache_read).toBeUndefined()
    expect(Session.getUsage({ model: mode, usage }).accounting).toMatchObject({ status: "estimated", amount: 0.000025 })
    const large = new Usage({ inputTokens: 200100, outputTokens: 20, cacheReadInputTokens: 50 })
    expect(Session.getUsage({ model: mode, usage: large }).accounting).toMatchObject({
      status: "partial",
      amount: 0,
      issues: ["cache_read_rate_unverified"],
    })
    expect(Session.getUsage({ model: models["priced-inherited"], usage: large }).accounting).toMatchObject({
      status: "estimated",
      amount: 2.0009,
      issues: [],
    })
  })

  test("preserves configured overrides and drops stale inherited zero evidence", () => {
    const priced = catalog(model({ input: 1, output: 2, cache_read: 0.5 })).priced
    expect(evidence({ input: 0 }, "configuration", priced.cost)).toEqual({
      input: { rate: 0, source: "configuration" },
      output: { rate: 2, source: "catalog" },
      cache_read: { rate: 0.5, source: "catalog" },
    })
    priced.cost.input = 0
    expect(evidence(undefined, "configuration", priced.cost).input).toBeUndefined()
    expect(
      Session.getUsage({ model: priced, usage: new Usage({ inputTokens: 100, outputTokens: 0 }) }).accounting.amount,
    ).toBeUndefined()
  })

  test("uses selected context tier evidence without treating omitted tier cache as free", () => {
    const priced = catalog(
      model({
        input: 1,
        output: 2,
        cache_read: 0,
        tiers: [{ input: 0, output: 0, tier: { type: "context", size: 50 } }],
      }),
    ).priced
    expect(Session.getUsage({ model: priced, usage }).accounting).toMatchObject({
      status: "partial",
      amount: 0,
      issues: ["cache_read_rate_unverified"],
    })
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
it.instance(
  "preserves explicit configured zero through the actual provider service",
  () =>
    Effect.gen(function* () {
      const providers = yield* Provider.use.list()
      const configured = Object.values(providers).find((item) => item.id === "private")?.models.priced
      expect(configured).toBeDefined()
      const result = Session.getUsage({ model: configured!, usage })
      expect(result.accounting).toMatchObject({ status: "estimated", amount: 0, issues: [] })
      expect(result.accounting.buckets.find((item) => item.name === "input")?.source).toBe("configuration")
    }),
  {
    config: {
      enabled_providers: ["private"],
      provider: {
        private: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "test" },
          models: {
            priced: {
              name: "Private",
              limit: { context: 200000, output: 10000 },
              cost: { input: 0, output: 0, cache_read: 0 },
            },
          },
        },
      },
    },
  },
)

it.instance(
  "inherits omitted catalog cache rates through configured zero overrides in the provider service",
  () =>
    Effect.gen(function* () {
      // test/preload.ts pins KILO_MODELS_PATH to the checked-in catalog fixture.
      // Listing configured providers does not make a model inference request.
      const providers = yield* Provider.use.list()
      const configured = Object.values(providers).find((item) => item.id === "anthropic")?.models["claude-opus-4-5"]
      expect(configured).toBeDefined()
      expect(configured!.cost).toMatchObject({
        input: 0,
        output: 0,
        cache: { read: 0.5, write: 6.25 },
        evidence: {
          input: { rate: 0, source: "configuration" },
          output: { rate: 0, source: "configuration" },
          cache_read: { rate: 0.5, source: "catalog" },
          cache_write: { rate: 6.25, source: "catalog" },
        },
      })
      const result = Session.getUsage({
        model: configured!,
        usage: new Usage({ inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheWriteInputTokens: 10 }),
      })
      expect(result.accounting).toMatchObject({ status: "estimated", amount: 0.0000875, issues: [] })
      expect(result.accounting.buckets.filter((bucket) => bucket.tokens > 0)).toEqual([
        { name: "input", tokens: 40, rate: 0, source: "configuration" },
        { name: "output", tokens: 20, rate: 0, source: "configuration" },
        { name: "cache_read", tokens: 50, rate: 0.5, source: "catalog" },
        { name: "cache_write", tokens: 10, rate: 6.25, source: "catalog" },
      ])
    }),
  {
    config: {
      enabled_providers: ["anthropic"],
      provider: {
        anthropic: {
          options: { apiKey: "test" },
          models: { "claude-opus-4-5": { cost: { input: 0, output: 0 } } },
        },
      },
    },
  },
)
