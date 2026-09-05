// raya_change - classify provider failures so retries stop on billing and recover stream drops
export namespace KiloLlmError {
  export function text(error: unknown) {
    if (typeof error === "string") return error
    if (error instanceof Error) return `${error.name} ${error.message}`
    if (!error || typeof error !== "object") return error ? String(error) : ""
    const data = "data" in error ? (error as { data?: unknown }).data : error
    if (!data || typeof data !== "object") return JSON.stringify(error)
    const row = data as { message?: unknown; responseBody?: unknown }
    return [row.message, row.responseBody].filter((item) => typeof item === "string").join("\n")
  }

  export function billing(error: unknown) {
    return /insufficient (?:balance|credit|funds)|account suspended|payment required|invalid api key|unauthorized|authentication/i.test(
      text(error),
    )
  }

  export function stream(error: unknown) {
    return /Failed to read \S+ stream|TypeError: terminated|ECONNRESET|socket hang up|TimeoutError/i.test(text(error))
  }

  export function tpm(error: unknown) {
    return /tokens per minute|tpm|rate limit|too many requests|rate increased too quickly/i.test(text(error))
  }
}
