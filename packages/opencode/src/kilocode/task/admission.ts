import { Cause, Context, Effect, Exit, Fiber, type Scope } from "effect"

type Ticket = {
  released: boolean
  stopping: boolean
  requested: boolean
  stop?: number
  cancellations: Set<number>
  fiber?: Fiber.Fiber<unknown, unknown>
}
const Current = Context.Reference<{ owner: object; ticket: Ticket } | undefined>("@raya/SchedulerTicket", {
  defaultValue: () => undefined,
})

/** Process-local scheduler intake. No service, profile or runtime is realized here. */
export function admission() {
  let closed = false
  let active = 0
  let pending: Promise<void> | undefined
  let settled: ReturnType<typeof Promise.withResolvers<void>> | undefined
  const failures: unknown[] = []
  const owner = {}
  const tickets = new Set<Ticket>()
  const running = new Map<Fiber.Fiber<unknown, unknown>, Set<Ticket>>()
  let stopping = false
  const known = <E>(ticket: Ticket, cause: Cause.Cause<E>) =>
    ticket.requested &&
    Cause.hasInterruptsOnly(cause) &&
    cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) && reason.fiberId !== undefined && ticket.cancellations.has(reason.fiberId),
    )
  const work = <A, E, R>(ticket: Ticket, body: Effect.Effect<A, E, R>) =>
    Effect.withFiber((fiber) => {
      if (ticket.fiber && ticket.fiber !== fiber) {
        const prior = running.get(ticket.fiber)
        prior?.delete(ticket)
        if (!prior?.size) running.delete(ticket.fiber)
      }
      ticket.fiber = fiber
      const states = running.get(fiber) ?? new Set<Ticket>()
      states.add(ticket)
      running.set(fiber, states)
      if (!ticket.stopping) return Effect.provideService(body, Current, { owner, ticket })
      // A reserved body must still settle its original ticket, but cannot start late work.
      if (ticket.stop === undefined) return Effect.die(new Error("Reserved scheduler cancellation has no stop owner"))
      ticket.cancellations.add(ticket.stop)
      ticket.cancellations.add(fiber.id)
      ticket.requested = true
      fiber.interruptUnsafe(ticket.stop)
      return Effect.interrupt
    })
  const finish = () => {
    if (!closed || active || !settled) return
    if (failures.length) {
      settled.reject(new AggregateError(failures, "Scheduler work could not be confirmed settled"))
      return
    }
    settled.resolve()
  }
  const reserve = <E>(refuse: () => E) =>
    Effect.suspend(() => {
      if (closed) return Effect.fail(refuse())
      active += 1
      const ticket: Ticket = { released: false, stopping, requested: false, cancellations: new Set() }
      tickets.add(ticket)
      return Effect.succeed(ticket)
    })
  const release = <A, E>(ticket: Ticket, exit: Exit.Exit<A, E>) => {
    if (ticket.released) return
    ticket.released = true
    tickets.delete(ticket)
    if (ticket.fiber) {
      const states = running.get(ticket.fiber)
      states?.delete(ticket)
      if (!states?.size) running.delete(ticket.fiber)
    }
    if (
      Exit.isFailure(exit) &&
      !known(ticket, exit.cause) &&
      (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
    )
      failures.push(Cause.squash(exit.cause))
    active -= 1
    finish()
  }
  return {
    track<A, E, R, F>(body: Effect.Effect<A, E, R>, refuse: () => F) {
      return Effect.acquireUseRelease(
        reserve(refuse),
        (ticket) => work(ticket, body),
        (ticket, exit) => Effect.sync(() => release(ticket, exit)),
      )
    },
    /** Reserve before asynchronous execution ownership acquisition, then detach this exact body. */
    fork<A, E, R, P, S, F>(prepare: Effect.Effect<Effect.Effect<A, E, R>, P, S>, refuse: () => F) {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ticket = yield* reserve(refuse)
          const prepared = yield* work(ticket, restore(prepare)).pipe(Effect.exit)
          if (Exit.isFailure(prepared)) {
            release(ticket, prepared)
            return yield* Effect.failCause(prepared.cause)
          }
          // A protected startup may prepare a resumed turn. That protection must not
          // become inherited authority to make its detached model body uncancellable.
          const fiber = yield* work(ticket, prepared.value).pipe(Effect.interruptible, Effect.forkDetach)
          fiber.addObserver((exit) => release(ticket, exit))
          return fiber
        }),
      )
    },
    /** Reserve before starting an instance-scoped body; even immediate scope cancellation releases its ticket. */
    scoped<A, E, R, F>(body: Effect.Effect<A, E, R>, scope: Scope.Scope, refuse: () => F) {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ticket = yield* reserve(refuse)
          // forkIn starts an immediate child before attaching its scope finalizer.
          // Check the public scope state in that child's first instruction.
          const fiber = yield* work(
            ticket,
            Effect.suspend(() => (scope.state._tag === "Closed" ? Effect.interrupt : restore(body))),
          ).pipe(Effect.forkIn(scope, { startImmediately: true }))
          fiber.addObserver((exit) => release(ticket, exit))
          return fiber
        }),
      )
    },
    /** Record the actual dispatch exit before a caller converts it into a logged success. */
    observe<A, E, R>(body: Effect.Effect<A, E, R>, accept?: (err: E) => boolean) {
      return Effect.withFiber((fiber) => {
        const inherited = fiber.getRef(Current)
        const ticket = inherited?.owner === owner ? inherited.ticket : undefined
        return body.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (
                Exit.isFailure(exit) &&
                !(ticket && !ticket.released && tickets.has(ticket) && known(ticket, exit.cause)) &&
                !(!inherited && [...(running.get(fiber) ?? [])].some((ticket) => known(ticket, exit.cause))) &&
                exit.cause.reasons.some((reason) => !Cause.isFailReason(reason) || !accept?.(reason.error))
              )
                failures.push(Cause.squash(exit.cause))
            }),
          ),
        )
      })
    },
    /** Callback admission reserves in the caller's JS turn, before the bridge schedules an Effect. */
    dispatch<A, E, R>(
      body: Effect.Effect<A, E, R>,
      scope: Scope.Scope,
      fork: (effect: Effect.Effect<Fiber.Fiber<A, E>, never, R>) => Fiber.Fiber<Fiber.Fiber<A, E>, never>,
    ) {
      if (closed) return false
      active += 1
      const ticket: Ticket = { released: false, stopping, requested: false, cancellations: new Set() }
      tickets.add(ticket)
      try {
        const scheduled = fork(work(ticket, body).pipe(Effect.forkIn(scope), Effect.uninterruptible))
        scheduled.addObserver((exit) => {
          if (Exit.isFailure(exit)) {
            release(ticket, exit)
            return
          }
          exit.value.addObserver((result) => release(ticket, result))
        })
      } catch (err) {
        ticket.released = true
        tickets.delete(ticket)
        active -= 1
        failures.push(err)
        finish()
        throw err
      }
      return true
    },
    /** Authorize only this stop caller on the exact accepted original fibers, then join their original settlement. */
    stop: Effect.withFiber((caller) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          const current = caller.getRef(Current)
          if (
            running.has(caller) ||
            (current?.owner === owner && !current.ticket.released && tickets.has(current.ticket))
          )
            return Effect.die(new Error("Scheduler producer cannot join its own stop"))
          closed = true
          stopping = true
          for (const ticket of tickets) {
            ticket.stopping = true
            ticket.stop = caller.id
          }
          // Request every original before waiting for any: inner AppRuntime producers have independent ownership.
          for (const [fiber, states] of running) {
            for (const ticket of states) {
              ticket.requested = true
              ticket.cancellations.add(caller.id)
              // Effect interrupts an original's race/scoped children using that original's ID.
              // Only this live ticket whose original is actually requested may accept that propagation.
              ticket.cancellations.add(fiber.id)
            }
            fiber.interruptUnsafe(caller.id)
          }
          if (!pending) {
            settled = Promise.withResolvers<void>()
            pending = settled.promise
          }
          finish()
          return Effect.promise(() => pending!)
        }),
      ),
    ),
    snapshot() {
      return {
        closed,
        active,
        failures: failures.length,
        processLocal: true as const,
        portableCaptureAuthorized: false,
      }
    },
    quiesce(this: void): Promise<void> {
      closed = true
      if (pending) return pending
      settled = Promise.withResolvers<void>()
      pending = settled.promise
      finish()
      return pending
    },
  }
}

export const scheduler = admission()
export const schedulerQuiesce = scheduler.quiesce
