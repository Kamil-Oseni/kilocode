/** A deadline records refusal; it never substitutes for joining plugin cleanup. */
export function cleanup(begin: () => readonly (() => unknown)[], ms: number, report: (err: unknown) => void) {
  let closing: Promise<void> | undefined
  return () => {
    if (closing) return closing
    const result = Promise.withResolvers<void>()
    closing = result.promise
    const failures: unknown[] = []
    const fail = (err: unknown) => {
      failures.push(err)
      try {
        report(err)
      } catch (err) {
        failures.push(err)
      }
    }
    const timer = setTimeout(
      () => fail(new Error(`TUI plugin cleanup exceeded ${ms}ms; completion remains unconfirmed`)),
      ms,
    )
    void (async () => {
      for (const fn of begin()) {
        try {
          await fn()
        } catch (err) {
          fail(err)
        }
      }
    })().then(
      () => {
        clearTimeout(timer)
        if (failures.length) {
          result.reject(new AggregateError(failures, "TUI plugin cleanup failed"))
          return
        }
        result.resolve()
      },
      (err) => {
        clearTimeout(timer)
        failures.push(err)
        result.reject(new AggregateError(failures, "TUI plugin cleanup failed"))
      },
    )
    return closing
  }
}

/** One host generation owns admitted operations and every scope, including unpublished activation. */
export function generation() {
  const pending = new Set<Promise<unknown>>()
  const owners = new Set<() => Promise<void>>()
  const failures = new Set<unknown>()
  let closing: Promise<void> | undefined
  const check = () => {
    if (closing) throw new Error("TUI plugin host admission is closed")
  }
  return {
    check,
    fail(err: unknown) {
      failures.add(err)
    },
    own(close: () => Promise<void>) {
      if (closing && !pending.size) throw new Error("TUI plugin scope admission is closed")
      owners.add(close)
    },
    run<A>(body: () => Promise<A>): Promise<A> {
      check()
      const task = Promise.resolve().then(body)
      pending.add(task)
      void task.then(
        () => pending.delete(task),
        (err) => {
          failures.add(err)
          pending.delete(task)
        },
      )
      return task
    },
    drain(after: () => readonly (() => unknown)[]): Promise<void> {
      if (closing) return closing
      const result = Promise.withResolvers<void>()
      closing = result.promise
      void (async () => {
        while (pending.size) await Promise.allSettled(pending)
        // Includes scopes whose activation completed after the terminal fence.
        for (const close of [...owners].reverse()) {
          try {
            await close()
          } catch (err) {
            failures.add(err)
          }
        }
        for (const fn of after()) {
          try {
            await fn()
          } catch (err) {
            failures.add(err)
          }
        }
        if (failures.size) throw new AggregateError([...failures], "TUI plugin host retirement failed")
      })().then(result.resolve, result.reject)
      return closing
    },
  }
}
