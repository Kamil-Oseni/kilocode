export function createShutdown() {
  const tasks = new Set<() => void | Promise<void>>()
  let closing: Promise<void> | undefined

  function register(task: () => void | Promise<void>) {
    if (closing) throw new Error("Process shutdown registration is closed")
    tasks.add(task)
    return () => tasks.delete(task)
  }

  function run() {
    if (closing) return closing
    const pending = Array.from(tasks)
    tasks.clear()
    closing = Promise.allSettled(pending.map((task) => Promise.resolve().then(task))).then((results) => {
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, "Process shutdown cleanup failed")
    })
    return closing
  }

  return { register, run }
}

export const KiloShutdown = createShutdown()
