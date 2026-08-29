import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { RayaToolModel } from "../../src/kilocode/chief/tool-model"
import type { Provider } from "../../src/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

function model(providerID: string, id: string, toolcall: boolean, extra?: { release_date?: string; context?: number }) {
  return {
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(providerID),
    capabilities: { toolcall },
    release_date: extra?.release_date ?? "",
    limit: { context: extra?.context ?? 0 },
  }
}

function stub(input: {
  models: Record<string, ReturnType<typeof model>>
  fallback?: { providerID: string; modelID: string }
}): Provider.Interface {
  const providers: Record<string, { id: ProviderV2.ID; models: Record<string, ReturnType<typeof model>> }> = {}
  for (const [key, value] of Object.entries(input.models)) {
    const pid = key.split("/")[0]
    providers[pid] ??= { id: ProviderV2.ID.make(pid), models: {} }
    providers[pid].models[value.id] = value
  }
  const iface = {
    getModel: (pid: string, mid: string) => {
      const found = input.models[`${pid}/${mid}`]
      return found ? Effect.succeed(found) : Effect.fail(new Error("not found"))
    },
    defaultModel: () =>
      input.fallback
        ? Effect.succeed({
            providerID: ProviderV2.ID.make(input.fallback.providerID),
            modelID: ModelV2.ID.make(input.fallback.modelID),
          })
        : Effect.fail(new Error("no default")),
    list: () => Effect.succeed(providers),
  }
  return iface as unknown as Provider.Interface
}

const run = (provider: Provider.Interface, candidate: { providerID: string; modelID: string }) =>
  Effect.runPromise(RayaToolModel.orchestration(provider, candidate))

describe("RayaToolModel.orchestration", () => {
  it("keeps a tool-capable candidate unchanged", async () => {
    const provider = stub({ models: { "kilo/small": model("kilo", "small", true) } })
    expect(await run(provider, { providerID: "kilo", modelID: "small" })).toEqual({
      providerID: "kilo",
      modelID: "small",
    })
  })

  it("substitutes the default model when the candidate cannot call tools", async () => {
    const provider = stub({
      models: {
        "deepseek/chat": model("deepseek", "chat", false),
        "kilo/main": model("kilo", "main", true),
      },
      fallback: { providerID: "kilo", modelID: "main" },
    })
    expect(await run(provider, { providerID: "deepseek", modelID: "chat" })).toEqual({
      providerID: "kilo",
      modelID: "main",
    })
  })

  it("picks the best (newest, then largest-context) tool-capable model, not an arbitrary first match", async () => {
    const provider = stub({
      models: {
        "deepseek/chat": model("deepseek", "chat", false),
        "deepseek/reasoner": model("deepseek", "reasoner", false),
        "openrouter/old": model("openrouter", "old", true, { release_date: "2024-01-01", context: 200000 }),
        "anthropic/new": model("anthropic", "new", true, { release_date: "2026-06-01", context: 100000 }),
      },
      fallback: { providerID: "deepseek", modelID: "reasoner" },
    })
    expect(await run(provider, { providerID: "deepseek", modelID: "chat" })).toEqual({
      providerID: "anthropic",
      modelID: "new",
    })
  })

  it("returns the candidate untouched when no tool-capable model exists anywhere", async () => {
    const provider = stub({ models: { "deepseek/chat": model("deepseek", "chat", false) } })
    expect(await run(provider, { providerID: "deepseek", modelID: "chat" })).toEqual({
      providerID: "deepseek",
      modelID: "chat",
    })
  })
})

const ensure = (provider: Provider.Interface, ref: { providerID: string; modelID: string }) =>
  Effect.runPromise(RayaToolModel.ensure(provider, ref))

describe("RayaToolModel.ensure", () => {
  it("keeps a tool-capable subagent model unchanged", async () => {
    const provider = stub({ models: { "kilo/main": model("kilo", "main", true) } })
    expect(await ensure(provider, { providerID: "kilo", modelID: "main" })).toEqual({
      model: { providerID: "kilo", modelID: "main" },
      changed: false,
    })
  })

  it("upgrades a no-tool subagent model to the best tool-capable one", async () => {
    const provider = stub({
      models: {
        "deepseek/chat": model("deepseek", "chat", false),
        "anthropic/new": model("anthropic", "new", true, { release_date: "2026-06-01" }),
      },
    })
    expect(await ensure(provider, { providerID: "deepseek", modelID: "chat" })).toEqual({
      model: { providerID: "anthropic", modelID: "new" },
      changed: true,
    })
  })

  it("leaves an unknown model unchanged (nothing to upgrade against)", async () => {
    const provider = stub({ models: { "anthropic/new": model("anthropic", "new", true) } })
    expect(await ensure(provider, { providerID: "mystery", modelID: "ghost" })).toEqual({
      model: { providerID: "mystery", modelID: "ghost" },
      changed: false,
    })
  })
})
