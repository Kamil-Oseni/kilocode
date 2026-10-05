import path from "node:path"
import { lstat } from "node:fs/promises"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { registerProcessProfile } from "@opencode-ai/core/kilocode/process-profile"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { KiloShutdown } from "../cli/shutdown"
import { ProfileWriterLive } from "../migration/writer-live"
import { SnapshotAdmission } from "../snapshot/admission"

type State = {
  parent: SnapshotAdmission.Parent
  input: SnapshotAdmission.Input
  background: boolean
  effects: { mutated: boolean }
}
const Current = Context.Reference<{ owner: object; state: State } | undefined>("@raya/WorktreeWriter", {
  defaultValue: () => undefined,
})

/** Accepted Git work remains owned after an asynchronous public return, through scoped children and cleanup. */
export namespace WorktreeAdmission {
  export function make(
    shutdown: Pick<typeof KiloShutdown, "register">,
    writer: () => ProfileWriterLive.Admission,
    publish: (paths: readonly string[]) => void = registerProcessProfile,
  ) {
    const owner = Object.freeze({})
    const controller = SnapshotAdmission.make()
    const pending = new Set<Deferred.Deferred<void>>()
    const failures: unknown[] = []
    const refusals = new WeakMap<object, State["effects"]>()
    let closing = false
    let installed: ProfileWriterLive.Admission | undefined

    const drain = Effect.suspend(() => {
      closing = true
      return Effect.uninterruptible(
        Effect.gen(function* () {
          while (pending.size) for (const done of pending) yield* Deferred.await(done)
          const checked = yield* Effect.exit(controller.drain)
          if (Exit.isFailure(checked)) failures.push(Cause.squash(checked.cause))
          if (failures.length === 1) yield* Effect.die(failures[0])
          if (failures.length) yield* Effect.die(new AggregateError(failures, "Worktree retirement failed"))
        }),
      )
    })
    function close() {
      closing = true
      return drain
    }
    function install() {
      if (closing) throw new Error("Worktree admission is closed")
      if (installed) return
      shutdown.register(() => Effect.runPromise(close()))
      installed = writer()
    }

    const run = <A, E, F, R, S>(
      selection: Effect.Effect<SnapshotAdmission.Input, F, R>,
      body: Effect.Effect<A, E, S>,
      scope: Scope.Scope,
    ): Effect.Effect<A, E | F, R | S> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = yield* Current
          if (current && current.owner !== owner) return yield* Effect.die(new Error("Worktree parent is foreign"))
          if (current) {
            const input = yield* selection
            let observed: Exit.Exit<A, E> | undefined
            const checked = yield* controller
              .run(
                input,
                (parent) =>
                  Effect.gen(function* () {
                    yield* Effect.sync(() => publish([...input.namespaces, ...(input.targets ?? [])]))
                    observed = yield* Effect.exit(
                      restore(
                        Effect.provideService(body, Current, { owner, state: { ...current.state, parent, input } }),
                      ),
                    )
                    return observed
                  }),
                current.state.parent,
              )
              .pipe(Effect.orDie, Effect.exit)
            if (Exit.isFailure(checked)) {
              if (observed && Exit.isFailure(observed))
                return yield* Effect.die(
                  new AggregateError(
                    [Cause.squash(observed.cause), Cause.squash(checked.cause)],
                    "Worktree body and retirement failed",
                  ),
                )
              return yield* Effect.failCause(checked.cause)
            }
            const exit = checked.value
            return yield* Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value)
          }
          const done = yield* Effect.sync(() => {
            if (closing) throw new Error("Worktree admission is closed")
            install()
            const done = Deferred.makeUnsafe<void>()
            pending.add(done)
            return done
          })
          const result = Deferred.makeUnsafe<A, E | F>()
          let observed: Exit.Exit<A, E> | undefined
          let admitted = false
          const effects = { mutated: false }
          const cancellations = new Set<number>()
          const work = Effect.gen(function* () {
            const input = yield* selection
            admitted = true
            return yield* controller
              .run(input, (parent) =>
                Effect.gen(function* () {
                  yield* Effect.sync(() => publish([...input.namespaces, ...(input.targets ?? [])]))
                  const state: State = { parent, input, background: false, effects }
                  const exit = yield* Effect.exit(restore(Effect.provideService(body, Current, { owner, state })))
                  observed = exit
                  // Only the existing asynchronous return path publishes before child/lease retirement.
                  if (state.background && Exit.isSuccess(exit)) yield* Deferred.done(result, exit)
                  return exit
                }),
              )
              .pipe(Effect.orDie)
          }).pipe(
            (work) => installed!.run(work),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                const outcome: Exit.Exit<A, E | F> = Exit.isSuccess(exit)
                  ? exit.value
                  : observed && Exit.isFailure(observed)
                    ? Exit.die(
                        new AggregateError(
                          [Cause.squash(observed.cause), Cause.squash(exit.cause)],
                          "Worktree body and retirement failed",
                        ),
                      )
                    : Exit.failCause(exit.cause)
                if (Exit.isFailure(outcome)) {
                  const err = Cause.squash(outcome.cause)
                  const safe = !effects.mutated && err && typeof err === "object" && refusals.get(err) === effects
                  const cancelled =
                    Cause.hasInterruptsOnly(outcome.cause) &&
                    outcome.cause.reasons.every(
                      (reason) =>
                        Cause.isInterruptReason(reason) &&
                        reason.fiberId !== undefined &&
                        cancellations.has(reason.fiberId),
                    )
                  if (admitted && !safe && !cancelled) failures.push(err)
                }
                yield* Deferred.done(result, outcome)
                pending.delete(done)
                yield* Deferred.succeed(done, undefined)
              }),
            ),
          )
          const carrier = yield* Effect.forkIn(Effect.uninterruptible(work), scope)
          return yield* restore(Deferred.await(result)).pipe(
            Effect.onExit((exit) => {
              if (!Exit.isFailure(exit) || !Cause.hasInterruptsOnly(exit.cause)) return Effect.void
              return Effect.withFiber((caller) =>
                Effect.gen(function* () {
                  cancellations.add(caller.id)
                  carrier.interruptUnsafe(caller.id)
                  yield* Fiber.await(carrier)
                }),
              )
            }),
          )
        }),
      )

    const background = <A, E, R>(body: Effect.Effect<A, E, R>, scope: Scope.Scope) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Current
          if (!current || current.owner !== owner)
            return yield* Effect.die(new Error("Worktree background parent is unavailable"))
          const fiber = yield* controller.fork(current.state.parent, current.state.input, (parent) =>
            Effect.provideService(body, Current, { owner, state: { ...current.state, parent } }),
          )
          current.state.background = true
          yield* Scope.addFinalizer(
            scope,
            controller.cancel(fiber).pipe(Effect.andThen(Fiber.await(fiber)), Effect.asVoid),
          )
          return fiber
        }),
      )
    const reject = <E extends object>(err: E) =>
      Effect.gen(function* () {
        const current = yield* Current
        if (!current || current.owner !== owner)
          return yield* Effect.die(new Error("Worktree validation owner is unavailable"))
        if (!current.state.effects.mutated) refusals.set(err, current.state.effects)
        return yield* Effect.fail(err)
      })
    const mutate = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const current = yield* Current
        if (!current || current.owner !== owner)
          return yield* Effect.die(new Error("Worktree mutation owner is unavailable"))
        current.state.effects.mutated = true
        return yield* body
      })
    const failed = (err: unknown) =>
      Effect.gen(function* () {
        const current = yield* Current
        if (!current || current.owner !== owner)
          return yield* Effect.die(new Error("Worktree failure owner is unavailable"))
        failures.push(err)
        return undefined
      })
    return {
      run,
      background,
      reject,
      mutate,
      failed,
      close,
      snapshot: () => ({ closing, active: pending.size, failures: failures.length }),
    }
  }

  /** Include actual existing ancestors for absent targets; never adopt a directory from its spelling alone. */
  export async function roots(namespaces: readonly string[], targets: readonly string[] = []) {
    if ([...namespaces, ...targets].some((file) => !path.isAbsolute(file)))
      throw new Error("Worktree admission requires absolute paths")
    const dirs = [...namespaces]
    for (const file of targets) {
      if (
        dirs.some((dir) => {
          const relative = path.relative(dir, file)
          return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        })
      )
        continue
      let dir = path.dirname(path.resolve(file))
      while (true) {
        const info = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return undefined
          throw err
        })
        if (info) {
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Worktree ancestor is not a regular directory")
          dirs.push(dir)
          break
        }
        const parent = path.dirname(dir)
        if (parent === dir) throw new Error("Worktree target has no existing ancestor")
        dir = parent
      }
    }
    const selected = await Promise.all(
      [...new Set(dirs)].map((file) => resolveProfileRoot({ kind: "json", path: path.resolve(file) })),
    )
    return {
      namespaces: [...new Set(selected.map((root) => root.path))],
      targets: targets.map((file) => path.resolve(file)),
    }
  }

  const live = make(KiloShutdown, ProfileWriterLive.worktrees)
  export const run = live.run
  export const background = live.background
  export const reject = live.reject
  export const mutate = live.mutate
  export const failed = live.failed
  export const close = live.close
  export const snapshot = live.snapshot
}
