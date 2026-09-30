import { Layer, type Context, ManagedRuntime, type Effect } from "effect"
import { memoMap } from "./memo-map"
import { Observability } from "../observability"
import { runtimeOwner } from "../kilocode/runtime-owner" // kilocode_change

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) {
  // kilocode_change start - retain outer ownership and fence lazy acquisition before disposal
  const owner = runtimeOwner(() =>
    ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer) as Layer.Layer<I, E>, { memoMap }),
  )
  const getRuntime = owner.get
  // kilocode_change end

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(service.use(fn)),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(service.use(fn), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(service.use(fn), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(service.use(fn)),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runCallback(service.use(fn)),
    dispose: owner.dispose, // kilocode_change - exact scopes settle before the outer owner receives completion
  }
}
