/** Fence RPC intake before joining calls already admitted to this worker. */
export function workerIntake(begin?: () => Promise<void>) {
  const pending = new Set<Promise<unknown>>()
  let closing: Promise<unknown> | undefined
  return (method: string, work: () => unknown): Promise<unknown> => {
    if (method === "shutdown") {
      if (closing) return closing
      const outcome = Promise.withResolvers<unknown>()
      closing = outcome.promise
      const started = (() => {
        try {
          return Promise.resolve(begin?.())
        } catch (err) {
          return Promise.reject(err)
        }
      })()
      void Promise.allSettled([started, ...pending]).then(async (accepted) => {
        const [result] = await Promise.allSettled([Promise.resolve().then(work)])
        const failures = [...accepted, result].flatMap((item) => (item.status === "rejected" ? [item.reason] : []))
        if (failures.length) {
          outcome.reject(new AggregateError(failures, "TUI worker shutdown failed"))
          return
        }
        outcome.resolve(result.status === "fulfilled" ? result.value : undefined)
      })
      return closing
    }
    if (closing) return Promise.reject(new Error("TUI worker RPC intake is closing"))
    const task = Promise.resolve().then(work)
    pending.add(task)
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    )
    return task
  }
}
