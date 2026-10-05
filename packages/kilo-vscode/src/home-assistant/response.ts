import { Failure, safe } from "./error"

export async function response(value: Response, signal: AbortSignal, mutation: boolean): Promise<unknown> {
  const reader = value.body?.getReader()
  const result = await (async () => {
    if (!value.ok) throw new Failure(`http_${value.status}`, mutation)
    if (!reader || value.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      throw new Failure("invalid_response", mutation)
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 262144) throw new Failure("response_too_large", mutation)
      chunks.push(item.value)
    }
    signal.throwIfAborted()
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown
  })().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  const errors: unknown[] = []
  if (reader) {
    await reader.cancel().catch((error: unknown) => {
      errors.push(error)
    })
    try {
      reader.releaseLock()
    } catch (error) {
      errors.push(error)
    }
  }
  if ("error" in result) errors.unshift(result.error)
  if (errors.length) {
    const retained = errors.map((error) => safe(error, mutation))
    if (retained.length === 1) throw retained[0]
    throw new AggregateError(retained, "Home Assistant original response and cleanup failures retained")
  }
  if (signal.aborted) throw new Failure("aborted_or_expired", mutation)
  return "value" in result ? result.value : undefined
}
