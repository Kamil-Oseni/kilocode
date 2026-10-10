import { Cause, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect"
import type { Info } from "../background-job"
import type { Interface } from "./background-outcome"
import * as Log from "../util/log"

const producer: unique symbol = Symbol("Original background producer")
const generation: unique symbol = Symbol("Original background generation")
export type Producer = Readonly<{ [producer]: true }>
export type Generation = Readonly<{ [generation]: true }>
type Original = {
  filled: Deferred.Deferred<Effect.Effect<void, unknown>>
  join: Effect.Effect<void, unknown>
  request: Effect.Effect<Effect.Effect<boolean>, unknown>
  attached: boolean
  fiber?: object
}
type Retained = {
  sink: Interface
  writer: object
  originals: readonly Original[]
  retirement: Deferred.Deferred<Exit.Exit<void>>
  lock: Semaphore.Semaphore
  started?: string
  failed?: boolean
}
const producers = new WeakMap<Producer, Original>()
const generations = new WeakMap<Generation, Retained>()
const log = Log.create({ service: "background-outcome" })

/** Reserve the original fiber slot before fork; no serialized identity can fill it. */
export const slot = Effect.fn("BackgroundObserver.slot")(function* (
  join: Effect.Effect<void, unknown>,
  request: Effect.Effect<Effect.Effect<boolean>, unknown>,
) {
  const value: Producer = Object.freeze({ [producer]: true })
  producers.set(value, { filled: yield* Deferred.make<Effect.Effect<void, unknown>>(), join, request, attached: false })
  return value
})

export const attach = Effect.fn("BackgroundObserver.attach")(function* <A, E>(
  value: Producer,
  fiber: Fiber.Fiber<A, E>,
) {
  const original = producers.get(value)
  if (!original || original.attached) throw new Error("Background original producer slot is foreign or filled")
  original.attached = true
  original.fiber = fiber
  yield* Deferred.succeed(
    original.filled,
    Fiber.await(fiber).pipe(
      Effect.flatMap((exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause))),
    ),
  )
})

/** Only complete actual Task origins are journaled. Ordinary unowned jobs retain
 * their existing behavior and cannot become cold completion authority. */
export const enroll = Effect.fn("BackgroundObserver.enroll")(function* (
  sink: Interface | undefined,
  info: Info,
  values: readonly Producer[],
  retirement: Deferred.Deferred<Exit.Exit<void>>,
) {
  if (
    !sink ||
    !info.revision ||
    info.status !== "running" ||
    !info.origins?.length ||
    info.origins.some(
      (origin) =>
        !origin?.sessionID || !origin.messageID || !origin.callID || !origin.childSessionID || !origin.childMessageID,
    )
  )
    return undefined
  if (!values.length || values.length > 1024 || new Set(values).size !== values.length)
    throw new Error("Background original producer roster is invalid")
  const originals = values.map((value) => {
    const original = producers.get(value)
    if (!original) throw new Error("Background original producer is foreign")
    return original
  })
  if (originals.length !== info.origins.length) throw new Error("Background original producer correspondence differs")
  const writer = yield* sink.admit(structuredClone(info))
  const value: Generation = Object.freeze({ [generation]: true })
  generations.set(value, {
    sink,
    writer,
    originals: Object.freeze(originals),
    retirement,
    lock: yield* Semaphore.make(1),
  })
  return value
})

/** Original fiber failures remain observed by observe(); they must not prevent
 * closing their containing scope. Run this in the external root scope only. */
export const retire = (value: Generation | undefined, close: Effect.Effect<void, unknown>) =>
  Effect.withFiber((caller) =>
    Effect.gen(function* () {
      if (value === undefined) return yield* close
      const retained = generations.get(value)
      if (!retained) throw new Error("Background original generation is foreign")
      if (retained.originals.some((original) => original.fiber === caller))
        throw new Error("Background producer cannot retire its own scope")
      // Select all cooperative stops before awaiting any producer. Never interrupt
      // the outer fiber whose actual exit the journal must independently observe.
      const requests = yield* Effect.forEach(retained.originals, (original) => Effect.exit(original.request), {
        concurrency: "unbounded",
      })
      const waits = yield* Effect.forEach(
        requests,
        (exit) => Effect.exit(Exit.isSuccess(exit) ? exit.value : Effect.failCause(exit.cause)),
        { concurrency: "unbounded" },
      )
      if (waits.some(Exit.isFailure)) retained.failed = true
      yield* Effect.forEach(
        retained.originals,
        (original) =>
          Effect.gen(function* () {
            const fiber = yield* Deferred.await(original.filled)
            return yield* Effect.exit(fiber)
          }),
        { concurrency: "unbounded" },
      )
      yield* close
    }),
  )

/** The observer lives in the containing root scope, never inside a fiber it joins.
 * Terminal done and self-ensuring signals are insufficient to publish joined. */
export const observe = Effect.fn("BackgroundObserver.observe")(function* (
  value: Generation | undefined,
  info: Info,
  scope: Scope.Scope,
) {
  if (!value) return
  const retained = generations.get(value)
  if (!retained) throw new Error("Background original generation is foreign")
  const terminal = structuredClone(info)
  return yield* Semaphore.withPermit(
    retained.lock,
    Effect.gen(function* () {
      const text = JSON.stringify(terminal)
      if (retained.started !== undefined) {
        if (retained.started !== text) throw new Error("Background observed terminal changed")
        return
      }
      yield* retained.sink.observe(retained.writer, terminal)
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(
            Effect.gen(function* () {
              const exits = yield* Effect.forEach(
                retained.originals,
                (original) =>
                  Effect.gen(function* () {
                    const fiber = yield* Deferred.await(original.filled)
                    const exited = yield* Effect.exit(fiber)
                    const joined = yield* Effect.exit(original.join)
                    return { exited, joined }
                  }),
                { concurrency: "unbounded" },
              )
              const retirement = yield* Deferred.await(retained.retirement)
              if (
                retained.failed ||
                !Exit.isSuccess(retirement) ||
                exits.some((pair) => {
                  if (Exit.isFailure(pair.exited)) return true
                  if (Exit.isSuccess(pair.joined)) return false
                  const err = Cause.squash(pair.joined.cause)
                  const message = err instanceof Error ? err.message : String(err)
                  // settle() retains exactly this original worker error; original
                  // outer Fiber and retirement must still join successfully.
                  return terminal.status !== "error" || terminal.error !== message
                })
              )
                throw new Error("Background original retirement was not successful")
              yield* retained.sink.joined(retained.writer, terminal)
            }).pipe(
              Effect.catchCause(() =>
                Effect.sync(() => log.error("Original background outcome remains debt", { stage: "join" })),
              ),
            ),
            scope,
            { startImmediately: true },
          )
          retained.started = text
          return fiber
        }),
      )
    }),
  ).pipe(
    Effect.catchCause(() =>
      Effect.sync(() => log.error("Original background outcome remains debt", { stage: "terminal" })),
    ),
  )
})
