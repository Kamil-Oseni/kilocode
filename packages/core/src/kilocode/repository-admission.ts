import path from "node:path"
import { lstat, mkdir } from "node:fs/promises"
import { Cause, Context, Deferred, Effect, Exit, Scope } from "effect"
import { acquireProfileRoot, resolveProfileRoot } from "./profile-maintenance"
import { registerProcessProfile } from "./process-profile"

type Input = { repos: string; state: string; target: string }
type State = { mutated: boolean; failures: unknown[] }
type Writer = { run<A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> }
const Current = Context.Reference<
  { owner: object; state: State; admission?: Awaited<ReturnType<typeof admit>> } | undefined
>("@raya/RepositoryWriter", {
  defaultValue: () => undefined,
})

/** Repository operations and accepted reference producers share one lifetime through scoped cleanup. */
export namespace RepositoryAdmission {
  export function make(publish: (roots: readonly string[]) => void = registerProcessProfile) {
    const owner = Object.freeze({})
    const pending = new Set<Deferred.Deferred<void>>()
    const failures: unknown[] = []
    let closing = false
    let writer: (() => Writer) | undefined

    function reserve() {
      if (closing) throw new Error("Repository writer is retired")
      const active = writer?.()
      const done = Deferred.makeUnsafe<void>()
      pending.add(done)
      const state: State = { mutated: false, failures: [] }
      return { done, state, writer: active }
    }

    const work = <A, E, R>(ticket: ReturnType<typeof reserve>, body: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const effect = Effect.provideService(restore(body), Current, { owner, state: ticket.state })
          const exit = yield* Effect.exit(ticket.writer ? ticket.writer.run(effect) : effect)
          if (Exit.isFailure(exit) && ticket.state.mutated) ticket.state.failures.push(Cause.squash(exit.cause))
          for (const error of ticket.state.failures) if (!failures.includes(error)) failures.push(error)
          pending.delete(ticket.done)
          yield* Deferred.succeed(ticket.done, undefined)
          return yield* Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value)
        }),
      )

    const accepted = <A, E, R>(body: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const prior = yield* Current
          if (prior?.owner === owner) return yield* restore(body)
          const ticket = yield* Effect.sync(reserve)
          return yield* work(ticket, restore(body))
        }),
      )

    const run = <A, E, R>(input: Input, body: Effect.Effect<A, E, R>) =>
      accepted(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = yield* Current
            if (!current) return yield* Effect.die(new Error("Repository admission lifetime missing"))
            const admission = yield* Effect.tryPromise({
              try: () =>
                admit(input, publish, () => {
                  if (!current) throw new Error("Repository admission lifetime missing")
                  current.state.mutated = true
                }),
              catch: (err) => err,
            }).pipe(Effect.orDie)
            const exit = yield* Effect.exit(Effect.provideService(restore(body), Current, { ...current, admission }))
            if (Exit.isFailure(exit) && current?.state.mutated) current.state.failures.push(Cause.squash(exit.cause))
            const cleanup = yield* Effect.exit(Effect.tryPromise({ try: admission.release, catch: (err) => err }))
            if (Exit.isFailure(cleanup)) {
              const error = Cause.squash(cleanup.cause)
              const current = yield* Current
              current?.state.failures.push(error)
              if (Exit.isFailure(exit))
                return yield* Effect.die(
                  new AggregateError([Cause.squash(exit.cause), error], "Repository body and cleanup failed"),
                )
              return yield* Effect.die(error)
            }
            return yield* Exit.isFailure(exit) ? Effect.failCause(exit.cause) : Effect.succeed(exit.value)
          }),
        ),
      )

    const fork = <A, E, R>(body: Effect.Effect<A, E, R>, scope: Scope.Scope) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const ticket = yield* Effect.sync(reserve)
          let closed = false
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              closed = true
            }),
          )
          // A previously closed scope must not start an accepted producer body.
          const guarded = Effect.suspend(() => (closed ? Effect.interrupt : restore(body)))
          return yield* work(ticket, guarded).pipe(Effect.forkIn(scope, { startImmediately: true }))
        }),
      )

    const drain = Effect.suspend(() => {
      closing = true
      return Effect.uninterruptible(
        Effect.gen(function* () {
          while (pending.size) for (const done of pending) yield* Deferred.await(done)
          if (failures.length === 1) yield* Effect.die(failures[0])
          if (failures.length) yield* Effect.die(new AggregateError(failures, "Repository retirement failed"))
        }),
      )
    })
    return {
      run,
      fork,
      drain,
      fence: () => {
        closing = true
      },
      install: (activate: () => Writer) => {
        if (closing || pending.size || writer) throw new Error("Repository host installation is unavailable")
        writer = activate
      },
      snapshot: () => ({ closing, active: pending.size, failures: failures.length }),
    }
  }

  export const process = make()
  const Controller = Context.Reference<ReturnType<typeof make>>("@raya/RepositoryAdmission", {
    defaultValue: () => process,
  })
  export const provide = <A, E, R>(controller: ReturnType<typeof make>, body: Effect.Effect<A, E, R>) =>
    Effect.provideService(body, Controller, controller)
  export const run = <A, E, R>(input: Input, body: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Controller, (controller) => controller.run(input, body))
  export const fork = <A, E, R>(body: Effect.Effect<A, E, R>, scope: Scope.Scope) =>
    Effect.flatMap(Controller, (controller) => controller.fork(body, scope))
  export const admin = (paths: readonly string[]) =>
    Effect.flatMap(Current, (current) =>
      Effect.tryPromise({
        try: () => {
          if (!current?.admission) throw new Error("Git administration has no repository admission")
          return current.admission.admin(paths)
        },
        catch: (err) => err,
      }).pipe(Effect.orDie),
    )
  export const cleanup = Effect.map(Current, (current) =>
    current?.admission ? { strict: true as const, failed } : undefined,
  )
  export const failed = (cause: Cause.Cause<unknown>) =>
    Effect.flatMap(Current, (current) =>
      Effect.sync(() => {
        if (current?.state.mutated) current.state.failures.push(Cause.squash(cause))
      }),
    )
}

let initializing = Promise.resolve()
async function admit(input: Input, publish: (roots: readonly string[]) => void, mutate: () => void) {
  const prior = initializing
  let finish!: () => void
  initializing = new Promise<void>((resolve) => {
    finish = resolve
  })
  await prior
  try {
    return await initialize(input, publish, mutate)
  } finally {
    finish()
  }
}

async function initialize(input: Input, publish: (roots: readonly string[]) => void, mutate: () => void) {
  const paths = [...new Set([input.repos, input.state, path.join(input.state, "locks")])]
  const roots = await Promise.all(paths.map((file) => resolveProfileRoot({ kind: "json", path: file })))
  const targets = [...new Set([path.dirname(input.target), input.target])]
  const files = await Promise.all(targets.map((file) => resolveProfileRoot({ kind: "json", path: file })))
  for (const root of files) {
    const relative = path.relative(roots[0].path, root.path)
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new Error("Repository checkout escaped cache namespace")
  }
  const pins = await Promise.all(
    roots.map(async (root) => {
      let file = root.path
      while (true) {
        const info = await lstat(file, { bigint: true }).catch((err: unknown) => {
          if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return undefined
          throw err
        })
        if (info) {
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("Repository namespace is not a regular directory")
          return { path: file, dev: info.dev, ino: info.ino }
        }
        const parent = path.dirname(file)
        if (parent === file) throw new Error("Repository namespace has no existing anchor")
        file = parent
      }
    }),
  )
  const leases: Awaited<ReturnType<typeof acquireProfileRoot>>[] = []
  const check = async () => {
    for (const index of roots.keys()) {
      const root = await resolveProfileRoot({ kind: "json", path: paths[index] })
      const pin = pins[index]
      const info = await lstat(pin.path, { bigint: true })
      if (
        root.id !== roots[index].id ||
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.dev !== pin.dev ||
        info.ino !== pin.ino
      )
        throw new Error("Repository namespace binding changed")
    }
  }
  try {
    mutate()
    for (const root of [...new Map(roots.slice(0, 2).map((root) => [root.id, root])).values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ))
      leases.push(await acquireProfileRoot(root))
    await check()
    publish(paths.slice(0, 2))
    // Only actual exclusive directory creation may advance an absent namespace's physical pin.
    for (const index of roots.keys()) {
      const relative = path.relative(pins[index].path, roots[index].path)
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
        throw new Error("Repository namespace escaped anchor")
      let file = pins[index].path
      for (const part of relative.split(path.sep).filter(Boolean)) {
        file = path.join(file, part)
        const existing = roots.findIndex(
          (root, other) => other < index && root.path === file && pins[other].path === file,
        )
        if (existing < 0) await mkdir(file)
        const info = await lstat(file, { bigint: true })
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Repository namespace creation changed")
      }
      const info = await lstat(roots[index].path, { bigint: true })
      pins[index] = { path: roots[index].path, dev: info.dev, ino: info.ino }
    }
    await check()
    // Creating lock metadata for the exact locks root must follow authentic creation/pinning of its state parent.
    publish(paths.slice(2))
    if (!leases.some((lease) => lease.id === roots[2].id)) leases.push(await acquireProfileRoot(roots[2]))
    for (const root of [...new Map(files.map((root) => [root.id, root])).values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ))
      if (!leases.some((lease) => lease.id === root.id)) leases.push(await acquireProfileRoot(root))
    const parent = await lstat(files[0].path, { bigint: true })
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error("Repository checkout parent is not a directory")
    pins.push({ path: files[0].path, dev: parent.dev, ino: parent.ino })
    paths.push(...targets)
    roots.push(...files)
    // Target inode replacement is intentional; only its canonical binding and stable parent are pinned.
    const anchor = pins[0]
    pins.push(anchor)
    publish(targets)
    await check()
  } catch (err) {
    const errors = [err]
    for (const lease of leases.reverse()) await lease.release().catch((error) => errors.push(error))
    throw errors.length === 1 ? err : new AggregateError(errors, "Repository admission failed")
  }
  let active = true
  const admin = async (items: readonly string[]) => {
    if (!active) throw new Error("Repository admission is released")
    await check()
    const additions = await Promise.all(
      [...new Set(items)].map(async (file) => {
        const root = await resolveProfileRoot({ kind: "json", path: file })
        const relative = path.relative(roots[0].path, root.path)
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
          throw new Error("Git administration escaped cache namespace")
        const info = await lstat(file, { bigint: true })
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Git administration is not a regular directory")
        return { file, root, pin: { path: file, dev: info.dev, ino: info.ino } }
      }),
    )
    for (const item of additions.sort((a, b) => a.root.id.localeCompare(b.root.id))) {
      if (paths.includes(item.file)) continue
      if (!leases.some((lease) => lease.id === item.root.id)) leases.push(await acquireProfileRoot(item.root))
      paths.push(item.file)
      roots.push(item.root)
      pins.push(item.pin)
    }
    await check()
    publish(items)
  }
  const release = async () => {
    active = false
    const errors: unknown[] = []
    await check().catch((err) => errors.push(err))
    for (const lease of leases.reverse()) await lease.release().catch((err) => errors.push(err))
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, "Repository lease release failed")
  }
  return { admin, release }
}
