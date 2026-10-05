import path from "node:path"
import { lstat } from "node:fs/promises"
import { Cause, Deferred, Effect, Exit, type Fiber } from "effect"
import {
  acquireCoveredProfileRoot,
  acquireProfileRoot,
  resolveProfileRoot,
} from "@opencode-ai/core/kilocode/profile-maintenance"

/** Foundation only: the shared Snapshot service has not installed this controller. */
export namespace SnapshotAdmission {
  export type Input = { namespaces: readonly string[]; targets?: readonly string[] }
  export type Parent = { readonly [brand]: true }
  const brand: unique symbol = Symbol("Snapshot accepted operation")
  type Lease = Awaited<ReturnType<typeof acquireProfileRoot>>
  type State = {
    open: boolean
    settled: boolean
    prior?: State
    fiber?: number
    cancellations: Set<number>
    leases: Map<string, Lease>
    children: Set<Deferred.Deferred<void>>
  }

  export function make() {
    const parents = new WeakMap<Parent, State>()
    const fibers = new WeakMap<Fiber.Fiber<unknown, unknown>, State>()
    const pending = new Set<Deferred.Deferred<void>>()
    const failures: unknown[] = []
    let closing = false
    let cancelled = 0

    function reserve(parent?: Parent) {
      const prior = parent ? parents.get(parent) : undefined
      if (parent && (!prior || !prior.open)) throw new Error("Snapshot accepted parent is unavailable")
      if (!prior && closing) throw new Error("Snapshot admission is closed")
      const token = Object.freeze({ [brand]: true as const })
      const done = Deferred.makeUnsafe<void>()
      const state: State = {
        open: true,
        settled: false,
        prior,
        cancellations: new Set(),
        leases: new Map(prior?.leases),
        children: new Set(),
      }
      parents.set(token, state)
      pending.add(done)
      prior?.children.add(done)
      return { token, state, done }
    }

    async function acquire(input: Input, state: State) {
      if (!input.namespaces.length) throw new Error("Snapshot admission requires an actual namespace")
      const paths = [...new Set([...input.namespaces, ...(input.targets ?? [])])]
      const roots = await Promise.all(paths.map((file) => resolveProfileRoot({ kind: "json", path: file })))
      const namespaces = roots.filter((_, index) => input.namespaces.includes(paths[index]))
      async function pin(file: string): Promise<{ path: string; dev: bigint; ino: bigint }> {
        const info = await lstat(file, { bigint: true })
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Snapshot namespace is not an existing regular directory")
        return { path: file, dev: info.dev, ino: info.ino }
      }
      const pins = await Promise.all(namespaces.map((root) => pin(root.path)))
      const inside = (root: string, file: string) => {
        const relative = path.relative(root, file)
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      }
      for (const root of roots)
        if (!namespaces.some((namespace) => inside(namespace.path, root.path)))
          throw new Error("Snapshot target is outside its admitted namespaces")
      const leases: Lease[] = []
      const check = async () => {
        const current = await Promise.all(paths.map((file) => resolveProfileRoot({ kind: "json", path: file })))
        if (current.some((root, index) => root.id !== roots[index].id))
          throw new Error("Snapshot canonical binding changed")
        for (const index of namespaces.keys()) {
          const anchor = await pin(pins[index].path)
          if (anchor.path !== pins[index].path || anchor.dev !== pins[index].dev || anchor.ino !== pins[index].ino)
            throw new Error("Snapshot namespace physical identity changed")
        }
      }
      try {
        for (const root of [...new Map(roots.map((root) => [root.id, root])).values()].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        )) {
          if (state.leases.has(root.id)) continue
          const cover = [...state.leases.values()]
            .filter((lease) => inside(lease.root.path, root.path))
            .sort((a, b) => b.root.path.length - a.root.path.length)[0]
          const lease = cover ? await acquireCoveredProfileRoot(root, cover) : await acquireProfileRoot(root)
          leases.push(lease)
          state.leases.set(lease.id, lease)
          if (lease.id !== root.id) throw new Error("Snapshot root changed during admission")
        }
        await check()
      } catch (err) {
        const errors = [err]
        for (const lease of leases.reverse()) await lease.release().catch((err) => errors.push(err))
        throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Snapshot admission failed")
      }
      return async () => {
        const errors: unknown[] = []
        await check().catch((err) => errors.push(err))
        for (const lease of leases.reverse()) await lease.release().catch((err) => errors.push(err))
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, "Snapshot lease retirement failed")
      }
    }

    function requested(state: State, id: number): boolean {
      if (state.cancellations.has(id)) return true
      for (let prior = state.prior; prior; prior = prior.prior)
        if (state.fiber !== undefined && prior.fiber === state.fiber && prior.cancellations.has(id)) return true
      return false
    }

    function work<A, E, R>(
      accepted: ReturnType<typeof reserve>,
      input: Input,
      body: (parent: Parent) => Effect.Effect<A, E, R>,
    ) {
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          accepted.state.fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
          const release = yield* Effect.tryPromise({ try: () => acquire(input, accepted.state), catch: (err) => err })
          const exit = yield* Effect.exit(restore(Effect.suspend(() => body(accepted.token))))
          accepted.state.open = false
          for (const child of accepted.state.children) yield* Deferred.await(child)
          const checked = yield* Effect.exit(Effect.tryPromise({ try: release, catch: (err) => err }))
          if (Exit.isFailure(exit) && Exit.isFailure(checked))
            return yield* Effect.die(
              new AggregateError(
                [Cause.squash(exit.cause), Cause.squash(checked.cause)],
                "Snapshot body and lease retirement failed",
              ),
            )
          if (Exit.isFailure(checked)) return yield* Effect.failCause(checked.cause)
          return yield* Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value)
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            accepted.state.open = false
            accepted.state.settled = true
            if (Exit.isFailure(exit)) {
              const known =
                Cause.hasInterruptsOnly(exit.cause) &&
                exit.cause.reasons.every(
                  (reason) =>
                    Cause.isInterruptReason(reason) &&
                    reason.fiberId !== undefined &&
                    requested(accepted.state, reason.fiberId),
                )
              if (known) cancelled += 1
              if (!known) failures.push(Cause.squash(exit.cause))
            }
            pending.delete(accepted.done)
            yield* Deferred.succeed(accepted.done, undefined)
          }),
        ),
      )
    }

    const run = <A, E, R>(input: Input, body: (parent: Parent) => Effect.Effect<A, E, R>, parent?: Parent) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const selected = yield* Effect.sync(() => ({
            namespaces: [...input.namespaces],
            targets: input.targets ? [...input.targets] : undefined,
          }))
          const accepted = yield* Effect.sync(() => reserve(parent))
          // Acquisition is protected; the actual body remains interruptible, and release is joined.
          return yield* work(accepted, selected, (token) => restore(body(token)))
        }),
      )
    const launch = <A, E, R>(input: Input, body: (parent: Parent) => Effect.Effect<A, E, R>, parent?: Parent) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const selected = yield* Effect.sync(() => ({
            namespaces: [...input.namespaces],
            targets: input.targets ? [...input.targets] : undefined,
          }))
          const accepted = yield* Effect.sync(() => reserve(parent))
          const fiber = yield* Effect.forkDetach(
            work(accepted, selected, (token) => restore(body(token))),
            {
              startImmediately: true,
            },
          )
          fibers.set(fiber, accepted.state)
          return fiber
        }),
      )
    const fork = <A, E, R>(parent: Parent, input: Input, body: (parent: Parent) => Effect.Effect<A, E, R>) =>
      launch(input, body, parent)
    const cancel = <A, E>(target: Fiber.Fiber<A, E>) =>
      Effect.withFiber((caller) =>
        Effect.sync(() => {
          const state = fibers.get(target)
          if (!state) throw new Error("Snapshot fiber is unavailable or foreign")
          if (state.settled) return
          state.cancellations.add(caller.id)
          // Signal only. Joining a cancellation child from the target finalizer would form a cycle.
          target.interruptUnsafe(caller.id)
        }),
      )
    const drain = Effect.suspend(() => {
      closing = true
      return Effect.gen(function* () {
        while (pending.size) for (const done of pending) yield* Deferred.await(done)
        if (failures.length === 1) yield* Effect.die(failures[0])
        if (failures.length) yield* Effect.die(new AggregateError(failures, "Snapshot retirement failed"))
      })
    })
    return {
      run,
      fork,
      launch,
      cancel,
      drain,
      fence: () => {
        closing = true
      },
      snapshot: () => ({ closing, active: pending.size, failures: failures.length, cancelled }),
    }
  }
}
