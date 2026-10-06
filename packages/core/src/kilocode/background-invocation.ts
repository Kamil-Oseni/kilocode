import { Cause, Context, Deferred, Effect, Exit, Fiber, SynchronizedRef } from "effect"

import { copy, type Origin } from "./background-origin"

export class Owner extends Context.Service<Owner, { token: object; origin?: Origin }>()("raya/BackgroundInvocation") {}

export const validate = (input: { sessionID: string; messageID: string } | undefined) =>
  Effect.gen(function* () {
    const owner = yield* Effect.serviceOption(Owner)
    if (owner._tag === "None") return undefined
    if (
      owner.value.origin?.childSessionID !== input?.sessionID ||
      owner.value.origin?.childMessageID !== input?.messageID ||
      !input
    )
      return yield* Effect.die(new Error("Background invocation does not own the executing prompt"))
    return undefined
  })

class Cancelled extends Error {
  constructor() {
    super("Task invocation cancelled")
  }
}

export const cancelled = (cause: Cause.Cause<unknown>) =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => Cause.isFailReason(reason) && reason.error instanceof Cancelled)

export const make = (origin: Origin | undefined) =>
  Effect.gen(function* () {
    const token = {}
    const joined = yield* Deferred.make<void>()
    const result = yield* Deferred.make<Exit.Exit<string, unknown>>()
    const signal = yield* Deferred.make<void>()
    const done = yield* Deferred.make<void>()
    const state = yield* SynchronizedRef.make({ started: false, finished: false, cancelled: false })
    return {
      token,
      joined,
      join: Deferred.await(joined).pipe(
        Effect.andThen(Deferred.await(result)),
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) && !cancelled(exit.cause) && !Cause.hasInterruptsOnly(exit.cause)
            ? Effect.failCause(exit.cause)
            : Effect.void,
        ),
      ),
      run: (work: Effect.Effect<string, unknown>) =>
        Effect.gen(function* () {
          const admitted = yield* SynchronizedRef.modify(state, (current) =>
            current.cancelled ? [false, current] : [true, { ...current, started: true }],
          )
          if (!admitted) return yield* Effect.fail(new Cancelled())
          const fiber = yield* work.pipe(
            Effect.provideService(Owner, { token, origin: copy(origin) }),
            Effect.forkChild({ startImmediately: true }),
          )
          const exit = yield* Effect.raceFirst(Fiber.await(fiber), Deferred.await(signal).pipe(Effect.as(undefined)))
          if (exit) return yield* Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)
          yield* Fiber.interrupt(fiber)
          const stopped = yield* Fiber.await(fiber)
          if (Exit.isFailure(stopped) && !Cause.hasInterruptsOnly(stopped.cause))
            return yield* Effect.failCause(stopped.cause)
          return yield* Effect.fail(new Cancelled())
        }).pipe(
          Effect.onExit((exit) => Deferred.succeed(result, exit)),
          Effect.ensuring(
            SynchronizedRef.update(state, (current) => ({ ...current, finished: true })).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
            ),
          ),
        ),
      // Selection never waits for cleanup. Its caller releases the registry lock before waiting.
      request: SynchronizedRef.modifyEffect(state, (current) =>
        Effect.gen(function* () {
          if (current.finished) return [Effect.succeed(false), current] as const
          yield* Deferred.succeed(signal, undefined)
          const wait = current.started ? Deferred.await(done).pipe(Effect.as(true)) : Effect.succeed(true)
          return [wait, { ...current, cancelled: true }] as const
        }),
      ),
    }
  })

export type Control = Effect.Success<ReturnType<typeof make>>
