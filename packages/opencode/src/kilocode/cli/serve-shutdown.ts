import { lifecycle } from "./lifecycle"
import { scheduler, schedulerQuiesce } from "../task/admission"
import { captureRequested, listen } from "../daemon/child"
import { failure } from "../migration/source-failure"

function refused(code: string, cause?: unknown, stage?: number) {
  return Object.assign(
    new Error(
      stage
        ? `Serve cleanup stage ${stage} ${code.endsWith("TIMEOUT") ? "timed out" : "failed"}`
        : "Serve cleanup refused",
      { cause },
    ),
    { code, ...(stage ? { stage } : {}) },
  )
}

async function guarded(work: () => void | Promise<void>, code: string) {
  try {
    await work()
  } catch (err) {
    throw refused(code, err)
  }
}

type Signals = {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  off(signal: NodeJS.Signals, listener: () => void): unknown
}

export function serveShutdown(input: {
  signals: Signals
  watchdog: () => void
  admission?: () => Promise<void>
  tasks: readonly (() => void | Promise<void>)[]
  timeout?: number
}) {
  const timeout = input.timeout ?? 10_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 60_000)
    throw new Error("Invalid serve cleanup deadline")
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"]
  const outcome = Promise.withResolvers<void>()
  const admission = input.admission
  const cleanup = lifecycle([
    () => guarded(input.watchdog, "RAYA_SERVE_WATCHDOG_FAILED"),
    // Accepted native/model work cannot be disposed safely merely because a deadline passed.
    // External forced termination remains an uncertain crash, never a confirmed drain.
    ...(admission ? [() => guarded(admission, "RAYA_SERVE_ADMISSION_FAILED")] : []),
    ...input.tasks.map((task, index) => async () => {
      const timer: { value?: ReturnType<typeof setTimeout> } = {}
      try {
        const joined = Promise.allSettled([Promise.resolve().then(task)])
        const expired = await Promise.race([
          joined.then(() => false),
          new Promise<boolean>((resolve) => {
            timer.value = setTimeout(() => resolve(true), timeout)
          }),
        ])
        // A missed deadline is retained, but does not release ownership of the actual task.
        const [result] = await joined
        const failures = [
          ...(expired ? [refused("RAYA_SERVE_TASK_TIMEOUT", undefined, index + 1)] : []),
          ...(result.status === "rejected" ? [refused("RAYA_SERVE_TASK_FAILED", result.reason, index + 1)] : []),
        ]
        if (failures.length === 1) throw failures[0]
        if (failures.length) throw new AggregateError(failures, "Serve cleanup stage failed")
      } finally {
        clearTimeout(timer.value)
      }
    }),
  ])
  const run = () => {
    const pending = cleanup.run()
    void pending.then(outcome.resolve, outcome.reject)
    return pending
  }
  const listener = () => {
    void run()
  }
  for (const signal of signals) input.signals.on(signal, listener)
  return {
    run,
    wait: outcome.promise.finally(() => {
      for (const signal of signals) input.signals.off(signal, listener)
    }),
  }
}

/** Fence all intake before cancelling owned Session work; join every started drain even on failure. */
export async function retire(input: {
  source: () => Promise<void>
  requests: () => Promise<void>
  scheduled: () => Promise<void>
  stop: () => Promise<void>
}) {
  const joined = Promise.allSettled([
    guarded(input.source, "RAYA_SERVE_SOURCE_LISTENER_FAILED"),
    guarded(input.requests, "RAYA_SERVE_HTTP_DRAIN_FAILED"),
    guarded(input.scheduled, "RAYA_SERVE_SCHEDULER_DRAIN_FAILED"),
  ])
  const stopped = await Promise.allSettled([guarded(input.stop, "RAYA_SERVE_SESSION_STOP_FAILED")])
  const results = [...stopped, ...(await joined)]
  const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length) throw new AggregateError(failures, "Server and scheduler admission retirement failed")
}

/** Start both actual cancellation owners before waiting for either original drain. */
export async function stop() {
  const { Cause, Effect, Exit, Fiber } = await import("effect")
  const { SessionRetirement } = await import("../session/retirement")
  await Effect.runPromise(
    Effect.uninterruptible(
      Effect.gen(function* () {
        // The inner original must have its actual stop authority before outer AbortSignal propagation.
        const inner = yield* SessionRetirement.stop.pipe(Effect.forkChild({ startImmediately: true }))
        const original = yield* scheduler.stop.pipe(Effect.forkChild({ startImmediately: true }))
        const session = yield* Fiber.await(inner)
        const scheduled = yield* Fiber.await(original)
        const failures = [scheduled, session].flatMap((exit) =>
          Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [],
        )
        if (failures.length)
          return yield* Effect.die(new AggregateError(failures, "Owned scheduler and Session stop failed"))
        return undefined
      }),
    ),
  )
}

/** Cooperative retirement retains failures and joins actual work before outer cleanup. */
export async function waitForServe(server: { quiesce(): Promise<void>; stop(close?: boolean): Promise<void> }) {
  const source = await import("../migration/source-host")
  const channel = { close: () => Promise.resolve() }
  const { startParentWatchdog } = await import("../parent-watchdog")
  const watchdog = startParentWatchdog(() => {
    void shutdown.run()
  })
  const shutdown = serveShutdown({
    signals: process,
    watchdog,
    admission: () =>
      retire({
        source: channel.close,
        requests: () => server.quiesce(),
        scheduled: schedulerQuiesce,
        stop,
      }),
    tasks: [
      async () => {
        if (!captureRequested() && !source.captureRequested()) return
        const { BackgroundProcess } = await import("../background-process")
        await BackgroundProcess.closeForCapture()
      },
      async () => {
        const { Effect } = await import("effect")
        const { drain } = await import("./producer-retirement")
        await Effect.runPromise(drain)
      },
      async () => {
        const { KiloSessions } = await import("@/kilo-sessions/kilo-sessions")
        await KiloSessions.drainIngestForShutdown()
      },
      async () => {
        const { SessionExport } = await import("../session-export")
        await SessionExport.shutdown()
      },
      async () => {
        const { InstanceRuntime } = await import("@/project/instance-runtime")
        await InstanceRuntime.disposeAllInstances()
      },
      () => server.stop(true),
      async () => {
        const { HttpApiApp } = await import("@/server/routes/instance/httpapi/server")
        if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
      },
    ],
  })
  channel.close = await source.listen(shutdown.run)
  const close = listen(shutdown.run)
  const wait = await Promise.allSettled([shutdown.wait])
  const results = await Promise.allSettled([
    guarded(close, "RAYA_SERVE_DAEMON_LISTENER_FAILED"),
    guarded(channel.close, "RAYA_SERVE_SOURCE_LISTENER_FAILED"),
  ])
  const failures = [...wait, ...results].flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (failures.length) {
    const err = new AggregateError(failures, "Serve shutdown or handoff listener close failed")
    // Classify the original aggregate before Effect/CLI display flattens it. Never publish messages or stacks.
    try {
      process.stderr.write(`RAYA_SERVE_CLEANUP_FAILURE ${JSON.stringify(failure(err))}\n`)
    } catch (report) {
      throw new AggregateError([err, refused("RAYA_SERVE_REPORT_FAILED", report)], "Serve cleanup reporting failed", {
        cause: err,
      })
    }
    throw err
  }
}
