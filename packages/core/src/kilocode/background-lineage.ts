import { Context, Deferred, Effect, Exit, Scope, Semaphore } from "effect"
import type { Control } from "./background-invocation"

export const retirement = (scope: Scope.Closeable) =>
  Effect.gen(function* () {
    return { scope, started: false, done: yield* Deferred.make<Exit.Exit<void>>(), release: Effect.void }
  })

type Retirement = Effect.Success<ReturnType<typeof retirement>>
type Entry = {
  control: Control
  parent?: object
  closed: boolean
  finished: boolean
  scope: Scope.Closeable
  retirement: Retirement
}

export const make = Effect.gen(function* () {
  return { lock: yield* Semaphore.make(1), entries: new Map<object, Entry>() }
})

export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("raya/BackgroundLineage") {}

export const prune = (state: Interface) =>
  Semaphore.withPermit(
    state.lock,
    Effect.gen(function* () {
      const counts = new Map<object, number>()
      for (const entry of state.entries.values()) {
        if (entry.parent) counts.set(entry.parent, (counts.get(entry.parent) ?? 0) + 1)
      }
      const ready = []
      for (const [token, entry] of state.entries) {
        if (
          entry.finished &&
          !counts.get(token) &&
          (yield* Deferred.isDone(entry.control.joined)) &&
          (yield* Deferred.isDone(entry.retirement.done))
        )
          ready.push(token)
      }
      while (ready.length) {
        const token = ready.pop()
        if (!token) continue
        const entry = state.entries.get(token)
        if (!entry) continue
        state.entries.delete(token)
        if (!entry.parent) continue
        const count = (counts.get(entry.parent) ?? 1) - 1
        counts.set(entry.parent, count)
        const parent = state.entries.get(entry.parent)
        if (
          count === 0 &&
          parent?.finished &&
          (yield* Deferred.isDone(parent.control.joined)) &&
          (yield* Deferred.isDone(parent.retirement.done))
        )
          ready.push(entry.parent)
      }
    }),
  )

export const close = (state: Interface, item: Retirement, cause: Exit.Exit<unknown, unknown> = Exit.void) =>
  Effect.gen(function* () {
    const first = yield* Semaphore.withPermit(
      state.lock,
      Effect.sync(() => {
        if (item.started) return false
        item.started = true
        return true
      }),
    )
    if (first) {
      const exit = yield* Effect.exit(Scope.close(item.scope, cause))
      yield* Deferred.succeed(item.done, exit)
      if (Exit.isSuccess(exit)) yield* item.release
      yield* prune(state)
    }
    const exit = yield* Deferred.await(item.done)
    if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
    return undefined
  }).pipe(Effect.uninterruptible)
