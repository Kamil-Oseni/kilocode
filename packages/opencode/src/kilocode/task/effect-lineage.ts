import { AsyncLocalStorage } from "node:async_hooks"
import { Context, Effect } from "effect"
import { RayaTaskExecution } from "./execution"

/** Original execution lineage only; never a qualified native effect capability. */
type Root = { alive: boolean; original: NonNullable<ReturnType<typeof RayaTaskExecution.original>> }
const opaque = Symbol("Original execution frame")
type Frame = Readonly<{ [opaque]: true }>
type State = { root: Root; fiber: unknown; alive: boolean }
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

export function own<A, E, R>(permit: unknown, body: Effect.Effect<A, E, R>) {
  return Effect.withFiber((fiber) => {
    const original = RayaTaskExecution.original(permit, fiber)
    if (!original) return Effect.die(refuse())
    const root: Root = { alive: true, original }
    const state: State = { root, fiber, alive: true }
    const frame = mint(state)
    return Effect.provideService(body, Current, frame).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.alive = false
          root.alive = false
        }),
      ),
    )
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
      if (original.root.original.sessionID !== session) return Effect.die(refuse())
      held.used = true
      const state: State = { root: original.root, fiber, alive: true }
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
      return original.runID === run.id && original.agentID === run.agentID && original.sessionID === run.sessionID
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
      if (held.root.original.sessionID !== session) return Effect.die(refuse())
      const state: State = { root: held.root, fiber, alive: true }
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
