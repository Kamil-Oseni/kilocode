import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Execution } from "@/kilocode/effect/observation"
import type { MessageID, SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"

type Input = { sessionID: SessionID; messageID: MessageID }
type Runs = Pick<SessionRunState.Interface, "inspect" | "requestCancel">
const key = (sessionID: SessionID, messageID: MessageID) => JSON.stringify([sessionID, messageID])

export const make = (runs: Runs) =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make({ bindings: new Map<string, Input>(), cancelled: new Set<string>() })
    const stop = (sessionID: SessionID, messages: readonly MessageID[]) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        Effect.gen(function* () {
          const wanted = new Set(messages)
          // Retain intent even when cancellation wins the race with prompt startup.
          const cancelled = new Set(current.cancelled)
          for (const message of wanted) cancelled.add(key(sessionID, message))
          const next = { ...current, cancelled }
          const observed = yield* runs.inspect(sessionID)
          const binding = observed.id ? current.bindings.get(observed.id) : undefined
          if (
            observed.phase !== "running" ||
            !observed.id ||
            binding?.sessionID !== sessionID ||
            !wanted.has(binding.messageID)
          )
            return [Effect.succeed(false), next] as const
          // Selection starts cleanup in the runner scope. Release this lock before awaiting it.
          const wait = yield* runs.requestCancel(sessionID, observed.id)
          return [wait, next] as const
        }),
      ).pipe(Effect.uninterruptible, Effect.flatten)
    return {
      stop,
      bind: (sessionID: SessionID, messageID: MessageID) =>
        Effect.gen(function* () {
          const execution = yield* Effect.serviceOption(Execution)
          if (execution._tag === "None") return false
          return yield* SynchronizedRef.modifyEffect(state, (current) =>
            Effect.gen(function* () {
              if (current.cancelled.has(key(sessionID, messageID))) return [false, current] as const
              const observed = yield* runs.inspect(sessionID)
              if (observed.phase !== "running" || observed.id !== execution.value.id) return [false, current] as const
              return [
                true,
                { ...current, bindings: new Map(current.bindings).set(execution.value.id, { sessionID, messageID }) },
              ] as const
            }),
          )
        }),
      release: Effect.gen(function* () {
        const execution = yield* Effect.serviceOption(Execution)
        if (execution._tag === "None") return
        yield* SynchronizedRef.update(state, (current) => {
          const bindings = new Map(current.bindings)
          bindings.delete(execution.value.id)
          return { ...current, bindings }
        })
      }),
      cancel: (sessionID: SessionID, messageID: MessageID) => stop(sessionID, [messageID]),
    }
  })

const scoped = (runs: Runs) =>
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => make(runs))
    return {
      stop: (sessionID: SessionID, messages: readonly MessageID[]) =>
        InstanceState.useEffect(state, (workers) => workers.stop(sessionID, messages)),
      bind: (sessionID: SessionID, messageID: MessageID) =>
        InstanceState.useEffect(state, (workers) => workers.bind(sessionID, messageID)),
      cancel: (sessionID: SessionID, messageID: MessageID) =>
        InstanceState.useEffect(state, (workers) => workers.cancel(sessionID, messageID)),
      release: InstanceState.useEffect(state, (workers) => workers.release),
    }
  })

export type Interface = Effect.Success<ReturnType<typeof scoped>>
export class Service extends Context.Service<Service, Interface>()("raya/TaskWorker") {}
export const node = LayerNode.make({
  service: Service,
  layer: Layer.effect(Service, Effect.flatMap(SessionRunState.Service, scoped)),
  deps: [SessionRunState.node],
})
