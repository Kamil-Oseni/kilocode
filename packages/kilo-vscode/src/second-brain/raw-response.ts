import { Failure } from "./client"

/** Join the original response reader; preserve primary and cleanup failures. */
export async function raw(response: Response, signal: AbortSignal, limit = 262144) {
  const reader = response.body?.getReader()
  const result = await (async () => {
    if (!reader || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
      throw new Failure("invalid_response", "Memory API returned an unsupported response.", response.status)
    const parts: Uint8Array[] = []
    let size = 0
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > limit)
        throw new Failure("invalid_response", "Memory response exceeded its size limit.", response.status)
      parts.push(item.value)
    }
    signal.throwIfAborted()
    return Buffer.concat(parts, size)
  })().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  const cleanup = await (async () => {
    if (!reader) return
    const failure = await reader.cancel().then(
      () => undefined,
      (error: unknown) => error,
    )
    const release = (() => {
      try {
        reader.releaseLock()
      } catch (error) {
        return error
      }
    })()
    if (failure !== undefined && release !== undefined)
      throw new AggregateError([failure, release], "Memory response cleanup failed")
    if (failure !== undefined) throw failure
    if (release !== undefined) throw release
  })().then(
    () => undefined,
    (error: unknown) => error,
  )
  if ("error" in result) {
    if (cleanup !== undefined) throw new AggregateError([result.error, cleanup], "Memory response cleanup failed")
    throw result.error
  }
  if (cleanup !== undefined) throw cleanup
  signal.throwIfAborted()
  return result.value
}
