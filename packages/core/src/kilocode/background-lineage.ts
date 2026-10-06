import { Cause, Context, Deferred, Effect, Exit, Scope, Semaphore } from "effect"
import type { Control } from "./background-invocation"
import type { Origin } from "./background-origin"

export const retirement = (scope: Scope.Closeable) =>
  Effect.gen(function* () {
    return { scope, started: false, done: yield* Deferred.make<Exit.Exit<void>>(), release: Effect.void }
  })

type Retirement = Effect.Success<ReturnType<typeof retirement>>
type Entry = {
  control: Control
  origin?: Origin
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

export const retire = (state: Interface, session: string) =>
  Effect.gen(function* () {
    const selected = yield* Semaphore.withPermit(
      state.lock,
      Effect.gen(function* () {
        const tokens = new Set<object>()
        for (const [token, entry] of state.entries) {
          const origin = entry.origin
          if (
            origin?.sessionID &&
            origin.messageID &&
            origin.callID &&
            origin.childSessionID &&
            origin.childMessageID &&
            (origin.sessionID === session || origin.childSessionID === session)
          )
            tokens.add(token)
          if (entry.parent && tokens.has(entry.parent)) tokens.add(token)
        }
        const controls = []
        const groups = new Map<Retirement, object[]>()
        for (const [token, entry] of state.entries) {
          groups.set(entry.retirement, [...(groups.get(entry.retirement) ?? []), token])
          if (!tokens.has(token)) continue
          entry.closed = true
          controls.push({ ...entry, settled: yield* Deferred.isDone(entry.control.joined) })
        }
        return {
          controls,
          scopes: [...groups].filter(([, group]) => group.every((token) => tokens.has(token))).map(([scope]) => scope),
        }
      }),
    )
    const waits = yield* Effect.forEach(selected.controls, (entry) => entry.control.request)
    const exits = yield* Effect.forEach(
      selected.controls,
      (entry, index) =>
        Effect.gen(function* () {
          yield* waits[index]
          yield* Deferred.await(entry.control.joined)
          if (!entry.settled) yield* entry.control.join.pipe(Effect.orDie)
        }).pipe(Effect.exit),
      { concurrency: "unbounded" },
    )
    const closed = yield* Effect.forEach(selected.scopes, (scope) => close(state, scope).pipe(Effect.exit), {
      concurrency: "unbounded",
    })
    const failures = [...exits, ...closed].flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
    if (failures.length)
      return yield* Effect.failCause(failures.slice(1).reduce((cause, next) => Cause.combine(cause, next), failures[0]))
    return undefined
  }).pipe(Effect.uninterruptible)
