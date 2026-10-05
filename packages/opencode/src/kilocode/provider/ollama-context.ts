import { isRecord } from "@/util/record"
import { asSchema, type Tool } from "ai"

const originals = new WeakMap<object, readonly { name: string; parameters: Record<string, unknown> }[]>()

export function schemas(options: Readonly<Record<string, unknown>>) {
  return originals.get(options)
}

/** Bind the same configured model window used by request preflight to local transport. */
export function context(
  options: Readonly<Record<string, unknown>>,
  model: { api: { id: string }; limit: { context: number } },
  tools?: Record<string, Tool>,
) {
  if (options.localInference !== true || options.localInferenceAPI !== "ollama") return options
  const size = model.limit.context
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid configured local model context")
  const explicit = options.localInferenceContext
  if (
    explicit !== undefined &&
    (typeof explicit !== "number" || !Number.isSafeInteger(explicit) || explicit < 2048 || explicit > 262144)
  )
    throw new Error("Invalid explicit local model context")
  if (explicit !== undefined && size > 0 && explicit !== size)
    throw new Error("Explicit local context differs from configured model window")
  const result = {
    ...options,
    localInferenceToolFormat: options.localInferenceToolFormat,
    ollamaModel: model.api.id,
    ollamaContext: size > 0 ? size : explicit,
  }
  if (
    tools &&
    (Object.hasOwn(tools, "update_goal") || (Object.keys(tools).length === 1 && Object.hasOwn(tools, "chief_route"))) &&
    options.localInferenceToolFormat === "completion-envelope-v1"
  ) {
    const entries = Object.entries(tools)
    if (entries.length > 128) throw new Error("Original tool snapshot exceeds bound")
    const state = { bytes: 0 }
    const rows = entries.map(([name, tool]) => {
      const value = asSchema(tool.inputSchema).jsonSchema
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid original tool schema")
      const encoded = JSON.stringify(value)
      state.bytes += Buffer.byteLength(encoded)
      if (state.bytes > 128 * 1024) throw new Error("Original tool snapshot exceeds bound")
      const parameters: unknown = JSON.parse(encoded)
      if (!isRecord(parameters)) throw new Error("Invalid original tool schema")
      return { name, parameters }
    })
    originals.set(result, rows)
  }
  return result
}
