import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Layer, Semaphore } from "effect"

/** Session deletion and checkpoint mutations share one backend-local lifecycle boundary. */
export class Service extends Context.Service<Service, Semaphore.Semaphore>()("@raya/ReviewGate") {}

export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, Semaphore.make(1)),
  deps: [],
})

export * as ReviewGate from "./review-gate"
