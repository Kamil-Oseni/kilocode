import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect"
import { KiloShutdown } from "../cli/shutdown"
import type { ProfileWriterLive } from "../migration/writer-live"
import { SnapshotAdmission } from "./admission"
import { SessionRetirement } from "../session/retirement"

const Current = Context.Reference<{ owner: object; parent: SnapshotAdmission.Parent } | undefined>(
  "@raya/SnapshotWriter",
  { defaultValue: () => undefined },
)
const Periodic = Context.Reference<object | undefined>("@raya/SnapshotPeriodic", { defaultValue: () => undefined })

/** Lazy process-local coordinator. Production Snapshot hooks and manifest coverage remain separate. */
export namespace SnapshotRuntime {
  export function make(shutdown: Pick<typeof KiloShutdown, "register">) {
    const owner = Object.freeze({})
    const loops = new Set<Fiber.Fiber<unknown, unknown>>()
    const periodic = new WeakSet<Fiber.Fiber<unknown, unknown>>()
    const carriers = new Set<Fiber.Fiber<void, unknown>>()
    const owned = new WeakSet<Fiber.Fiber<unknown, unknown>>()
    const cancellations = new Map<number, Set<number>>()
    const failures: unknown[] = []
    let controller: ReturnType<typeof SnapshotAdmission.make> | undefined
    let admission: ProfileWriterLive.Admission | undefined
    let closing = false
    let paused = false

    const known = <E>(cause: Cause.Cause<E>, id: number) =>
      Cause.hasInterruptsOnly(cause) &&
      cause.reasons.every(
        (reason) =>
          Cause.isInterruptReason(reason) && reason.fiberId !== undefined && cancellations.get(id)?.has(reason.fiberId),
      )
    const observe = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.withFiber((fiber) =>
        body.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && !known(exit.cause, fiber.id)) failures.push(Cause.squash(exit.cause))
            }),
          ),
        ),
      )

    const drain = Effect.suspend(() => {
      closing = true
      controller?.fence()
      return Effect.uninterruptible(
        Effect.gen(function* () {
          const errors: unknown[] = []
          const caller = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
          const periodic = [...loops]
          for (const fiber of periodic) {
            const ids = cancellations.get(fiber.id) ?? new Set<number>()
            ids.add(caller)
            cancellations.set(fiber.id, ids)
            fiber.interruptUnsafe(caller)
          }
          for (const fiber of periodic) yield* Fiber.await(fiber)
          if (controller) {
            const exit = yield* Effect.exit(controller.drain)
            if (Exit.isFailure(exit)) errors.push(Cause.squash(exit.cause))
          }
          for (const fiber of carriers) yield* Fiber.await(fiber)
          errors.push(...failures)
          const unique = [...new Set(errors)]
          if (unique.length === 1) yield* Effect.die(unique[0])
          if (unique.length > 1) yield* Effect.die(new AggregateError(unique, "Snapshot runtime retirement failed"))
        }),
      )
    })
    function close() {
      closing = true
      controller?.fence()
      return drain
    }

    function quiesce() {
      paused = true
      return Effect.uninterruptible(
        Effect.withFiber((caller) =>
          Effect.gen(function* () {
            const pending = [...loops]
            const errors: unknown[] = []
            for (const fiber of pending) {
              const ids = cancellations.get(fiber.id) ?? new Set<number>()
              ids.add(caller.id)
              cancellations.set(fiber.id, ids)
              fiber.interruptUnsafe(caller.id)
            }
            for (const fiber of pending) {
              const exit = yield* Fiber.await(fiber)
              if (Exit.isFailure(exit) && !known(exit.cause, fiber.id)) errors.push(Cause.squash(exit.cause))
            }
            if (errors.length === 1) yield* Effect.die(errors[0])
            if (errors.length > 1) yield* Effect.die(new AggregateError(errors, "Snapshot periodic quiescence failed"))
          }),
        ),
      )
    }

    function install(writer?: ProfileWriterLive.Admission) {
      if (closing) throw new Error("Snapshot runtime installation is closed")
      if (controller && writer && writer !== admission) throw new Error("Snapshot runtime admission differs")
      if (!controller) {
        shutdown.register(() => Effect.runPromise(close()))
        admission = writer
        controller = SnapshotAdmission.make()
      }
      const active = controller
      const parent = Effect.gen(function* () {
        const current = yield* Current
        if (current && current.owner !== owner)
          return yield* Effect.die(new Error("Snapshot runtime parent is foreign"))
        return current?.parent
      })
      const run = <A, E, R>(input: SnapshotAdmission.Input, body: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const token = yield* parent
          const periodic = yield* Periodic
          if ((closing || paused) && periodic === owner && !token) {
            yield* Effect.withFiber((fiber) =>
              Effect.sync(() => {
                const ids = cancellations.get(fiber.id) ?? new Set<number>()
                ids.add(fiber.id)
                cancellations.set(fiber.id, ids)
              }),
            )
            return yield* Effect.interrupt
          }
          if (paused && !token && !(yield* SessionRetirement.accepted))
            return yield* Effect.die(new Error("Snapshot external intake is closed"))
          const work = active.run(
            input,
            (accepted) => Effect.provideService(body, Current, { owner, parent: accepted }),
            token,
          )
          const counted = admission && !token ? admission.run(work) : work
          return yield* periodic === owner ? Effect.uninterruptible(counted) : counted
        })

      const meter = Effect.gen(function* () {
        if (!admission) return undefined
        const ready = Deferred.makeUnsafe<void, unknown>()
        const done = Deferred.makeUnsafe<void>()
        const fiber = yield* Effect.forkDetach(
          admission.run(Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(done)))).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit)) {
                  failures.push(Cause.squash(exit.cause))
                  Deferred.doneUnsafe(ready, Effect.failCause(exit.cause))
                }
              }),
            ),
          ),
          { startImmediately: true },
        )
        carriers.add(fiber)
        fiber.addObserver(() => carriers.delete(fiber))
        yield* Deferred.await(ready)
        return { finish: () => Deferred.doneUnsafe(done, Effect.void) }
      })
      const launch = <A, E, R>(input: SnapshotAdmission.Input, body: Effect.Effect<A, E, R>) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const token = yield* parent
            if (paused && !token && !(yield* SessionRetirement.accepted))
              return yield* Effect.die(new Error("Snapshot external intake is closed"))
            const carrier = token ? undefined : yield* meter
            const exit = yield* Effect.exit(
              active.launch(
                input,
                (accepted) => restore(Effect.provideService(body, Current, { owner, parent: accepted })),
                token,
              ),
            )
            if (Exit.isFailure(exit)) {
              carrier?.finish()
              return yield* Effect.failCause(exit.cause)
            }
            const fiber = exit.value
            owned.add(fiber)
            fiber.addObserver(() => carrier?.finish())
            return fiber
          }),
        )
      const cancel = <A, E>(fiber: Fiber.Fiber<A, E>) =>
        Effect.withFiber((caller) =>
          Effect.suspend(() => {
            if (!owned.has(fiber)) return Effect.die(new Error("Snapshot runtime fiber is foreign"))
            const ids = cancellations.get(fiber.id) ?? new Set<number>()
            ids.add(caller.id)
            cancellations.set(fiber.id, ids)
            return active.cancel(fiber)
          }),
        )
      const cycle = <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (closing || paused) yield* Effect.die(new Error("Snapshot periodic intake is closed"))
            const fiber = yield* Effect.forkDetach(
              observe(
                body.pipe(
                  Effect.provideService(Current, undefined),
                  Effect.provideService(Periodic, owner),
                  Effect.interruptible,
                ),
              ),
              { startImmediately: true },
            )
            periodic.add(fiber)
            loops.add(fiber)
            fiber.addObserver(() => loops.delete(fiber))
            return fiber
          }),
        )
      const stop = <A, E>(fiber: Fiber.Fiber<A, E>) =>
        Effect.uninterruptible(
          Effect.withFiber((caller) =>
            Effect.gen(function* () {
              if (!periodic.has(fiber)) yield* Effect.die(new Error("Snapshot periodic fiber is foreign"))
              if (caller.id === fiber.id) yield* Effect.die(new Error("Snapshot periodic fiber cannot stop itself"))
              const ids = cancellations.get(fiber.id) ?? new Set<number>()
              ids.add(caller.id)
              cancellations.set(fiber.id, ids)
              fiber.interruptUnsafe(caller.id)
              const exit = yield* Fiber.await(fiber)
              if (Exit.isFailure(exit) && !known(exit.cause, fiber.id)) yield* Effect.failCause(exit.cause)
            }),
          ),
        )
      return {
        run,
        launch,
        cancel,
        observe,
        periodic: cycle,
        stop,
        failed: (err: Error) =>
          Effect.sync(() => {
            failures.push(err)
          }),
      }
    }
    return {
      install,
      close,
      quiesce,
      drain,
      snapshot: () => ({
        installed: !!controller,
        closing,
        paused,
        loops: loops.size,
        carriers: carriers.size,
        failures: failures.length,
        controller: controller?.snapshot(),
      }),
    }
  }

  const live = make(KiloShutdown)
  export const install = live.install
  export const close = live.close
  export const quiesce = live.quiesce
  export const drain = live.drain
  export const snapshot = live.snapshot
}
