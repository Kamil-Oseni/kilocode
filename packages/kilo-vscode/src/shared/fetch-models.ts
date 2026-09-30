/**
 * Fetch available models from an OpenAI-compatible /models endpoint.
 * Runs in the extension host — no CLI backend dependency.
 */

type Options = {
  baseURL: string
  apiKey?: string
  headers?: Record<string, string>
}

type ModelEntry = {
  id: string
  name: string
}

export class FetchModelsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "FetchModelsError"
  }

  get auth() {
    return this.status === 401 || this.status === 403
  }
}

async function read(response: Response) {
  if (!response.body) throw new FetchModelsError("The model server returned an empty response.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let content = ""
  let complete = false
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) {
        complete = true
        content += decoder.decode()
        break
      }
      bytes += part.value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new FetchModelsError("The model list is too large.")
      content += decoder.decode(part.value, { stream: true })
    }
  } finally {
    if (!complete) await reader.cancel()
    reader.releaseLock()
  }
  try {
    return JSON.parse(content) as unknown
  } catch {
    throw new FetchModelsError("The model server returned invalid JSON.")
  }
}

export async function fetchOpenAIModels(opts: Options): Promise<ModelEntry[]> {
  const url = opts.baseURL.replace(/\/+$/, "") + "/models"
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  }
  if (opts.apiKey) headers["Authorization"] = `Bearer ${opts.apiKey}`
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new FetchModelsError(
      response.status >= 300 && response.status < 400
        ? "The model server redirected the request. Use its final API address."
        : `The model server returned HTTP ${response.status}.`,
      response.status,
    )
  }
  const body = await read(response)
  const items = body && typeof body === "object" && "data" in body ? body.data : undefined
  if (!Array.isArray(items)) throw new FetchModelsError("The model server did not return a model list.")
  if (items.length > 4096) throw new FetchModelsError("The model list has too many entries.")

  const seen = new Set<string>()
  const result: ModelEntry[] = []
  for (const item of items) {
    if (!item || typeof item !== "object") continue
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (Math.max(id.length, typeof item.name === "string" ? item.name.length : 0) > 1024)
      throw new FetchModelsError("A model name is too long.")
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push({ id, name: typeof item.name === "string" ? item.name.trim() : id })
  }
  result.sort((a, b) => a.id.localeCompare(b.id))
  return result
}
