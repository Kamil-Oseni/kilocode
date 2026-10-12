import { structured } from "@/kilocode/provider/ollama-context"
import { keyless } from "@/kilocode/provider/native-policy"
import { isRecord } from "@/util/record"

const cues = new WeakSet<object>()

/** Called only after the original persistent dispatch passes its live ownership check. */
export function select(options: Readonly<Record<string, unknown>>, npm: string) {
  if (!structured(options, npm) || !keyless(options, npm)) return options
  if (options.localInferenceToolFormat !== undefined && options.localInferenceToolFormat !== "completion-envelope-v1")
    return options
  const result = { ...options, localInferenceToolFormat: "completion-envelope-v1" }
  cues.add(result)
  return result
}

/** Serialized provider options cannot mint a request-scoped native cue. */
export function admitted(options: Readonly<Record<string, unknown>>) {
  return cues.has(options)
}

/** The native Chat protocol consumes OpenAI options rather than the AI SDK compatible namespace. */
export function parameters(
  cue: Readonly<Record<string, unknown>>,
  options: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  provider: string,
) {
  const selected = options[provider.split(".")[0]]
  if (!admitted(cue) || !isRecord(selected)) return options
  return {
    ...options,
    openai: { ...selected, ...(isRecord(options.openai) ? options.openai : {}) },
  }
}
