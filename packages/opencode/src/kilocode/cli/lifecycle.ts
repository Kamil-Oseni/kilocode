/** Terminal, ordered cleanup that keeps later persistence cleanup available after a refusal. */
export function lifecycle(tasks: readonly (() => void | Promise<void>)[]) {
  let closing: Promise<void> | undefined
  return {
    get started() {
      return closing !== undefined
    },
    check() {
      if (closing) throw new Error("CLI lifecycle is closing or closed")
    },
    run() {
      return (closing ??= Promise.resolve().then(async () => {
        const failures: unknown[] = []
        for (const task of tasks) {
          const [result] = await Promise.allSettled([Promise.resolve().then(task)])
          if (result.status === "rejected") failures.push(result.reason)
        }
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, "CLI shutdown cleanup failed")
      }))
    },
  }
}
