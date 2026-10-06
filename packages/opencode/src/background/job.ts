import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"
import * as Lineage from "@opencode-ai/core/kilocode/background-lineage" // kilocode_change

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    // kilocode_change start - keep local observations while sharing one service-owned execution tree
    const lineage = yield* Lineage.make
    const state = yield* InstanceState.make(() =>
      CoreBackgroundJob.make.pipe(Effect.provideService(Lineage.Service, lineage)),
    )
    // kilocode_change end
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      cancel: (id, revision) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id, revision)), // kilocode_change
      // kilocode_change start
      cancelTree: (id, revision) => InstanceState.useEffect(state, (jobs) => jobs.cancelTree(id, revision)),
      cancelInput: (id, revision, message) =>
        InstanceState.useEffect(state, (jobs) => jobs.cancelInput(id, revision, message)),
      // kilocode_change end
    })
  }),
)

export const node = LayerNode.make({ service: CoreBackgroundJob.Service, layer, deps: [] })

export * as BackgroundJob from "./job"
