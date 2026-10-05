import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { preferences, sanitize } from "../../src/kilocode/migration/profile-preferences"

test("persisted canonical model variants remain independent inactive intent with legacy codec compatibility", () => {
  const output = sanitize(
    {},
    {
      modelState: { variant: { "local/org/qwen3:8b": "high", "openai/gpt-4.1": "default" } },
      extensionState: { variantSelections: { "local/org/qwen3:8b": "low" }, modelSelectorExpanded: false },
    },
  )
  expect(output.modelState.variants).toEqual([
    { providerID: "local", modelID: "org/qwen3:8b", variant: "high" },
    { providerID: "openai", modelID: "gpt-4.1", variant: "default" },
  ])
  expect(output.extensionState.variants).toEqual([{ providerID: "local", modelID: "org/qwen3:8b", variant: "low" }])
  expect(output.extensionState.expanded).toBe(false)
  expect(output.activation).toBe("held")
  expect(preferences.parse(JSON.parse(JSON.stringify(output)))).toEqual(output)
  expect(preferences.parse(sanitize({}, {})).modelState.variants).toBeUndefined()
  for (const key of ["local/../auth", "local/https://private", "local/{env:KEY}"]) {
    expect(() => sanitize({}, { modelState: { variant: { [key]: "high" } } })).toThrow()
  }
  expect(() => sanitize({}, { modelState: { variant: { "local/qwen": "{file:auth.json}" } } })).toThrow()
  const flag = { invoked: false }
  const values = Object.defineProperty({}, "local/qwen", {
    get() {
      flag.invoked = true
      return "high"
    },
  })
  expect(() => sanitize({}, { modelState: { variant: values } })).toThrow("accessors")
  expect(flag.invoked).toBe(false)
  expect(() => sanitize({}, { extensionState: { modelSelectorExpanded: "false" } })).toThrow()
  expect(() =>
    preferences.parse({
      ...output,
      modelState: { ...output.modelState, variants: [...output.modelState.variants!, output.modelState.variants![0]!] },
    }),
  ).toThrow("Duplicate")
  expect(() =>
    sanitize(
      {},
      {
        modelState: {
          variant: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`local/model-${index}`, "high"])),
        },
      },
    ),
  ).toThrow()
})

test("actual config parser preserves safe model defaults while excluding provider and execution authority", () => {
  const source = JSON.parse(`{
    "model":"qwen-local/qwen3-raya-32k:latest","small_model":"openai/gpt-4.1-mini","default_agent":"auto",
    "provider":{"qwen-local":{"npm":"@ai-sdk/openai-compatible","options":{"apiKey":"SYNTHETIC_KEY","baseURL":"http://127.0.0.1:11434/v1","headers":{"authorization":"SYNTHETIC_TOKEN"}}}},
    "permission":"allow","mcp":{"local":{"type":"local","command":["SYNTHETIC_COMMAND"]}},"plugin":["SYNTHETIC_PLUGIN"]
  }`)
  const parsed = Schema.decodeUnknownSync(ConfigV1.Info)(source)
  const output = sanitize(parsed, {})
  expect(output.config).toEqual({
    model: { providerID: "qwen-local", modelID: "qwen3-raya-32k:latest" },
    smallModel: { providerID: "openai", modelID: "gpt-4.1-mini" },
    defaultAgent: "auto",
  })
  expect(output.reviewOnly).toBe(true)
  expect(output.activation).toBe("held")
  expect(JSON.stringify(output)).not.toContain("SYNTHETIC")
  expect(output).not.toHaveProperty("provider")
  expect(output).not.toHaveProperty("permission")
  expect(preferences.parse(JSON.parse(JSON.stringify(output)))).toEqual(output)
})

test("actual persisted model.json and VSCode state shapes retain independent per-agent and recent/favorite picks", () => {
  const first = { providerID: "qwen-local", modelID: "org/qwen3:8b", apiKey: "SYNTHETIC_KEY" }
  const second = { providerID: "kilocode", modelID: "auto" }
  const input = JSON.parse(
    JSON.stringify({
      modelState: {
        model: { generalist: first, auto: second },
        recent: [first, second],
        favorite: [second],
        override: { generalist: second },
        variant: { secret: "SYNTHETIC_TOKEN" },
      },
      extensionState: {
        recentModels: [first],
        favoriteModels: [second],
        variantSelections: { arbitrary: "SYNTHETIC_TOKEN" },
        apiKey: "SYNTHETIC_KEY",
      },
    }),
  )
  const output = sanitize({}, input)
  expect(output.modelState.models.map((item) => item.agent)).toEqual(["auto", "generalist"])
  expect(output.modelState.recent[0]).toEqual({ providerID: "qwen-local", modelID: "org/qwen3:8b" })
  expect(output.extensionState.favoriteModels).toEqual([second])
  expect(JSON.stringify(output)).not.toContain("SYNTHETIC")
  expect(output.modelState).not.toHaveProperty("override")
  input.modelState.model.generalist.modelID = "changed"
  expect(output.modelState.models[1].modelID).toBe("org/qwen3:8b")
})

test("unsafe substitutions, URLs and invalid selected data refuse without resolving or returning raw secrets", () => {
  for (const model of [
    "qwen/{env:PRIVATE_KEY}",
    "qwen/{file:auth.json}",
    "qwen/https://private/token",
    "qwen/../auth",
    "qwen/model\nsecret",
    "qwen/",
  ]) {
    const parsed = Schema.decodeUnknownSync(ConfigV1.Info)({ model })
    expect(() => sanitize(parsed, {})).toThrow()
  }
  expect(() => sanitize({ default_agent: "{env:PRIVATE_AGENT}" }, {})).toThrow()
  expect(() =>
    sanitize({}, { modelState: { model: { auto: { providerID: "qwen", modelID: "{file:private}" } } } }),
  ).toThrow()
  expect(() =>
    sanitize(
      {},
      {
        extensionState: {
          favoriteModels: Array.from({ length: 1001 }, () => ({ providerID: "qwen", modelID: "model" })),
        },
      },
    ),
  ).toThrow()
})

test("whitelisted getters refuse without execution and irrelevant authority getters are never consulted", () => {
  const state = { called: false }
  const cfg = Object.defineProperty({ model: "qwen/model" }, "provider", {
    get() {
      state.called = true
      throw new Error("secret")
    },
  })
  expect(sanitize(cfg, {}).config.model?.modelID).toBe("model")
  expect(state.called).toBe(false)
  const unsafe = Object.defineProperty({}, "model", {
    get() {
      state.called = true
      return "qwen/model"
    },
  })
  expect(() => sanitize(unsafe, {})).toThrow("accessors")
  expect(state.called).toBe(false)
  const recent = Object.defineProperty([{}], "0", {
    get() {
      state.called = true
      return { providerID: "qwen", modelID: "model" }
    },
  })
  expect(() => sanitize({}, { modelState: { recent } })).toThrow("accessors")
  expect(state.called).toBe(false)
  expect(() => preferences.parse({ ...sanitize({}, {}), activation: "active" })).toThrow()
  expect(() => preferences.parse({ ...sanitize({}, {}), permission: "allow" })).toThrow()
})
