import { describe, expect, it } from "bun:test"
import {
  MASKED_CUSTOM_PROVIDER_KEY,
  parseCustomProviderSecret,
  resolveCustomProviderKey,
  resolveCustomProviderAuth,
  sanitizeCustomProviderConfig,
  validateProviderID,
  withCustomProviderDeletions,
  customProviderModelSettings,
  parseCustomProviderLimits,
} from "../../src/shared/custom-provider"
import { isCustomProviderPackage } from "../../src/shared/provider-model"

describe("custom provider model budgets", () => {
  const provider = (model: Record<string, unknown>) => ({
    name: "Local server",
    options: { baseURL: "http://127.0.0.1:1234/v1" },
    models: { "exact-local-id": { name: "Local model", ...model } },
  })

  it("preserves exact limits and explicitly disabled tools through host normalization", () => {
    const limit = { context: 32768, input: 24576, output: 8192 }
    const result = sanitizeCustomProviderConfig(provider({ limit, tool_call: false }))
    expect("value" in result && result.value.models["exact-local-id"]).toEqual({
      name: "Local model",
      limit,
      tool_call: false,
    })
  })

  it("preserves zero as unknown and leaves absent legacy settings absent", () => {
    const empty = sanitizeCustomProviderConfig(provider({}))
    expect("value" in empty && empty.value.models["exact-local-id"]).toEqual({ name: "Local model" })
    const zero = sanitizeCustomProviderConfig(provider({ limit: { context: 0, output: 0 } }))
    expect("value" in zero && zero.value.models["exact-local-id"].limit).toEqual({ context: 0, output: 0 })
  })

  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid context %s", (context) => {
    expect("error" in sanitizeCustomProviderConfig(provider({ limit: { context, output: 1024 } }))).toBe(true)
  })

  it("rejects limits exceeding context and mistyped tool capabilities", () => {
    for (const limit of [
      { context: 4096, input: 4097, output: 1024 },
      { context: 4096, output: 4097 },
    ])
      expect("error" in sanitizeCustomProviderConfig(provider({ limit }))).toBe(true)
    expect("error" in sanitizeCustomProviderConfig(provider({ tool_call: "false" }))).toBe(true)
  })

  it("hydrates configured limits and false tool support for editing", () => {
    const model = { limit: { context: 32768, input: 24576, output: 8192 }, tool_call: false }
    const settings = customProviderModelSettings(model)
    expect(settings).toEqual({
      limits: true,
      inputSet: true,
      context: "32768",
      input: "24576",
      output: "8192",
      tools: false,
    })
    expect(parseCustomProviderLimits(settings).value).toEqual(model.limit)
    expect(customProviderModelSettings({}).tools).toBeUndefined()
  })

  it("clears previously configured limits to zero instead of allowing a deep merge to revive them", () => {
    const settings = customProviderModelSettings({ limit: { context: 32768, input: 24576, output: 8192 } })
    const result = parseCustomProviderLimits({ ...settings, context: "", input: "", output: "" })
    expect(result.errors).toEqual({})
    expect(result.value).toEqual({ context: 0, input: 0, output: 0 })
  })

  it("preserves an absent optional input limit when editing or entering other limits", () => {
    const settings = customProviderModelSettings({ limit: { context: 32768, output: 8192 } })
    expect(parseCustomProviderLimits(settings).value).toEqual({ context: 32768, output: 8192 })
    expect(parseCustomProviderLimits({ context: "4096" }).value).toEqual({ context: 4096, output: 0 })
  })
})

describe("isCustomProviderPackage", () => {
  it("recognizes supported custom provider packages", () => {
    expect(isCustomProviderPackage("@ai-sdk/openai-compatible")).toBe(true)
    expect(isCustomProviderPackage("@ai-sdk/openai")).toBe(true)
    expect(isCustomProviderPackage("@ai-sdk/anthropic")).toBe(true)
    expect(isCustomProviderPackage("malicious-package")).toBe(false)
  })
})

describe("validateProviderID", () => {
  it("accepts valid provider ids", () => {
    expect(validateProviderID(" my-provider_1 ")).toEqual({ value: "my-provider_1" })
  })

  it("rejects invalid provider ids", () => {
    const result = validateProviderID("bad/id")
    expect("error" in result ? result.error : "").toBe("Invalid provider ID")
  })
})

describe("parseCustomProviderSecret", () => {
  it("treats plain values as api keys", () => {
    expect(parseCustomProviderSecret(" sk-test ")).toEqual({ value: { apiKey: "sk-test" } })
  })

  it("parses env references", () => {
    expect(parseCustomProviderSecret(" {env:MY_PROVIDER_KEY} ")).toEqual({ value: { env: "MY_PROVIDER_KEY" } })
  })

  it("rejects invalid env references", () => {
    const result = parseCustomProviderSecret("{env:bad-name}")
    expect("error" in result ? result.error : "").toBe("Invalid environment variable name")
  })
})

describe("resolveCustomProviderAuth", () => {
  it("preserves auth when the api key field is unchanged", () => {
    expect(resolveCustomProviderAuth(undefined, false)).toEqual({ mode: "preserve" })
  })

  it("stores a changed api key", () => {
    expect(resolveCustomProviderAuth(" sk-test ", true)).toEqual({ mode: "set", key: "sk-test" })
  })

  it("clears auth when the field was changed to empty", () => {
    expect(resolveCustomProviderAuth(undefined, true)).toEqual({ mode: "clear" })
  })
})

describe("resolveCustomProviderKey", () => {
  it("returns a masked value for api-backed providers", () => {
    expect(resolveCustomProviderKey("api")).toBe(MASKED_CUSTOM_PROVIDER_KEY)
  })

  it("hides non-api auth from the edit form", () => {
    expect(resolveCustomProviderKey("oauth")).toBe("")
  })

  it("returns empty when there is no saved key", () => {
    expect(resolveCustomProviderKey(undefined)).toBe("")
  })
})

describe("sanitizeCustomProviderConfig", () => {
  it.each(["true", 1, null, {}, []].map((value) => ({ value })))(
    "rejects a mistyped local inference choice %s",
    (row) => {
      const result = sanitizeCustomProviderConfig({
        name: "Explicit server",
        options: { baseURL: "http://127.0.0.1:1234/v1", localInference: row.value },
        models: { model: { name: "Model" } },
      })
      expect("error" in result).toBe(true)
    },
  )
  it("normalizes config and preserves an approved package", () => {
    const result = sanitizeCustomProviderConfig({
      npm: "@ai-sdk/anthropic",
      name: " My Provider ",
      env: [" MY_PROVIDER_KEY "],
      options: {
        baseURL: "https://example.com/v1 ",
        headers: {
          Authorization: " Bearer test ",
          " X-Test ": " 123 ",
        },
      },
      models: {
        " model-1 ": { name: " Model One " },
      },
    })

    expect(result).toEqual({
      value: {
        npm: "@ai-sdk/anthropic",
        name: "My Provider",
        env: ["MY_PROVIDER_KEY"],
        options: {
          baseURL: "https://example.com/v1",
          headers: {
            Authorization: "Bearer test",
            "X-Test": "123",
          },
        },
        models: {
          "model-1": { name: "Model One" },
        },
      },
    })
  })

  it("rejects unapproved packages", () => {
    const result = sanitizeCustomProviderConfig({
      npm: "malicious-package",
      name: "Bad Provider",
      options: { baseURL: "https://example.com/v1" },
      models: { "model-1": { name: "Model One" } },
    })

    expect("error" in result ? result.error : "").toContain("Invalid enum value")
  })

  it("accepts supported thinking variant options", () => {
    const result = sanitizeCustomProviderConfig({
      name: "Thinking Provider",
      options: { baseURL: "https://example.com/v1" },
      models: {
        "model-1": {
          name: "Model One",
          variants: {
            thinking: {
              thinking: { type: "adaptive" },
              reasoning_split: true,
              effort: "max",
              chat_template_args: { enable_thinking: true },
            },
          },
        },
      },
    })

    expect(result).toEqual({
      value: {
        npm: "@ai-sdk/openai-compatible",
        name: "Thinking Provider",
        options: { baseURL: "https://example.com/v1" },
        models: {
          "model-1": {
            name: "Model One",
            variants: {
              thinking: {
                thinking: { type: "adaptive" },
                reasoning_split: true,
                effort: "max",
                chat_template_args: { enable_thinking: true },
              },
            },
          },
        },
      },
    })
  })

  it("preserves opaque options on existing variants", () => {
    const variant = {
      thinking: { type: "adaptive", display: "summarized" },
      reasoningEffort: "max",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
      customOption: { enabled: true },
    }
    const result = sanitizeCustomProviderConfig({
      name: "Thinking Provider",
      options: { baseURL: "https://example.com/v1" },
      models: {
        "model-1": {
          name: "Model One",
          variants: { high: variant },
        },
      },
    })

    expect(result).toEqual({
      value: {
        npm: "@ai-sdk/openai-compatible",
        name: "Thinking Provider",
        options: { baseURL: "https://example.com/v1" },
        models: { "model-1": { name: "Model One", variants: { high: variant } } },
      },
    })
  })

  it("preserves core custom model modalities", () => {
    const result = sanitizeCustomProviderConfig({
      name: "Media Provider",
      options: { baseURL: "https://example.com/v1" },
      models: {
        "model-1": {
          name: "Model One",
          modalities: {
            input: ["text", "audio", "image", "video", "pdf"],
            output: ["text", "audio"],
          },
        },
      },
    })

    expect(result).toEqual({
      value: {
        npm: "@ai-sdk/openai-compatible",
        name: "Media Provider",
        options: { baseURL: "https://example.com/v1" },
        models: {
          "model-1": {
            name: "Model One",
            modalities: {
              input: ["text", "audio", "image", "video", "pdf"],
              output: ["text", "audio"],
            },
          },
        },
      },
    })
  })

  it("rejects unknown fields", () => {
    const result = sanitizeCustomProviderConfig({
      name: "Bad Provider",
      options: {
        baseURL: "https://example.com/v1",
        mcpServer: "https://malicious.example",
      },
      models: { "model-1": { name: "Model One" } },
    })

    expect("error" in result ? result.error : "").toContain("mcpServer")
  })
})

describe("withCustomProviderDeletions", () => {
  const baseNext = {
    npm: "@ai-sdk/openai-compatible" as const,
    name: "My Provider",
    options: { baseURL: "https://example.com/v1" },
    models: { keep: { name: "Keep" } },
  }

  it("passes through unchanged when there is no prior config", () => {
    expect(withCustomProviderDeletions(undefined, baseNext)).toEqual(baseNext)
    expect(withCustomProviderDeletions({}, baseNext)).toEqual(baseNext)
  })

  it("emits null for models present in existing but absent in next", () => {
    const existing = { models: { keep: { name: "Keep" }, gone: { name: "Gone" } } }
    const result = withCustomProviderDeletions(existing, baseNext)
    const models = result.models as Record<string, unknown>
    expect(models.keep).toEqual({ name: "Keep" })
    expect(models.gone).toBeNull()
  })

  it("emits null for reasoning and variants removed from a surviving model", () => {
    const existing = {
      models: {
        keep: {
          name: "Keep",
          reasoning: true,
          variants: { high: { reasoningEffort: "high" }, low: { reasoningEffort: "low" } },
        },
      },
    }
    const next = {
      ...baseNext,
      models: {
        keep: { name: "Keep", variants: { high: { reasoningEffort: "high" } } },
      },
    } as typeof baseNext
    const result = withCustomProviderDeletions(existing, next)
    const model = (result.models as Record<string, { reasoning?: boolean | null; variants?: Record<string, unknown> }>)
      .keep
    expect(model.reasoning).toBeNull()
    expect(model.variants?.high).toEqual({ reasoningEffort: "high" })
    expect(model.variants?.low).toBeNull()
  })

  it("emits null when reasoning is disabled on a surviving model", () => {
    const existing = { models: { keep: { name: "Keep", reasoning: true } } }
    const result = withCustomProviderDeletions(existing, baseNext)
    expect(result.models.keep).toEqual({ name: "Keep", reasoning: null })
  })

  it("emits null for options removed from a surviving variant", () => {
    const existing = {
      models: {
        keep: {
          name: "Keep",
          variants: {
            thinking: { thinking: { type: "adaptive" }, reasoning_split: true, reasoningEffort: "high" },
          },
        },
      },
    }
    const next = {
      ...baseNext,
      models: {
        keep: { name: "Keep", variants: { thinking: { reasoningEffort: "high" } } },
      },
    } as typeof baseNext
    const result = withCustomProviderDeletions(existing, next)
    const model = (result.models as Record<string, { variants: Record<string, unknown> }>).keep
    expect(model.variants.thinking).toEqual({ reasoningEffort: "high", thinking: null, reasoning_split: null })
  })

  it("does not touch variants on a model that is being deleted", () => {
    const existing = { models: { gone: { name: "Gone", variants: { a: {} } } } }
    const result = withCustomProviderDeletions(existing, baseNext)
    const models = result.models as Record<string, unknown>
    expect(models.gone).toBeNull()
  })
})
