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
      resolve({ status, elapsedMs: performance.now() - started, value })
    }
    const timer = setTimeout(() => {
      finish("timeout")
      controller.abort(new Error("Installed diagnostic deadline exceeded"))
    }, timeout)
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(value === undefined ? "missing" : "ready", value),
        () => finish("failed"),
      )
  })
}
