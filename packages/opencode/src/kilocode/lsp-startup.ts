/** Join accepted startup promises before taking the final client shutdown snapshot. */
export function startups(
  snapshot: () => readonly (() => Promise<void>)[] = () => [],
  registry?: { register(retire: () => Promise<void>): void },
) {
  const pending = new Set<Promise<unknown>>()
  const failures = new Set<unknown>()
  let closed = false
  let closing: Promise<void> | undefined
  const owner = {
    fail(err: unknown) {
      failures.add(err)
    },
    run<A>(work: () => Promise<A>): Promise<A> {
      if (closed) throw new Error("LSP startup intake is closing")
      const task = Promise.resolve().then(work)
      pending.add(task)
      void task.then(
        () => pending.delete(task),
        (err: unknown) => {
          failures.add(err)
          pending.delete(task)
        },
      )
      return task
    },
    close(selected = snapshot): Promise<void> {
      if (closing) return closing
      closed = true
      const result = Promise.withResolvers<void>()
      closing = result.promise
      void Promise.allSettled(pending).then(async () => {
        const tasks = (() => {
          try {
            return selected()
          } catch (err) {
            failures.add(err)
            return []
          }
        })()
        const settled = await Promise.allSettled(tasks.map((stop) => Promise.resolve().then(stop)))
        for (const item of settled) if (item.status === "rejected") failures.add(item.reason)
        if (failures.size) {
          result.reject(new AggregateError([...failures], "LSP startup retirement failed"))
          return
        }
        result.resolve()
      })
      return closing
    },
  }
  registry?.register(() => owner.close())
  return owner
}
