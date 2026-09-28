export type Diagnostic = { status: "ready" | "missing" | "timeout" | "failed"; elapsedMs: number }

/** Bound diagnostic work without retaining private errors or late results. */
export function measure<T>(operation: (signal: AbortSignal) => Promise<T | undefined>, timeout: number) {
  const started = performance.now()
  const controller = new AbortController()
  return new Promise<Diagnostic & { value?: T }>((resolve) => {
    let settled = false
    const finish = (status: Diagnostic["status"], value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const elapsed = performance.now() - started
      const expired = status === "timeout" || elapsed >= timeout
      resolve({ status: expired ? "timeout" : status, elapsedMs: elapsed, value: expired ? undefined : value })
      if (expired) controller.abort(new Error("Installed diagnostic deadline exceeded"))
    }
    const timer = setTimeout(() => finish("timeout"), timeout)
    void Promise.resolve()
      .then(() => {
        if (performance.now() - started >= timeout) {
          finish("timeout")
          return undefined
        }
        return operation(controller.signal)
      })
      .then(
        (value) => finish(value === undefined ? "missing" : "ready", value),
        () => finish("failed"),
      )
  })
}
