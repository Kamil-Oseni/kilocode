import path from "node:path"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import { acquireProfileRoot, resolveProfileRoot } from "./profile-maintenance"
import { RuntimeRegistry } from "./runtime-registry"
import { Flock } from "../util/flock"

type Ticket = { failed: boolean; entered: boolean; observed: boolean }

/** One terminal process participant for actual catalog operations, across compiled Core graphs. */
function owner() {
  const active = new Set<Ticket>()
  const failures: unknown[] = []
  const timers = new Set<Fiber.Fiber<unknown, unknown>>()
  let closed = false
  let pending: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const finish = () => {
    if (!pending || active.size || timers.size) return
    if (failures.length) pending.reject(new AggregateError(failures, "Catalog retirement was not confirmed"))
    else pending.resolve()
  }
  const reserve = () => {
    RuntimeRegistry.check()
    if (closed) throw new Error("Catalog admission is terminal")
    const ticket = { failed: false, entered: false, observed: false }
    active.add(ticket)
    return ticket
  }
  const record = <A, E>(ticket: Ticket, exit: Exit.Exit<A, E>) => {
    if (ticket.observed) return
    ticket.observed = true
    // Cancelling a reserved fork before its first instruction performs no catalog work.
    // Once entered, retain the actual body/resource exit before logging recovery.
    if (!ticket.entered && Exit.isFailure(exit) && exit.cause.reasons.every(Cause.isInterruptReason)) return
    if (Exit.isFailure(exit) && !ticket.failed) {
      ticket.failed = true
      failures.push(exit.cause)
    }
  }
  const release = <A, E>(ticket: Ticket, exit: Exit.Exit<A, E>) => {
    record(ticket, exit)
    active.delete(ticket)
    finish()
  }
  const execute = <A, E, R>(file: string, body: (file: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => resolveProfileRoot({ kind: "json", path: file }))
      return yield* Effect.acquireUseRelease(
        Effect.promise((signal) => acquireProfileRoot(root, { signal })),
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Flock.effect(`models-dev:${root.id}`, {
                dir: path.join(path.dirname(root.path), ".raya-catalog-locks"),
                recover: "dead",
                timeoutMs: 5_000,
              })
              return yield* body(root.path)
            }),
          ),
        (lease) => Effect.promise(() => lease.release()),
      )
    })
  const retire = () => {
    closed = true
    pending ??= Promise.withResolvers<void>()
    for (const timer of timers) timer.interruptUnsafe()
    finish()
    return pending.promise
  }
  RuntimeRegistry.register(retire)
  const participant = {
    run<A, E, R>(file: string, body: (file: string) => Effect.Effect<A, E, R>) {
      return Effect.uninterruptible(
        Effect.suspend(() => {
          const ticket = reserve()
          ticket.entered = true
          return execute(file, body).pipe(Effect.onExit((exit) => Effect.sync(() => release(ticket, exit))))
        }),
      )
    },
    /** Retain unexpected native read/stat failures before a caller's existing recovery policy. */
    observe<A, E, R>(body: Effect.Effect<A, E, R>, expected: (error: E) => boolean) {
      return body.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (
              Exit.isFailure(exit) &&
              exit.cause.reasons.some((reason) => !Cause.isFailReason(reason) || !expected(reason.error))
            )
              failures.push(exit.cause)
          }),
        ),
      )
    },
    fork<A, E, R>(file: string, body: (file: string) => Effect.Effect<A, E, R>, scope: Scope.Scope) {
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const ticket = yield* Effect.sync(reserve)
          const effect = Effect.suspend(() => {
            if (scope.state._tag === "Closed") return Effect.interrupt
            ticket.entered = true
            return execute(file, body)
          }).pipe(
            Effect.onExit((exit) => Effect.sync(() => record(ticket, exit))),
            Effect.ignore,
            Effect.uninterruptible,
          )
          const fiber = yield* effect.pipe(
            Effect.forkIn(scope, { startImmediately: true }),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit)) release(ticket, exit)
              }),
            ),
          )
          fiber.addObserver((exit) => release(ticket, exit))
          return fiber
        }),
      )
    },
    schedule<A, E, R>(file: string, body: (file: string) => Effect.Effect<A, E, R>, scope: Scope.Scope) {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const first = yield* participant.fork(file, body, scope)
          const timer = yield* restore(
            Effect.gen(function* () {
              yield* Fiber.await(first)
              while (!closed) {
                yield* Effect.sleep("60 minutes")
                const fiber = yield* participant.fork(file, body, scope)
                yield* Fiber.await(fiber)
              }
            }),
          ).pipe(Effect.forkIn(scope, { startImmediately: true }))
          timers.add(timer)
          timer.addObserver(() => {
            timers.delete(timer)
            finish()
          })
          if (closed) timer.interruptUnsafe()
        }),
      )
    },
    retire,
    snapshot: () => ({
      closed,
      active: active.size,
      timers: timers.size,
      failures: failures.length,
      portableCaptureAuthorized: false,
    }),
  }
  return participant
}

export const catalog = owner()
