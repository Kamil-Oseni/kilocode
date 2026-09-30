import { localConfig } from "./local-scheduler"

export function keyless(options: Readonly<Record<string, unknown>>, npm: string) {
  if (!localConfig(options).enabled || npm !== "@ai-sdk/openai-compatible") return false
  if (typeof options.baseURL !== "string" || !options.baseURL.trim()) return false
  const url = URL.parse(options.baseURL)
  return url !== null && (url.protocol === "http:" || url.protocol === "https:")
}

export function refuse(options: Readonly<Record<string, unknown>>, required: boolean) {
  return required && localConfig(options).enabled
}

export class LocalNativeError extends Error {
  readonly isRetryable = false
  constructor() {
    super("This local model server needs a supported tool-call connection. Check its provider settings and try again.")
    this.name = "LocalNativeError"
  }
}
