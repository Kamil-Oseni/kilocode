import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import path from "path"
import { Context, Effect, Layer, Semaphore } from "effect"

export interface Interface {
  readonly withWorkspace: (directory: string) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withWorkspaces: (
    directories: readonly string[],
  ) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** Session deletion and checkpoint mutations share one process- and workspace-wide lifecycle boundary. */
export class Service extends Context.Service<Service, Interface>()("@raya/ReviewGate") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const gate = yield* Semaphore.make(1)
      const flock = yield* EffectFlock.Service
      const withWorkspaces =
        (directories: readonly string[]) =>
        <A, E, R>(body: Effect.Effect<A, E, R>) => {
          const keys = [
            ...new Set(
              directories.map((directory) => {
                const resolved = path.resolve(directory)
                return process.platform === "win32" ? resolved.toLowerCase() : resolved
              }),
            ),
          ].sort()
          return gate.withPermits(1)(
            Effect.scoped(
              Effect.gen(function* () {
                // One scoped acquisition releases every earlier lock if a later lock fails.
                // Sorting prevents opposing workspace orders from deadlocking across backends.
                for (const key of keys) yield* flock.acquire(`review:${key}`)
                return yield* body
              }),
            ).pipe(
              Effect.catchTag("LockTimeoutError", Effect.die),
              Effect.catchTag("LockCompromisedError", Effect.die),
            ),
          )
        }
      return Service.of({ withWorkspace: (directory) => withWorkspaces([directory]), withWorkspaces })
    }),
  ),
  deps: [EffectFlock.node],
})

export * as ReviewGate from "./review-gate"
