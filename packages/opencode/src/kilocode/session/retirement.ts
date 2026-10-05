import { Cause, Context, Deferred, Effect, Exit, Fiber, type Scope } from "effect"

const brand: unique symbol = Symbol("Session producer parent")
const Current = Context.Reference<{ owner: object; parent: SessionRetirement.Parent } | undefined>(
  "@raya/SessionProducer",
  { defaultValue: () => undefined },
)

/** Process-local producer ownership; lifecycle ordering must explicitly fence and drain it. */
export namespace SessionRetirement {
  export type Parent = { readonly [brand]: true }

  export function make() {
    const owner = Object.freeze({})
    type State = { open: boolean; cancellations: Set<number>; observed: Set<unknown> }
    const parents = new WeakMap<Parent, State>()
    const fibers = new WeakMap<Fiber.Fiber<unknown, unknown>, Parent>()
    const running = new Map<Fiber.Fiber<unknown, unknown>, Set<State>>()
    const pending = new Set<Deferred.Deferred<void>>()
    const failures: { error: unknown; state: State }[] = []
    const outcomes = new Map<string, Map<string, { error: unknown; state: State }>>()
    let closing = false
    let stopping = false
    let accepted = 0
    let settled = 0
    let cancelled = 0

    const reserve = (parent?: Parent) => {
      if (parent && !parents.get(parent)?.open) throw new Error("Session producer parent is unavailable")
      if (!parent && closing) throw new Error("Session producer intake is closed")
      const token = Object.freeze({ [brand]: true as const })
      const state: State = { open: true, cancellations: new Set(), observed: new Set() }
      const done = Deferred.makeUnsafe<void>()
      parents.set(token, state)
      pending.add(done)
      accepted += 1
      return { token, state, done }
    }
    const select = (parent?: Parent) =>
      Effect.gen(function* () {
        const current = yield* Current
        if (current && current.owner !== owner)
          return yield* Effect.die(new Error("Session producer context is foreign"))
        return parent ?? current?.parent
      })
    const retain = (state: State, exit: Exit.Exit<unknown, unknown>) => {
      if (Exit.isSuccess(exit) || state.observed.has(exit.cause)) return
      state.observed.add(exit.cause)
      const known =
        Cause.hasInterruptsOnly(exit.cause) &&
        exit.cause.reasons.every(
          (reason) =>
            Cause.isInterruptReason(reason) && reason.fiberId !== undefined && state.cancellations.has(reason.fiberId),
        )
      if (known) cancelled += 1
      if (!known) failures.push({ error: Cause.squash(exit.cause), state })
    }
    const work = <A, E, R>(ticket: ReturnType<typeof reserve>, body: (parent: Parent) => Effect.Effect<A, E, R>) =>
      Effect.withFiber((fiber) =>
        Effect.suspend(() => {
          const states = running.get(fiber) ?? new Set<State>()
          states.add(ticket.state)
          running.set(fiber, states)
          return Effect.suspend(() => {
            // A reserved child may first enter after stop took its live-fiber snapshot.
            if (stopping) {
              ticket.state.cancellations.add(fiber.id)
              return Effect.interrupt
            }
            return body(ticket.token)
          }).pipe(
            Effect.provideService(Current, { owner, parent: ticket.token }),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                // onExit observes the true body Exit, including all body finalizers.
                ticket.state.open = false
                retain(ticket.state, exit)
                states.delete(ticket.state)
                if (!states.size) running.delete(fiber)
                settled += 1
                pending.delete(ticket.done)
                Deferred.doneUnsafe(ticket.done, Effect.void)
              }),
            ),
          )
        }),
      )
    const run = <A, E, R>(body: (parent: Parent) => Effect.Effect<A, E, R>, parent?: Parent) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prior = yield* select(parent)
          const ticket = yield* Effect.sync(() => reserve(prior))
          return yield* work(ticket, (token) => restore(body(token)))
        }),
      )
    const fork = <A, E, R>(body: (parent: Parent) => Effect.Effect<A, E, R>, parent?: Parent) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prior = yield* select(parent)
          // Ownership exists before the child can start, even when it runs immediately.
          const ticket = yield* Effect.sync(() => reserve(prior))
          const fiber = yield* Effect.forkDetach(
            work(ticket, (token) => restore(body(token))),
            {
              startImmediately: true,
            },
          )
          fibers.set(fiber, ticket.token)
          return fiber
        }),
      )
    const tool = <A, E, R>(session: string, call: string, body: Effect.Effect<A, E, R>) =>
      run((token) =>
        body.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isSuccess(exit) || exit.cause.reasons.length !== 1) return
              const reason = exit.cause.reasons[0]
              if (!Cause.isFailReason(reason) && !Cause.isDieReason(reason)) return
              const error = Cause.squash(exit.cause)
              if (error instanceof AggregateError) return
              const calls = outcomes.get(session) ?? new Map()
              outcomes.set(session, calls)
              // Reused call identities never replace an earlier unsettled outcome.
              if (!calls.has(call)) calls.set(call, { error, state: parents.get(token)! })
            }),
          ),
        ),
      )
    const completed = (session: string, call: string, error: unknown) => {
      const calls = outcomes.get(session)
      const original = calls?.get(call)
      if (!original || original.error !== error || original.state.open) return false
      for (let index = failures.length - 1; index >= 0; index--)
        if (failures[index].state === original.state && failures[index].error === error) failures.splice(index, 1)
      calls!.delete(call)
      if (!calls!.size) outcomes.delete(session)
      return true
    }
    const child = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prior = yield* select()
          const ticket = yield* Effect.sync(() => reserve(prior))
          const fiber = yield* Effect.forkChild(work(ticket, () => restore(body)))
          fibers.set(fiber, ticket.token)
          return fiber
        }),
      )
    const cancel = <A, E>(fiber: Fiber.Fiber<A, E>) =>
      Effect.withFiber((caller) =>
        Effect.sync(() => {
          const token = fibers.get(fiber)
          const state = token && parents.get(token)
          if (!state) throw new Error("Session producer fiber is foreign")
          if (!state.open) return
          state.cancellations.add(caller.id)
          fiber.interruptUnsafe(caller.id)
        }),
      )
    const interrupt = <A, E>(fiber: Fiber.Fiber<A, E>) =>
      Effect.withFiber((caller) =>
        Effect.uninterruptible(
          Effect.sync(() => {
            // Only the selected native Effect fiber's live tickets are authorized.
            for (const state of running.get(fiber) ?? []) state.cancellations.add(caller.id)
          }).pipe(Effect.andThen(Fiber.interrupt(fiber))),
        ),
      )
    const scoped = <A, E, R, B, E2, R2>(
      body: Effect.Effect<A, E, R>,
      scope: Scope.Scope,
      fallback: (cause: Cause.Cause<E>) => Effect.Effect<B, E2, R2>,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prior = yield* select()
          const ticket = yield* Effect.sync(() => reserve(prior))
          const fiber = yield* Effect.forkIn(
            work(ticket, () =>
              restore(body).pipe(
                Effect.onExit((exit) => Effect.sync(() => retain(ticket.state, exit))),
                Effect.catchCause(fallback),
              ),
            ),
            scope,
          )
          fibers.set(fiber, ticket.token)
          return fiber
        }),
      )
    const fence = () => {
      closing = true
    }
    const current = Effect.gen(function* () {
      const context = yield* Current
      return context?.owner === owner && parents.get(context.parent)?.open ? context.parent : undefined
    })
    const drain = Effect.suspend(() => {
      fence()
      return Effect.uninterruptible(
        Effect.gen(function* () {
          while (pending.size) for (const done of pending) yield* Deferred.await(done)
          if (failures.length === 1) yield* Effect.die(failures[0].error)
          if (failures.length > 1)
            yield* Effect.die(
              new AggregateError(
                failures.map((item) => item.error),
                "Session producer retirement failed",
              ),
            )
        }),
      )
    })
    const stop = Effect.withFiber((caller) =>
      Effect.suspend(() => {
        if (running.has(caller)) return Effect.die(new Error("Session producer cannot join its own stop"))
        fence()
        stopping = true
        return Effect.uninterruptible(
          Effect.forEach([...running.keys()], interrupt, { concurrency: "unbounded", discard: true }).pipe(
            Effect.andThen(drain),
          ),
        )
      }),
    )
    return {
      run,
      tool,
      completed,
      fork,
      child,
      cancel,
      interrupt,
      scoped,
      current,
      accepted: Effect.map(current, (parent) => parent !== undefined),
      fence,
      stop,
      drain,
      snapshot: () => ({ closing, active: pending.size, accepted, settled, failures: failures.length, cancelled }),
    }
  }

  let live: ReturnType<typeof make> | undefined
  const port = () => (live ??= make())
  export const run = <A, E, R>(body: (parent: Parent) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() => port().run(body))
  export const fork = <A, E, R>(body: (parent: Parent) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() => port().fork(body))
  export const cancel = <A, E>(fiber: Fiber.Fiber<A, E>) => Effect.suspend(() => port().cancel(fiber))
  export const interrupt = <A, E>(fiber: Fiber.Fiber<A, E>) =>
    Effect.suspend(() => (live ? live.interrupt(fiber) : Fiber.interrupt(fiber)))
  export const scoped = <A, E, R, B, E2, R2>(
    body: Effect.Effect<A, E, R>,
    scope: Scope.Scope,
    fallback: (cause: Cause.Cause<E>) => Effect.Effect<B, E2, R2>,
  ) => Effect.suspend(() => port().scoped(body, scope, fallback))
  export const entry = <A, E, R>(body: Effect.Effect<A, E, R>) => run(() => body)
  export const tool =
    <A, E, R>(session: string, call: string) =>
    (body: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => port().tool(session, call, body))
  export const completed = (session: string, call: string, error: unknown) =>
    live?.completed(session, call, error) ?? false
  // Generic Runner callers without a producer context retain their original lifetime and stay lazy.
  export const forkIn = <A, E, R>(body: Effect.Effect<A, E, R>, scope: Scope.Scope) =>
    Effect.gen(function* () {
      const context = yield* Current
      return yield* context ? port().scoped(body, scope, Effect.failCause) : Effect.forkIn(body, scope)
    })
  export const child = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Current
      return yield* context ? port().child(body) : Effect.forkChild(body)
    })
  export const fence = () => port().fence()
  export const stop = Effect.suspend(() => port().stop)
  export const drain = Effect.suspend(() => port().drain)
  export const current = Effect.suspend(() => live?.current ?? Effect.succeed(undefined))
  export const accepted = Effect.map(current, (parent) => parent !== undefined)
  export const snapshot = () => ({ installed: !!live, ...live?.snapshot() })
}
