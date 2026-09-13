import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import path from "path"
import { Context, Effect, Layer, Semaphore } from "effect"

export interface Interface {
  readonly withWorkspace: (directory: string) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
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
      const withWorkspace =
        (directory: string) =>
        <A, E, R>(body: Effect.Effect<A, E, R>) => {
          const resolved = path.resolve(directory)
          const key = process.platform === "win32" ? resolved.toLowerCase() : resolved
          return gate.withPermits(1)(
            flock.withLock(body, `review:${key}`).pipe(
              Effect.catchTag("LockTimeoutError", Effect.die),
              Effect.catchTag("LockCompromisedError", Effect.die),
            ),
          )
        }
      return Service.of({ withWorkspace })
    }),
  ),
  deps: [EffectFlock.node],
})

export * as ReviewGate from "./review-gate"
