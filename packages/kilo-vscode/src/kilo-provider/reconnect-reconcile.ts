export const RECONNECT_LIMIT = 40
export const RECONNECT_CONCURRENCY = 4

export type ReconnectInput = {
  ids: Iterable<string>
  focused?: string
  valid: () => boolean
  load: (id: string) => Promise<void>
  limit?: number
  concurrency?: number
}

/**
 * Reconcile every tracked transcript after an SSE gap in bounded batches.
 * The focused transcript is first, duplicate IDs are removed, and a newer
 * connection generation stops queued reads before they start.
 */
export async function reconcile(input: ReconnectInput): Promise<void> {
  const all = [...input.ids]
  const focused = input.focused && all.includes(input.focused) ? input.focused : undefined
  const ordered = focused ? [focused, ...all.filter((id) => id !== focused)] : all
  const ids = [...new Set(ordered)]
  const size = Math.max(1, input.limit ?? RECONNECT_LIMIT)
  for (let offset = 0; offset < ids.length; offset += size) {
    if (!input.valid()) return
    const batch = ids.slice(offset, offset + size)
    const width = Math.min(batch.length, Math.max(1, input.concurrency ?? RECONNECT_CONCURRENCY))
    await Promise.all(
      Array.from({ length: width }, async (_, lane) => {
        for (let index = lane; index < batch.length; index += width) {
          if (!input.valid()) return
          await input.load(batch[index]!)
        }
      }),
    )
  }
}
