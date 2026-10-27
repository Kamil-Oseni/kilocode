import { AsyncLocalStorage } from "node:async_hooks"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, type Scope } from "effect"
import { RayaTaskExecution } from "./execution"
import type { Session } from "@/session/session"
import * as Delegation from "./effect-delegation"
import { SessionRetirement } from "@/kilocode/session/retirement"

/** Original execution lineage only; never a qualified native effect capability. */
type Root = {
  alive: boolean
  original: NonNullable<ReturnType<typeof RayaTaskExecution.original>>
  sessions?: Session.Interface
  producers: Set<Producer>
}
const opaque = Symbol("Original execution frame")
type Frame = Readonly<{ [opaque]: true }>
type State = { root: Root; fiber: unknown; alive: boolean; session: string }
type Producer = {
  filled: Deferred.Deferred<Fiber.Fiber<void, unknown> | undefined>
  work: Deferred.Deferred<Fiber.Fiber<unknown, unknown> | undefined>
  cancel: Effect.Effect<void, unknown>
  attached: boolean
  started: boolean
  fiber?: Fiber.Fiber<void, unknown>
  working: boolean
  stopping: boolean
}
const delegation = Symbol("Original Task delegation")
export type Lease = Readonly<{ [delegation]: true }>
const leases = new WeakMap<Lease, { root: Root; identity: Delegation.Identity; sha: string }>()
const handoff = Symbol("Original execution handoff")
const request = Symbol("Original execution request")
export type Handoff = Readonly<{ [handoff]: true }>
export type Runner = Readonly<{ [request]: true }>
const Current = Context.Reference<Frame | undefined>("@raya/ExecutionLineage", { defaultValue: () => undefined })
const promises = new AsyncLocalStorage<Frame | undefined>()
const handoffs = new WeakMap<Handoff, { frame: Frame; used: boolean }>()
const runners = new WeakMap<Runner, Frame>()
const frames = new WeakMap<Frame, State>()
const refuse = () => new Error("Original routine execution lineage is unavailable or retired")
const require = (frame: Frame) => {
  const state = frames.get(frame)
  if (!state || !state.alive || !state.root.alive || !state.root.original.alive()) throw refuse()
  return state
}
const mint = (state: State): Frame => {
  const token: Frame = Object.freeze({ [opaque]: true })
  frames.set(token, state)
  return token
}

export function own<A, E, R>(permit: unknown, body: Effect.Effect<A, E, R>): Effect.Effect<A, unknown, R> {
  return Effect.withFiber((fiber) => {
    const original = RayaTaskExecution.original(permit, fiber)
    if (!original) return Effect.die(refuse())
    return Effect.gen(function* () {
      // Loading Session while provider modules initialize would form the
      // Session → Snapshot → provider → lineage cycle. Resolve only on a real
      // execution call, retaining the actual caller-selected service instance.
      const module = yield* Effect.promise(() => import("@/session/session"))
      const sessions = yield* Effect.serviceOption(module.Session.Service)
      const root: Root = { alive: true, original, sessions: Option.getOrUndefined(sessions), producers: new Set() }
      const state: State = { root, fiber, alive: true, session: original.sessionID }
      const frame = mint(state)
      return yield* Effect.provideService(body, Current, frame).pipe(
        Effect.onExit((exit) =>
          Effect.uninterruptibleMask(() =>
            Effect.gen(function* () {
              // enqueue releases its predecessor before prompt returns. Never
              // drain from Task work or from inside that original queue slot.
              if (Exit.isFailure(exit)) root.alive = false
              const drain = (stopping: boolean) =>
                Effect.gen(function* () {
                  const joined = new Set<Producer>()
                  const failures: Cause.Cause<unknown>[] = []
                  while (joined.size !== root.producers.size) {
                    const pending = [...root.producers].filter((value) => !joined.has(value))
                    if (stopping) {
                      for (const value of pending) value.stopping = true
                      for (const value of pending)
                        if (!value.attached) {
                          value.attached = true
                          Deferred.doneUnsafe(value.filled, Effect.succeed(undefined))
                        }
                      yield* Effect.forEach(
                        pending,
                        (value) =>
                          Effect.suspend(() => value.cancel).pipe(
                            Effect.onExit((stop) =>
                              Effect.sync(() => {
                                if (Exit.isFailure(stop)) failures.push(stop.cause)
                              }),
                            ),
                            // Retain every original failure above, join all selected
                            // producers below, then rethrow the retained causes.
                            Effect.catchCause(() => Effect.void),
                          ),
                        {
                          concurrency: "unbounded",
                          discard: true,
                        },
                      )
                    }
                    for (const value of pending) {
                      const child = yield* Deferred.await(value.filled)
                      if (child) {
                        if (child === fiber) throw refuse()
                        const result = yield* Fiber.await(child)
                        if (Exit.isFailure(result)) failures.push(result.cause)
                      }
                      joined.add(value)
                    }
                  }
                  if (failures.length)
                    yield* Effect.failCause(failures.reduce((first, next) => Cause.combine(first, next)))
                })
              if (Exit.isFailure(exit)) return yield* drain(true)
              // Cancellation while joining successful background work must fence
              // the original root before requesting and joining those producers.
              return yield* Effect.interruptible(drain(false)).pipe(
                Effect.onExit((result) => {
                  if (Exit.isSuccess(result)) return Effect.void
                  root.alive = false
                  return drain(true)
                }),
              )
            }),
          ).pipe(Effect.orDie),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            state.alive = false
            root.alive = false
          }),
        ),
      )
    })
  })
}

export function capture() {
  return Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const frame = Context.getReferenceUnsafe(fiber.context, Current)
      if (!frame) return undefined
      const state = require(frame)
      if (state.fiber !== fiber) throw refuse()
      const token: Handoff = Object.freeze({ [handoff]: true })
      handoffs.set(token, { frame, used: false })
      return token
    }),
  )
}

export function transfer<A, E, R>(token: Handoff | undefined, session: string, body: Effect.Effect<A, E, R>) {
  if (token === undefined) return Effect.provideService(body, Current, undefined)
  return Effect.withFiber((fiber) =>
    Effect.suspend(() => {
      const held = handoffs.get(token)
      if (!held || held.used) return Effect.die(refuse())
      const original = require(held.frame)
      if (original.session !== session) return Effect.die(refuse())
      held.used = true
      const state: State = { root: original.root, fiber, alive: true, session }
      const frame = mint(state)
      return Effect.provideService(body, Current, frame).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            state.alive = false
          }),
        ),
      )
    }),
  )
}

export function check() {
  return Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const frame = Context.getReferenceUnsafe(fiber.context, Current)
      if (!frame) return
      const state = require(frame)
      if (state.fiber !== fiber) throw refuse()
    }),
  )
}

export function matches(run: { id: string; agentID: string; sessionID: string }) {
  return Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const frame = Context.getReferenceUnsafe(fiber.context, Current)
      if (!frame) return false
      const state = require(frame)
      if (state.fiber !== fiber) return false
      const original = state.root.original
      return (
        state.session === run.sessionID &&
        original.runID === run.id &&
        original.agentID === run.agentID &&
        original.sessionID === run.sessionID
      )
    }),
  )
}

/** Only an original live callback can identify its current Routine execution session. */
export function session() {
  return Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const frame = Context.getReferenceUnsafe(fiber.context, Current)
      if (!frame) return undefined
      const state = require(frame)
      if (state.fiber !== fiber) throw refuse()
      return state.session
    }),
  )
}

export function promise<A>(body: (signal: AbortSignal) => PromiseLike<A>) {
  return Effect.withFiber((fiber) =>
    Effect.tryPromise({
      try: (signal) => {
        const frame = Context.getReferenceUnsafe(fiber.context, Current)
        if (!frame) return promises.run(undefined, () => Promise.resolve(body(signal)))
        const state = require(frame)
        if (state.fiber !== fiber) throw refuse()
        return promises.run(frame, () => Promise.resolve(body(signal)))
      },
      catch: (err) => err,
    }),
  )
}

export function runner(): Runner | undefined {
  const frame = promises.getStore()
  if (!frame) return undefined
  require(frame)
  const token: Runner = Object.freeze({ [request]: true })
  runners.set(token, frame)
  return token
}

/** Capture the original frame for a deferred provider request, without minting a new execution owner. */
export function bind() {
  return Effect.withFiber((fiber) =>
    Effect.sync(() => {
      const frame = Context.getReferenceUnsafe(fiber.context, Current)
      if (!frame) return undefined
      const state = require(frame)
      if (state.fiber !== fiber) throw refuse()
      const token: Runner = Object.freeze({ [request]: true })
      runners.set(token, frame)
      return token
    }),
  )
}

export function run<A>(token: Runner | undefined, body: () => PromiseLike<A>): Promise<A> {
  const invoke = (frame: Frame | undefined) =>
    promises.run(
      frame,
      () =>
        new Promise<A>((resolve, reject) => {
          try {
            if (frame) require(frame)
            resolve(body())
          } catch (err) {
            reject(err)
          }
        }),
    )
  if (token === undefined) return invoke(undefined)
  const frame = runners.get(token)
  if (!frame) return Promise.reject(refuse())
  return invoke(frame)
}

export function checkPromise() {
  const frame = promises.getStore()
  if (frame) require(frame)
}

/** Bind one real SDK/native callback fiber from its private original Promise frame. */
export function callback<A, E, R>(session: string, body: Effect.Effect<A, E, R>) {
  const original = promises.getStore()
  if (!original) return Effect.provideService(body, Current, undefined)
  return Effect.withFiber((fiber) =>
    Effect.suspend(() => {
      const held = require(original)
      if (held.session !== session) return Effect.die(refuse())
      const state: State = { root: held.root, fiber, alive: true, session }
      const frame = mint(state)
      return Effect.provideService(body, Current, frame).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            state.alive = false
          }),
        ),
      )
    }),
  )
}

/** Admit a child only on a genuine original frame, using its selected Session
 * service and the actual already-persisted running Task association. */
export function admit(input: Delegation.Identity) {
  return Effect.withFiber((fiber) =>
    Effect.gen(function* () {
      const frame = Context.getReferenceUnsafe(fiber.context, Current)
      if (!frame) return undefined
      const held = require(frame)
      if (held.fiber !== fiber || held.session !== input.sessionID || !held.root.sessions) throw refuse()
      const identity = Object.freeze({ ...input })
      const sha = yield* Delegation.inspect(held.root.sessions, identity)
      require(frame)
      const token: Lease = Object.freeze({ [delegation]: true })
      leases.set(token, { root: held.root, identity, sha })
      return token
    }),
  )
}

/** Reserve BEFORE the actual fork. The real returned fiber is attached by the
 * producer; neither terminal status nor a self-finalizer is a joined receipt. */
export function producer(
  token: Lease | undefined,
  session: string,
  cancel: Effect.Effect<void, unknown>,
  worker = false,
) {
  return Effect.gen(function* () {
    if (!token) return undefined
    const held = leases.get(token)
    if (
      !held ||
      !held.root.alive ||
      !held.root.original.alive() ||
      (session !== held.identity.sessionID && session !== held.identity.childSessionID) ||
      !held.root.sessions
    )
      throw refuse()
    if (held.root.producers.size >= 128) throw new Error("Original Task producer roster exceeds capacity")
    const value: Producer = {
      filled: yield* Deferred.make<Fiber.Fiber<void, unknown> | undefined>(),
      work: yield* Deferred.make<Fiber.Fiber<unknown, unknown> | undefined>(),
      cancel,
      attached: false,
      started: false,
      working: false,
      stopping: false,
    }
    held.root.producers.add(value)
    const fresh = () =>
      Effect.gen(function* () {
        if (!held.root.alive || !held.root.original.alive() || !held.root.sessions) throw refuse()
        if ((yield* Delegation.inspect(held.root.sessions, held.identity)) !== held.sha) throw refuse()
      }).pipe(Effect.orDie)
    return Object.freeze({
      attach: (fiber: Fiber.Fiber<void, unknown>) =>
        Effect.gen(function* () {
          if (value.attached) throw refuse()
          value.attached = true
          value.fiber = fiber
          if (!worker) {
            value.cancel = SessionRetirement.interrupt(fiber).pipe(Effect.asVoid)
            yield* Deferred.succeed(value.work, fiber)
          }
          yield* Deferred.succeed(value.filled, fiber)
        }),
      worker: (fiber: Fiber.Fiber<string, unknown>, request: Effect.Effect<Effect.Effect<boolean>>) =>
        Effect.gen(function* () {
          if (!worker || value.working) throw refuse()
          value.working = true
          value.cancel = request.pipe(
            Effect.flatMap((wait) => wait),
            Effect.asVoid,
          )
          // The root can retire before this real inner work is attached. Signal
          // its original control now, but never await done from inside run's
          // attachment callback: that callback itself precedes done.
          if (value.stopping || !held.root.alive) {
            yield* request
            return
          }
          yield* Deferred.succeed(value.work, fiber)
        }),
      abandon: Effect.sync(() => {
        if (!value.attached) {
          value.attached = true
          Deferred.doneUnsafe(value.filled, Effect.succeed(undefined))
        }
      }),
      run: <A, E, R>(body: Effect.Effect<A, E, R>) =>
        Effect.withFiber((fiber) =>
          Effect.gen(function* () {
            if (value.started) throw refuse()
            value.started = true
            if ((yield* Deferred.await(value.work)) !== fiber) throw refuse()
            yield* Deferred.await(value.filled)
            yield* fresh()
            const state: State = { root: held.root, fiber, alive: true, session }
            return yield* Effect.provideService(body, Current, mint(state)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  state.alive = false
                }),
              ),
            )
          }),
        ),
    })
  })
}

/** An interruption cannot escape between reservation and installing cleanup.
 * A no-fork return closes the unstarted slot; it claims no original join. */
export function launch<A, E, R>(
  token: Lease | undefined,
  session: string,
  body: (original: Effect.Success<ReturnType<typeof producer>>) => Effect.Effect<A, E, R>,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const original = yield* producer(token, session, Effect.void, true)
      return yield* restore(body(original)).pipe(Effect.ensuring(original?.abandon ?? Effect.void))
    }),
  )
}

/** Notification lifetimes are distinct from Core worker settlement. Cancellation
 * targets this exact reserved Session producer, never the current parent turn. */
export function scoped<A, E, R, B, E2, R2>(
  token: Lease | undefined,
  session: string,
  body: Effect.Effect<A, E, R>,
  scope: Scope.Scope,
  fallback: (cause: Cause.Cause<E>) => Effect.Effect<B, E2, R2>,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const original = yield* producer(token, session, Effect.void)
      const fiber = yield* SessionRetirement.scoped(
        original ? original.run(restore(body)).pipe(Effect.asVoid) : restore(body).pipe(Effect.asVoid),
        scope,
        (cause) => fallback(cause).pipe(Effect.asVoid),
      ).pipe(
        Effect.flatMap((fiber) =>
          Effect.gen(function* () {
            if (!original) return fiber
            const attached = yield* Effect.exit(original.attach(fiber))
            if (Exit.isSuccess(attached)) return fiber
            const stopped = yield* Effect.exit(
              SessionRetirement.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))),
            )
            const cause = Exit.isFailure(stopped)
              ? stopped.cause
              : Exit.isFailure(stopped.value) && !Cause.hasInterruptsOnly(stopped.value.cause)
                ? stopped.value.cause
                : undefined
            return yield* Effect.failCause(cause ? Cause.combine(attached.cause, cause) : attached.cause)
          }),
        ),
        Effect.ensuring(original?.abandon ?? Effect.void),
      )
      return fiber
    }),
  )
}
