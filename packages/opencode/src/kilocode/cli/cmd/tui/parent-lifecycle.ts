type Reason = { reason: string; code: number; signal?: NodeJS.Signals }

/** Own parent intake and join renderer/scope retirement before the correlated worker stop. */
export function parentLifecycle(input: { stop: () => Promise<unknown>; interrupt?: () => void }) {
  const disposers: (() => void)[] = []
  const cancellers: (() => void)[] = []
  const failures: unknown[] = []
  let requested = false
  let exit: (() => void) | undefined
  let rendering: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const cancel = () => {
    for (const dispose of cancellers.splice(0).reverse()) {
      try {
        dispose()
      } catch (err) {
        failures.push(err)
      }
    }
  }
  const close = () => {
    const callback = exit
    exit = undefined
    try {
      callback?.()
    } catch (err) {
      failures.push(err)
    }
  }
  const request = (reason: Reason) => {
    if (requested) return
    requested = true
    cancel()
    if (reason.code !== 0 || Number(process.exitCode ?? 0) === 0) process.exitCode = reason.code
    console.info("Shutting down TUI thread", { ...reason, pid: process.pid, ppid: process.ppid })
    close()
    try {
      input.interrupt?.()
    } catch (err) {
      failures.push(err)
    }
  }
  for (const [signal, code] of [
    ["SIGHUP", 129],
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    const listener = () => request({ reason: "signal", signal, code })
    process.on(signal, listener)
    disposers.push(() => process.off(signal, listener))
  }
  const parent = process.ppid
  const orphan = setInterval(() => {
    if (process.ppid !== parent) return request({ reason: "parent-exit", code: 0 })
    if (parent === 1) return
    try {
      process.kill(parent, 0)
    } catch (err) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH") {
        request({ reason: "parent-exit", code: 0 })
        return
      }
      console.debug("TUI parent liveness check failed", { parent, error: err })
    }
  }, 1000)
  orphan.unref()
  disposers.push(() => clearInterval(orphan))
  const lifecycle = {
    requested: () => requested,
    defer(dispose: () => void) {
      if (requested) return dispose()
      cancellers.push(dispose)
    },
    render(body: (publish: (exit: () => void) => void) => Promise<void>) {
      if (rendering) throw new Error("TUI renderer is already running")
      if (requested) return Promise.resolve()
      rendering = Promise.resolve().then(() =>
        requested
          ? undefined
          : body((callback) => {
              exit = callback
              if (requested) close()
            }),
      )
      // The command owns the primary rejection; finish also joins and retains it.
      void rendering.catch(() => undefined)
      return rendering
    },
    finish(failure?: unknown) {
      if (failure !== undefined && !closing) failures.push(failure)
      requested = true
      cancel()
      return (closing ??= Promise.resolve().then(async () => {
        close()
        if (rendering)
          await rendering.catch((err) => {
            if (!failures.includes(err)) failures.push(err)
          })
        await Promise.resolve()
          .then(input.stop)
          .catch((err) => {
            failures.push(err)
          })
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose()
          } catch (err) {
            failures.push(err)
          }
        }
        if (!failures.length) return
        if (Number(process.exitCode ?? 0) === 0) process.exitCode = 1
        throw new AggregateError(failures, "TUI parent retirement failed", { cause: failures[0] })
      }))
    },
    async use<A>(body: () => Promise<A>) {
      try {
        return await body()
      } catch (err) {
        await lifecycle.finish(err)
        throw err
      } finally {
        await lifecycle.finish()
      }
    },
  }
  return lifecycle
}
