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
 * Reconcile a bounded snapshot of tracked transcripts after an SSE gap.
 * The focused transcript is first, duplicate IDs are removed, and a newer
 * connection generation stops queued reads before they start.
 */
export async function reconcile(input: ReconnectInput): Promise<void> {
  const all = [...input.ids]
  const focused = input.focused && all.includes(input.focused) ? input.focused : undefined
  const ordered = focused ? [focused, ...all.filter((id) => id !== focused)] : all
  const ids = [...new Set(ordered)].slice(0, input.limit ?? RECONNECT_LIMIT)
  const width = Math.min(ids.length, Math.max(1, input.concurrency ?? RECONNECT_CONCURRENCY))

  await Promise.all(
    Array.from({ length: width }, async (_, lane) => {
      for (let index = lane; index < ids.length; index += width) {
        if (!input.valid()) return
        await input.load(ids[index]!)
      }
    }),
  )
}
