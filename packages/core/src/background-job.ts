export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Semaphore, SynchronizedRef } from "effect" // kilocode_change
import { Identifier } from "./id/id"
import { makeGlobalNode } from "./effect/app-node"
import { copy, type Origin } from "./kilocode/background-origin" // kilocode_change
import * as Invocation from "./kilocode/background-invocation" // kilocode_change
import * as Lineage from "./kilocode/background-lineage" // kilocode_change

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  revision?: string // kilocode_change - observation of this generation and its admitted work
  origins?: ReadonlyArray<Origin | undefined> // kilocode_change - preserve unknown and mixed ownership
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  invocations: readonly Invocation.Control[] // kilocode_change
  outcome?: { sequence: number; cancelled: boolean } // kilocode_change - terminal outcome follows admission order
  info: Info
  revision: string // kilocode_change - changes when another invocation is admitted
  done: Deferred.Deferred<Info>
  scope: Scope.Closeable
  retirement: Effect.Success<ReturnType<typeof Lineage.retirement>> // kilocode_change
  token: object
  pending: number
  next: number
  output?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type Entry = Lineage.Interface["entries"] extends Map<object, infer Value> ? Value : never // kilocode_change
type Selection =
  | { status: "missing" | "stale" | "terminal" }
  | {
      status: "cancelled"
      controls: (Entry & { settled: boolean })[]
      scopes: Active["retirement"][]
      info: Info
      done?: Deferred.Deferred<Info>
    } // kilocode_change

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
  lineage: Lineage.Interface["entries"] // kilocode_change
  gate: Lineage.Interface["lock"] // kilocode_change
  retirements: Set<Active["retirement"]> // kilocode_change - preserve unresolved or failed scopes across job-ID reuse
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  retirement?: Active["retirement"] // kilocode_change - original scope-close completion
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type StartResult = { error: string } | { info: Info } | { info: Info; scope: Scope.Closeable; token: object } // kilocode_change

type ExtendResult =
  | { error: string } // kilocode_change
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export type StartInput = {
  origin?: Origin // kilocode_change
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  origin?: Origin // kilocode_change
  id: string
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string, revision?: string) => Effect.Effect<Info | undefined> // kilocode_change - conditional cancellation
  readonly cancelTree: (id: string, revision: string) => Effect.Effect<"missing" | "stale" | "terminal" | "cancelled"> // kilocode_change
  readonly cancelInput: (id: string, revision: string, message: string) => Effect.Effect<boolean> // kilocode_change
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    revision: job.revision, // kilocode_change
    origins: job.info.origins?.map(copy), // kilocode_change - callers cannot mutate registry ownership
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Persisted observation, restart recovery, and remote workers need a
 * separate durable ownership slice rather than pretending this registry has
 * those semantics.
 */
export const make = Effect.gen(function* () {
  // kilocode_change start - one adapter owner shares authenticated ancestry across isolated directory registries
  const provided = yield* Effect.serviceOption(Lineage.Service)
  const lineage = provided._tag === "Some" ? provided.value : yield* Lineage.make
  // kilocode_change end
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
    lineage: lineage.entries, // kilocode_change
    gate: lineage.lock, // kilocode_change
    retirements: new Set(), // kilocode_change
  }

  // kilocode_change start - every registry disposal joins the same original job-scope close
  yield* Scope.addFinalizerExit(state.scope, (cause) =>
    Effect.gen(function* () {
      const selected = yield* Semaphore.withPermit(
        state.gate,
        Effect.gen(function* () {
          const scopes = state.retirements
          for (const entry of state.lineage.values()) {
            if (scopes.has(entry.retirement)) entry.closed = true
          }
          return [...scopes]
        }),
      )
      const exits = yield* Effect.forEach(selected, (item) => Lineage.close(lineage, item, cause).pipe(Effect.exit), {
        concurrency: "unbounded",
      })
      const failures = exits.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
      if (failures.length)
        return yield* Effect.failCause(
          failures.slice(1).reduce((result, next) => Cause.combine(result, next), failures[0]),
        )
      return undefined
    }),
  )
  // kilocode_change end

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string, unknown>,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const pending = job.pending - 1
      const output =
        Exit.isSuccess(exit) && (!job.output || sequence > job.output.sequence)
          ? { sequence, text: exit.value }
          : job.output
      const cancelled = Exit.isFailure(exit) && Invocation.cancelled(exit.cause) // kilocode_change
      // kilocode_change start - cleanup scheduling must not choose a stale invocation's terminal result
      const outcome =
        (Exit.isSuccess(exit) || cancelled) && (!job.outcome || sequence > job.outcome.sequence)
          ? { sequence, cancelled }
          : job.outcome
      // kilocode_change end
      // kilocode_change start - preserve unrelated extensions
      if ((Exit.isSuccess(exit) || cancelled) && pending > 0) {
        return [{}, new Map(jobs).set(id, { ...job, pending, output, outcome })]
      }
      // kilocode_change end
      // kilocode_change start
      const status: Exclude<Status, "running"> =
        Exit.isSuccess(exit) || cancelled
          ? outcome?.cancelled
            ? "cancelled"
            : "completed"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "error"
      // kilocode_change end
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        output,
        info: {
          ...job.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          // kilocode_change start
          ...(status === "cancelled" && outcome?.cancelled
            ? { error: "Task invocation cancelled" }
            : Exit.isFailure(exit) && !cancelled
              ? { error: errorText(Cause.squash(exit.cause)) }
              : {}),
          // kilocode_change end
        },
      }
      // kilocode_change start - joined pruned originals are retired; the coordinator closes fenced scopes after joins
      const fenced = job.invocations.every((item) => state.lineage.get(item.token)?.closed ?? true)
      return [
        { info: snapshot(next), done: job.done, retirement: fenced ? undefined : job.retirement },
        new Map(jobs).set(id, next),
      ]
      // kilocode_change end
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.retirement && state.scope.state._tag !== "Closed") {
      // kilocode_change - registry disposal owns closing scopes
      yield* Lineage.close(lineage, result.retirement).pipe(
        // kilocode_change
        Effect.forkIn(state.scope, { startImmediately: true }),
      )
    }
    return result.info
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string, unknown>,
    control: Invocation.Control, // kilocode_change
  ) {
    return yield* run.pipe(
      // kilocode_change start - expire only this original invocation's admission authority
      Effect.onExit(() =>
        Effect.sync(() => {
          const entry = state.lineage.get(control.token)
          if (entry) entry.finished = true
        }).pipe((effect) => Semaphore.withPermit(state.gate, effect)),
      ),
      // kilocode_change end
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.ensuring(Deferred.succeed(control.joined, undefined).pipe(Effect.andThen(Lineage.prune(lineage)))), // kilocode_change - join settlement, then release completed lineage leaves
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    return Array.from((yield* SynchronizedRef.get(state.jobs)).values())
      .map(snapshot)
      .toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const promoted = yield* Deferred.make<Info>()
        const tail = yield* Deferred.make<void>()
        const invocation = yield* Invocation.make(input.origin) // kilocode_change
        const owner = yield* Effect.serviceOption(Invocation.Owner) // kilocode_change
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            // kilocode_change start - only admitted execution context can establish ancestry
            if (state.scope.state._tag === "Closed") return [{ error: "Background registry is closed" }, jobs] as const
            const parent = owner._tag === "Some" ? state.lineage.get(owner.value.token) : undefined
            if (owner._tag === "Some" && (!parent || parent.closed || parent.finished))
              return [{ error: "Background parent execution is closed or foreign" }, jobs] as const
            const existing = jobs.get(id)
            if (
              existing?.info.status === "running" &&
              existing.invocations.every((item) => state.lineage.get(item.token)?.closed ?? true)
            )
              return [{ error: "Background execution is retiring" }, jobs] as const
            // kilocode_change end
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            const scope = yield* Scope.make("parallel") // kilocode_change - registry disposal shares the original close
            const retirement = yield* Lineage.retirement(scope) // kilocode_change
            retirement.release = Effect.sync(() => {
              state.retirements.delete(retirement)
            }) // kilocode_change
            state.retirements.add(retirement) // kilocode_change
            const token = {}
            state.lineage.set(invocation.token, {
              control: invocation,
              parent: owner._tag === "Some" ? owner.value.token : undefined,
              closed: false,
              finished: false,
              scope,
              retirement,
            }) // kilocode_change
            const job = {
              invocations: [invocation], // kilocode_change
              revision: crypto.randomUUID(), // kilocode_change - never reuse a prior execution's cancellation identity
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
                origins: [copy(input.origin)], // kilocode_change
              },
              done,
              scope,
              retirement, // kilocode_change
              token,
              pending: 1,
              next: 1,
              tail,
              promoted,
              onPromote: input.onPromote,
            }
            return [{ info: snapshot(job), scope, token }, new Map(jobs).set(id, job)] as readonly [
              StartResult,
              Map<string, Active>,
            ]
          }),
        ).pipe((effect) => Semaphore.withPermit(state.gate, effect)) // kilocode_change
        if ("error" in result) return yield* Effect.die(new Error(result.error)) // kilocode_change - fail after releasing the admission lock
        if ("scope" in result)
          yield* fork(
            result.scope,
            id,
            result.token,
            0,
            invocation.run(restore(input.run)).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))), // kilocode_change
            invocation, // kilocode_change
          )
        return result.info
      }),
    )
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const invocation = yield* Invocation.make(input.origin) // kilocode_change
        const owner = yield* Effect.serviceOption(Invocation.Owner) // kilocode_change
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            // kilocode_change start
            if (state.scope.state._tag === "Closed") return [{ error: "Background registry is closed" }, jobs] as const
            const parent = owner._tag === "Some" ? state.lineage.get(owner.value.token) : undefined
            if (owner._tag === "Some" && (!parent || parent.closed || parent.finished))
              return [{ error: "Background parent execution is closed or foreign" }, jobs] as const
            const job = jobs.get(input.id)
            if (
              job?.info.status === "running" &&
              job.invocations.every((item) => state.lineage.get(item.token)?.closed ?? true)
            )
              return [{ error: "Background execution is retiring" }, jobs] as const
            // kilocode_change end
            if (!job || job.info.status !== "running")
              return [{ extended: false }, jobs] as readonly [ExtendResult, Map<string, Active>]
            state.lineage.set(invocation.token, {
              control: invocation,
              parent: owner._tag === "Some" ? owner.value.token : undefined,
              closed: false,
              finished: false,
              scope: job.scope,
              retirement: job.retirement,
            }) // kilocode_change
            return [
              { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
              new Map(jobs).set(input.id, {
                ...job,
                invocations: [...job.invocations, invocation], // kilocode_change
                revision: crypto.randomUUID(), // kilocode_change - stale observations cannot cancel newly admitted work
                info: { ...job.info, origins: [...(job.info.origins ?? []), copy(input.origin)] }, // kilocode_change
                pending: job.pending + 1,
                next: job.next + 1,
                tail,
              }),
            ] as readonly [ExtendResult, Map<string, Active>]
          }),
        ).pipe((effect) => Semaphore.withPermit(state.gate, effect)) // kilocode_change
        if ("error" in result) return yield* Effect.die(new Error(result.error)) // kilocode_change - fail after releasing the admission lock
        if (!result.extended) return false
        // kilocode_change start - a cancelled queued invocation cannot open its successor ahead of the predecessor
        yield* Deferred.await(result.previous).pipe(
          Effect.andThen(Deferred.await(invocation.joined)),
          Effect.andThen(Deferred.succeed(result.tail, undefined)),
          Effect.forkIn(result.scope, { startImmediately: true }),
        )
        // kilocode_change end
        yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          invocation.run(Deferred.await(result.previous).pipe(Effect.andThen(restore(input.run)))), // kilocode_change - cancellation joins even a queued original fiber
          invocation, // kilocode_change
        )
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job || job.info.status !== "running") return yield* Effect.never
    if (job.info.metadata?.background === true) return snapshot(job)
    return yield* Deferred.await(job.promoted)
  })

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        if (state.scope.state._tag === "Closed") return [{}, jobs] as readonly [PromoteResult, Map<string, Active>] // kilocode_change
        const job = jobs.get(id)
        if (!job || job.info.status !== "running") return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
        const next = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        return [
          { info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted },
          new Map(jobs).set(id, next),
        ] as readonly [PromoteResult, Map<string, Active>]
      }),
    )
    if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
    if (result.onPromote && state.scope.state._tag !== "Closed") yield* result.onPromote.pipe(Effect.ignore) // kilocode_change
    return result.info
  })

  // kilocode_change start - legacy disposal still observes and retires one exact generation
  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id, revision) {
    const observed = yield* get(id)
    if (!observed || !observed.revision || (revision !== undefined && observed.revision !== revision)) return undefined
    const result = yield* tree(id, observed.revision, true).pipe(
      Effect.forkIn(state.scope, { startImmediately: true }),
      Effect.flatMap(Fiber.join),
    )
    return result.status === "cancelled" ? result.info : undefined
  })
  // kilocode_change end

  // kilocode_change start - select original invocation ancestry under the same admission lock
  const tree = Effect.fn("BackgroundJob.tree")(function* (id: string, revision: string, dispose: boolean) {
    const completed_at = yield* Clock.currentTimeMillis
    const selected = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      (jobs): Effect.Effect<readonly [Selection, Map<string, Active>]> =>
        Effect.gen(function* () {
          const root = jobs.get(id)
          if (!root) return [{ status: "missing" as const }, jobs] as const
          if (root.revision !== revision) return [{ status: "stale" as const }, jobs] as const
          if (!dispose && root.info.status !== "running") return [{ status: "terminal" as const }, jobs] as const
          const tokens = new Set(root.invocations.map((item) => item.token))
          for (const [token, item] of state.lineage) {
            if (item.parent && tokens.has(item.parent)) tokens.add(token)
          }
          const originals = [...tokens].flatMap((token) => {
            const item = state.lineage.get(token)
            return item ? [item] : []
          })
          for (const item of originals) item.closed = true
          const controls = yield* Effect.forEach(originals, (item) =>
            Deferred.isDone(item.control.joined).pipe(Effect.map((settled) => ({ ...item, settled }))),
          )
          const groups = new Map<Active["retirement"], object[]>([
            [root.retirement, root.invocations.map((item) => item.token)],
          ])
          for (const [token, item] of state.lineage)
            groups.set(item.retirement, [...(groups.get(item.retirement) ?? []), token])
          const scopes = [...groups]
            .filter(([, group]) => group.every((token) => tokens.has(token)))
            .map(([scope]) => scope)
          const next =
            dispose && root.info.status === "running"
              ? {
                  ...root,
                  pending: 0,
                  onPromote: undefined,
                  info: { ...root.info, status: "cancelled" as const, completed_at },
                }
              : root
          return [
            {
              status: "cancelled" as const,
              controls,
              scopes,
              info: snapshot(next),
              ...(next !== root ? { done: root.done } : {}),
            },
            next === root ? jobs : new Map(jobs).set(id, next),
          ] as const
        }),
    ).pipe((effect) => Semaphore.withPermit(state.gate, effect), Effect.uninterruptible)
    if (selected.status !== "cancelled") return selected
    if (selected.done) yield* Deferred.succeed(selected.done, selected.info)
    const waits = yield* Effect.forEach(selected.controls, (item) => item.control.request)
    // Cleanup waits occur outside the admission lock; every selected original settles even if another fails.
    const exits = yield* Effect.forEach(
      selected.controls,
      (item, index) =>
        Effect.gen(function* () {
          yield* waits[index]
          yield* Deferred.await(item.control.joined)
          if (!item.settled) yield* item.control.join.pipe(Effect.orDie)
        }).pipe(Effect.exit),
      { concurrency: "unbounded" },
    )
    const closed = yield* Effect.forEach(selected.scopes, (scope) => Lineage.close(lineage, scope).pipe(Effect.exit), {
      concurrency: "unbounded",
    })
    const failures = [...exits, ...closed].flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []))
    if (failures.length)
      return yield* Effect.failCause(failures.slice(1).reduce((cause, next) => Cause.combine(cause, next), failures[0]))
    return { status: "cancelled" as const, info: selected.info }
  }, Effect.uninterruptible)
  const cancelTree: Interface["cancelTree"] = Effect.fn("BackgroundJob.cancelTree")(function* (id, revision) {
    return (yield* tree(id, revision, false).pipe(
      Effect.forkIn(state.scope, { startImmediately: true }),
      Effect.flatMap(Fiber.join),
    )).status
  })
  // kilocode_change end

  // kilocode_change start - select a unique invocation under the same admission lock
  const cancelInput: Interface["cancelInput"] = Effect.fn("BackgroundJob.cancelInput")(
    function* (id, revision, message) {
      const control = yield* SynchronizedRef.modify(
        state.jobs,
        (jobs): readonly [Invocation.Control | undefined, Map<string, Active>] => {
          const job = jobs.get(id)
          if (!job || job.info.status !== "running" || job.revision !== revision) return [undefined, jobs]
          const matches = (job.info.origins ?? []).flatMap((origin, index) =>
            origin?.childSessionID === id && origin.childMessageID === message ? [index] : [],
          )
          return [matches.length === 1 ? job.invocations[matches[0]] : undefined, jobs]
        },
      ).pipe(Effect.uninterruptible)
      if (!control) return false
      return yield* Effect.flatten(control.request)
    },
  )
  // kilocode_change end

  return Service.of({ list, get, start, extend, wait, waitForPromotion, promote, cancel, cancelTree, cancelInput }) // kilocode_change
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
