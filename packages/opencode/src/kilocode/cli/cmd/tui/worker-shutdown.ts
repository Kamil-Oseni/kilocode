import { retire as databases } from "../../database-retirement"
import { lifecycle } from "../../lifecycle"
import * as Log from "@opencode-ai/core/util/log"
import { drainFileLoggers } from "@opencode-ai/core/kilocode/file-logger"
import { closeProcessProfile } from "@opencode-ai/core/kilocode/process-profile"

/** Fence independent intake owners in this turn before joining any accepted work. */
export function quiesce(tasks: readonly (() => Promise<void>)[]): Promise<void> {
  const pending = tasks.map((task) => {
    try {
      return task()
    } catch (err) {
      return Promise.reject(err)
    }
  })
  return Promise.allSettled(pending).then((results) => {
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "TUI worker intake quiescence failed")
  })
}

export function shutdown(input: {
  drain: () => Promise<void>
  stopHeap: () => Promise<void>
  dispose: () => Promise<void>
  stopServer: () => Promise<void>
  closeHandler?: () => Promise<void>
  retire?: () => Promise<void>
}) {
  const cleanup = lifecycle([
    input.drain,
    input.stopHeap,
    input.dispose,
    input.stopServer,
    ...(input.closeHandler ? [input.closeHandler] : []),
    ...(input.retire ? [input.retire] : []),
  ])
  return () => cleanup.run()
}

/** Only the already used cached handler owns a scope requiring disposal. */
export async function handler() {
  const { HttpApiApp } = await import("@/server/routes/instance/httpapi/server")
  if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
}

const retirement = lifecycle([databases, drainFileLoggers, () => Log.drain()])
let profile: Promise<void> | undefined

/** Called outside AppRuntime after admitted RPC calls and response bodies have settled. */
export function retire(): Promise<void> {
  return (profile ??= retirement.run().then(closeProcessProfile))
}

export function listener<A extends { quiesce(): Promise<void>; stop(forced?: boolean): Promise<void> }>() {
  const owners = new Set<A>()
  const pending = new Set<Promise<A>>()
  let current: A | undefined
  let queue = Promise.resolve()
  let closed: Promise<void> | undefined
  let closing: Promise<void> | undefined
  const failures = (results: readonly PromiseSettledResult<unknown>[]) => {
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, "TUI worker listener retirement failed")
  }
  const quiesce = () => {
    if (closed) return closed
    const result = Promise.withResolvers<void>()
    closed = result.promise
    const fences = [...owners].map((owner) => {
      try {
        return owner.quiesce()
      } catch (err) {
        return Promise.reject(err)
      }
    })
    void Promise.allSettled([...fences, ...pending]).then((results) => {
      try {
        failures(results)
        result.resolve()
      } catch (err) {
        result.reject(err)
      }
    })
    return closed
  }
  return {
    quiesce,
    open(start: () => Promise<A>): Promise<A> {
      if (closed) return Promise.reject(new Error("TUI worker listener admission is closing"))
      const task = queue.then(async () => {
        if (closed) throw new Error("TUI worker listener admission is closing")
        if (current) {
          await current.stop(true)
          owners.delete(current)
          current = undefined
        }
        if (closed) throw new Error("TUI worker listener admission is closing")
        const owner = await start()
        owners.add(owner)
        if (closed) {
          // A previously admitted listen may bind before its Promise returns. Join its exact scope before teardown.
          await lifecycle([() => owner.quiesce(), () => owner.stop(true)]).run()
          owners.delete(owner)
          throw new Error("TUI worker listener completed after admission closed")
        }
        current = owner
        return owner
      })
      pending.add(task)
      queue = task.then(
        () => undefined,
        () => undefined,
      )
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      )
      return task
    },
    stop(): Promise<void> {
      const fence = quiesce()
      return (closing ??= lifecycle([
        () => fence,
        async () => {
          failures(await Promise.allSettled([...owners].map((owner) => Promise.resolve().then(() => owner.stop(true)))))
          owners.clear()
          current = undefined
        },
      ]).run())
    },
  }
}
