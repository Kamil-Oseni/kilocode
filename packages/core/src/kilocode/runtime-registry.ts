/** Terminal ownership of lazy facade runtimes; registration never realizes a runtime. */
export function createRegistry() {
  const owners = new Set<() => Promise<void>>()
  let closed = false
  let closing: Promise<void> | undefined
  const check = () => {
    if (closed) throw new Error("Runtime ownership registration is closed")
  }
  return {
    check,
    register(retire: () => Promise<void>): void {
      check()
      owners.add(retire)
    },
    drain(): Promise<void> {
      if (closing) return closing
      closed = true
      const result = Promise.withResolvers<void>()
      closing = result.promise
      const tasks: Promise<void>[] = []
      // Every owner fences intake in this turn, even when an earlier callback throws.
      for (const retire of owners) {
        try {
          tasks.push(Promise.resolve(retire()))
        } catch (err) {
          tasks.push(Promise.reject(err))
        }
      }
      void Promise.allSettled(tasks).then((results) => {
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
        if (failures.length) {
          result.reject(new AggregateError(failures, "Runtime ownership retirement failed"))
          return
        }
        owners.clear()
        result.resolve()
      })
      return closing
    },
  }
}

export const RuntimeRegistry = createRegistry()
