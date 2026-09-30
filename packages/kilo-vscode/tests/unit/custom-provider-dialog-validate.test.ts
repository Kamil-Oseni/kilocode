import { describe, expect, it } from "bun:test"
import { validateCustomProvider } from "../../webview-ui/src/components/settings/CustomProviderValidation"
import type { FormState } from "../../webview-ui/src/components/settings/CustomProviderValidation"
import {
  customProviderModelSettings,
  sanitizeCustomProviderConfig,
  withCustomProviderDeletions,
} from "../../src/shared/custom-provider"

// Simple translator that returns the key so tests can assert on key names
const t = (key: string) => key

function base(): FormState {
  return {
    providerID: "my-provider",
    name: "My Provider",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://example.com/v1",
    apiKey: "",
    models: [
      { id: "model-1", name: "Model One", reasoning: false, supportsImages: false, modalities: {}, variants: [] },
    ],
    headers: [],
    saving: false,
  }
}

function args(form: FormState) {
  return {
    form,
    t,
    editing: false,
    disabledProviders: [],
    existingProviderIDs: new Set<string>(),
  }
}

describe("custom provider model limits save path", () => {
  it("retains saved input/output/context limits and explicit false through edit, validation and the saved config patch", () => {
    const form = base()
    const model = { name: "Model One", limit: { context: 32768, input: 24576, output: 8192 }, tool_call: false }
    Object.assign(form.models[0], customProviderModelSettings(model))
    const result = validateCustomProvider({ ...args(form), editing: true }).result
    expect(result).toBeDefined()
    const sanitized = sanitizeCustomProviderConfig(result!.config)
    if (!("value" in sanitized)) throw new Error(sanitized.error)
    const patch = withCustomProviderDeletions({ models: { "model-1": model } }, sanitized.value)
    expect(patch.models["model-1"]).toEqual(model)
  })

  it("retains an explicit tool choice without inventing limits", () => {
    const form = base()
    form.models[0].tools = false
    expect(validateCustomProvider(args(form)).result?.config.models["model-1"]).toEqual({
      name: "Model One",
      tool_call: false,
    })
    form.models[0].tools = true
    expect(validateCustomProvider(args(form)).result?.config.models["model-1"]).toEqual({
      name: "Model One",
      tool_call: true,
    })
  })

  it.each(["-1", "0", "1.5", "Infinity", "32k", "9007199254740992"])("blocks invalid token text %s", (context) => {
    const form = base()
    form.models[0].context = context
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeUndefined()
    expect(out.errors.models[0].context).toBeDefined()
  })

  it("reports input/output limits at their fields when they exceed context", () => {
    const form = base()
    Object.assign(form.models[0], { context: "4096", input: "8192", output: "8192" })
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeUndefined()
    expect(out.errors.models[0].input).toBe("Must fit within the context window")
    expect(out.errors.models[0].output).toBe("Must fit within the context window")
  })

  it("writes explicit zeros when all old limits are cleared", () => {
    const form = base()
    Object.assign(form.models[0], { limits: true, inputSet: true, context: "", input: "", output: "" })
    const result = validateCustomProvider(args(form)).result
    expect(result?.config.models["model-1"]).toEqual({ name: "Model One", limit: { context: 0, input: 0, output: 0 } })
  })
})

describe("validateCustomProvider – variant name validation", () => {
  it("persists the selected provider package", () => {
    const form = base()
    form.npm = "@ai-sdk/openai"

    expect(validateCustomProvider(args(form)).result?.config.npm).toBe("@ai-sdk/openai")
  })

  it("allows reconnecting a disabled provider id", () => {
    const form = base()
    const out = validateCustomProvider({
      ...args(form),
      disabledProviders: ["my-provider"],
      existingProviderIDs: new Set(["my-provider"]),
    })

    expect(out.result?.providerID).toBe("my-provider")
    expect(out.errors.providerID).toBeUndefined()
  })

  it("allows submit when reasoning is enabled with no variants", () => {
    const form = base()
    form.models[0].reasoning = true
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    expect(out.errors.models[0].variants).toEqual([])
  })

  it("allows submit when reasoning is enabled with a named variant", () => {
    const form = base()
    form.models[0].reasoning = true
    form.models[0].variants = [
      {
        name: "fast",
        enableThinking: undefined,
        thinking: undefined,
        splitReasoning: undefined,
        outputEffort: undefined,
        reasoningEffort: undefined,
        chatTemplateArgs: undefined,
      },
    ]
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    expect(out.errors.models[0].variants?.[0]?.name).toBeUndefined()
  })

  it("blocks submit and reports error when reasoning is enabled with an empty variant name", () => {
    const form = base()
    form.models[0].reasoning = true
    form.models[0].variants = [
      {
        name: "",
        enableThinking: undefined,
        thinking: undefined,
        splitReasoning: undefined,
        outputEffort: undefined,
        reasoningEffort: undefined,
        chatTemplateArgs: undefined,
      },
    ]
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeUndefined()
    expect(out.errors.models[0].variants?.[0]?.name).toBe('variants[""]: provider.custom.error.required')
  })

  it("blocks submit and reports error when reasoning is enabled with a whitespace-only variant name", () => {
    const form = base()
    form.models[0].reasoning = true
    form.models[0].variants = [
      {
        name: "   ",
        enableThinking: undefined,
        thinking: undefined,
        splitReasoning: undefined,
        outputEffort: undefined,
        reasoningEffort: undefined,
        chatTemplateArgs: undefined,
      },
    ]
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeUndefined()
    expect(out.errors.models[0].variants?.[0]?.name).toBe('variants["   "]: provider.custom.error.required')
  })

  it("blocks submit and reports duplicate error for two variants with the same name", () => {
    const form = base()
    form.models[0].reasoning = true
    form.models[0].variants = [
      {
        name: "fast",
        enableThinking: undefined,
        thinking: undefined,
        splitReasoning: undefined,
        outputEffort: undefined,
        reasoningEffort: undefined,
        chatTemplateArgs: undefined,
      },
      {
        name: "fast",
        enableThinking: undefined,
        thinking: undefined,
        splitReasoning: undefined,
        outputEffort: undefined,
        reasoningEffort: undefined,
        chatTemplateArgs: undefined,
      },
    ]
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeUndefined()
    expect(out.errors.models[0].variants?.[1]?.name).toBe('variants["fast"]: provider.custom.error.duplicate')
  })

  it("ignores variants entirely when reasoning is disabled, even if they have empty names", () => {
    const form = base()
    form.models[0].reasoning = false
    form.models[0].variants = [
      {
        name: "",
        enableThinking: undefined,
        thinking: undefined,
        splitReasoning: undefined,
        outputEffort: undefined,
        reasoningEffort: undefined,
        chatTemplateArgs: undefined,
      },
    ]
    const out = validateCustomProvider(args(form))
    // No variant errors produced; form is allowed to submit
    expect(out.errors.models[0].variants).toEqual([])
    // Variant is not included in the saved config
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.variants).toBeUndefined()
  })

  it("treats model IDs differing only in case as duplicates", () => {
    const form = base()
    form.models = [
      { id: "qwen2.5-coder:14b", name: "Qwen", reasoning: false, variants: [] },
      { id: "QWEN2.5-CODER:14B", name: "Qwen Upper", reasoning: false, variants: [] },
    ]
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeUndefined()
    expect(out.errors.models[0].id).toBeUndefined()
    expect(out.errors.models[1].id).toBe("provider.custom.error.duplicate")
  })

  it("persists named variants in the saved config when reasoning is enabled", () => {
    const form = base()
    form.models[0].reasoning = true
    form.models[0].variants = [
      {
        name: "eco",
        enableThinking: true,
        thinking: "adaptive",
        splitReasoning: false,
        outputEffort: "max",
        reasoningEffort: "low",
        chatTemplateArgs: undefined,
      },
    ]
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.variants).toEqual({
      eco: {
        enable_thinking: true,
        thinking: { type: "adaptive" },
        reasoning_split: false,
        effort: "max",
        reasoningEffort: "low",
      },
    })
  })

  it("preserves opaque variant options after the editor controls are removed", () => {
    const form = base()
    const raw = {
      thinking: { type: "adaptive", display: "summarized" },
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
      customOption: { enabled: true },
    }
    form.models[0].reasoning = true
    form.models[0].variants = [
      {
        name: "high",
        raw,
        enableThinking: undefined,
        thinking: "adaptive",
        splitReasoning: undefined,
        outputEffort: undefined,
        reasoningEffort: undefined,
        chatTemplateArgs: undefined,
      },
    ]

    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.variants).toEqual({ high: raw })
  })

  it("serializes image modality when supportsImages is set", () => {
    const form = base()
    form.models[0].supportsImages = true
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.modalities).toEqual({ input: ["text", "image"] })
  })

  it("omits modalities when supportsImages is not set on a text-only model", () => {
    const form = base()
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.modalities).toBeUndefined()
  })

  it("preserves an existing image-only input when saving", () => {
    const form = base()
    form.models[0].modalities = { input: ["image"] }
    form.models[0].supportsImages = true
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.modalities).toEqual({ input: ["image"] })
  })

  it("omits an empty input when image support is removed from an image-only model", () => {
    const form = base()
    form.models[0].modalities = { input: ["image"] }
    form.models[0].supportsImages = false
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.modalities).toBeUndefined()
  })

  it("preserves output-only modalities when saving", () => {
    const form = base()
    form.models[0].modalities = { output: ["audio"] }
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.modalities).toEqual({ output: ["audio"] })
  })

  it("preserves unsupported UI modalities when toggling image support", () => {
    const form = base()
    form.models[0].modalities = {
      input: ["text", "audio", "image", "video", "pdf"],
      output: ["text", "audio"],
    }
    form.models[0].supportsImages = false
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const saved = out.result!.config.models["model-1"] as Record<string, unknown>
    expect(saved.modalities).toEqual({ input: ["text", "audio", "video", "pdf"], output: ["text", "audio"] })
  })

  it("handles multiple models with reasoning and images toggled", () => {
    const form = base()
    form.models = [
      { id: "m1", name: "Model 1", reasoning: true, supportsImages: true, modalities: {}, variants: [] },
      { id: "m2", name: "Model 2", reasoning: true, supportsImages: false, modalities: {}, variants: [] },
    ]
    const out = validateCustomProvider(args(form))
    expect(out.result).toBeDefined()
    const m1 = out.result!.config.models["m1"] as Record<string, unknown>
    const m2 = out.result!.config.models["m2"] as Record<string, unknown>
    expect(m1.reasoning).toBe(true)
    expect(m1.modalities).toEqual({ input: ["text", "image"] })
    expect(m2.reasoning).toBe(true)
    expect(m2.modalities).toBeUndefined()
  })
})
