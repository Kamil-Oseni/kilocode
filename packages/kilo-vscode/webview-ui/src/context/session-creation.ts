export function creation() {
  const entries = new Map<string, { finish: (id?: string) => void }>()
  const retired = new Set<string>()
  const accepted = new Map<string, string>()
  const promoted = new Set<string>()
  return {
    entries,
    retired,
    promote(draft: string, id: string) {
      if (!entries.has(draft) && !retired.has(draft)) return undefined
      if (promoted.has(draft) || (retired.has(draft) && accepted.get(draft) !== id)) return false
      promoted.add(draft)
      return true
    },
    cancel() {
      for (const entry of entries.values()) entry.finish()
    },
    wait(draft: string, signal: AbortSignal | undefined) {
      return new Promise<string | undefined>((resolve) => {
        const finish = (id?: string) => {
          if (!entries.delete(draft)) return
          retired.add(draft)
          if (id) accepted.set(draft, id)
          signal?.removeEventListener("abort", cancel)
          resolve(id)
        }
        const cancel = () => finish()
        entries.set(draft, { finish })
        signal?.addEventListener("abort", cancel, { once: true })
      })
    },
  }
}
