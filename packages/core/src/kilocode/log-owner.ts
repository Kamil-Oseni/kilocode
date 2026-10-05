import type { Writable } from "node:stream"

/** Final legacy logger phase, deliberately separate from runtime retirement. */
export function createOwner() {
  const pending = new Set<Promise<unknown>>()
  const failures = new Set<unknown>()
  const streams = new Map<Writable, { closed: Promise<void>; end?: Promise<void> }>()
  const permits = new Set<symbol>()
  let terminal = false
  let closing: Promise<void> | undefined
  let queue = Promise.resolve()
  const fail = (err: unknown) => {
    failures.add(err)
  }
  const track = <A>(task: Promise<A>) => {
    pending.add(task)
    void task.then(
      () => pending.delete(task),
      (err) => {
        fail(err)
        pending.delete(task)
      },
    )
    return task
  }
  const end = (stream: Writable) => {
    const state = streams.get(stream)
    if (!state) throw new Error("Unowned log stream")
    if (state.end) return state.end
    state.end = state.closed
    if (!stream.destroyed) {
      try {
        stream.end((err?: Error | null) => {
          if (err) fail(err)
        })
      } catch (err) {
        fail(err)
        stream.destroy(err instanceof Error ? err : new Error(String(err)))
      }
    }
    return state.end
  }
  return {
    fail,
    end,
    run<A>(body: (permit: symbol) => Promise<A>): Promise<A> {
      if (terminal) return Promise.reject(new Error("Legacy logger admission is closed"))
      const task = track(
        queue.then(async () => {
          const permit = Symbol()
          permits.add(permit)
          try {
            return await body(permit)
          } finally {
            permits.delete(permit)
          }
        }),
      )
      queue = task.then(
        () => undefined,
        () => undefined,
      )
      return task
    },
    own(stream: Writable, permit?: symbol, native?: { close(): void }) {
      if (streams.has(stream)) return
      if (terminal && (!permit || !permits.has(permit))) throw new Error("Legacy logger stream admission is closed")
      const result = Promise.withResolvers<void>()
      streams.set(stream, { closed: result.promise })
      stream.on("error", fail)
      // A warning may indicate uncertain rotation/history cleanup even if writes succeeded.
      stream.on("warning", fail)
      stream.once("close", () => {
        if (!stream.writableFinished) fail(new Error("Log stream closed before finishing"))
        try {
          native?.close()
        } catch (err) {
          fail(err)
        }
        result.resolve()
      })
      if (stream.closed) {
        try {
          native?.close()
        } catch (err) {
          fail(err)
        }
        result.resolve()
      }
    },
    write(stream: Writable, msg: string, fallback: (msg: string) => number): number {
      if (!streams.has(stream)) throw new Error("Unowned log stream")
      if (terminal || stream.destroyed || stream.writableEnded) return fallback(msg)
      const result = Promise.withResolvers<void>()
      void track(result.promise)
      try {
        stream.write(msg, (err?: Error | null) => {
          if (err) {
            result.reject(err)
            return
          }
          result.resolve()
        })
      } catch (err) {
        result.reject(err)
        fallback(msg)
      }
      return msg.length
    },
    drain(): Promise<void> {
      if (closing) return closing
      terminal = true
      const result = Promise.withResolvers<void>()
      closing = result.promise
      void (async () => {
        // Init can attach a stream after admission closes; join it before snapshotting.
        while (pending.size) await Promise.allSettled(pending)
        await Promise.allSettled([...streams.keys()].map(end))
        if (failures.size) throw new AggregateError([...failures], "Legacy logger retirement failed")
      })().then(result.resolve, result.reject)
      return closing
    },
  }
}

export const LogOwner = createOwner()
