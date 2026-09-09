// raya_change - Milestone F workspace-isolated browser host bridge
import { Bus } from "@/bus"
import { InstanceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import { Identifier } from "@/id/id"
import { capture } from "@/kilocode/instance"
import { Context, Deferred, Duration, Effect, Layer, LayerMap, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ErrorCode, Event, type Failure, type Request, RequestID, type Result } from "./protocol"
import { UploadStage } from "./upload-stage"

const log = Log.create({ service: "browser-host" })
type WithoutID<T> = T extends unknown ? Omit<T, "id"> : never
export type Input = WithoutID<Request>

export class HostError extends Schema.TaggedErrorClass<HostError>()("BrowserHostError", {
  code: ErrorCode,
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Browser.NotFoundError", {
  requestID: RequestID,
}) {}

export class InvalidReplyError extends Schema.TaggedErrorClass<InvalidReplyError>()("Browser.InvalidReplyError", {
  requestID: RequestID,
}) {}

interface Entry {
  info: Request
  deferred: Deferred.Deferred<Result, HostError>
}
interface State {
  pending: Map<RequestID, Entry>
  dispose: () => Effect.Effect<void>
}

class StateService extends Context.Service<StateService, State>()("@kilocode/BrowserState") {}

const context = Effect.gen(function* () {
  const ctx = (yield* InstanceRef) ?? capture()
  if (!ctx) return yield* Effect.die(new Error("Instance context not provided"))
  return ctx
})

export interface Interface {
  readonly request: (input: Input) => Effect.Effect<Result, HostError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly cancelSession: (sessionID: Request["sessionID"]) => Effect.Effect<void>
  readonly reply: (input: {
    requestID: RequestID
    result: Result
  }) => Effect.Effect<void, NotFoundError | InvalidReplyError>
  readonly reject: (input: { requestID: RequestID; error: Failure }) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/Browser") {}

export function layer(timeout: Duration.Input = "2 minutes") {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const stop = new UploadStage().watch()
      yield* Effect.addFinalizer(() => Effect.sync(stop))
      const states = new Map<string, State>()
      const stateLayer = (directory: string) =>
        Layer.effect(
          StateService,
          Effect.gen(function* () {
            const instance = (yield* InstanceRef) ?? capture()
            if (!instance) return yield* Effect.die(new Error("Instance context not provided"))
            const pending = new Map<RequestID, Entry>()
            const dispose = Effect.fn("Browser.dispose")(function* () {
              const entries = Array.from(pending.values())
              pending.clear()
              for (const entry of entries) {
                yield* bus
                  .publish(Event.Cancelled, {
                    requestID: entry.info.id,
                    sessionID: entry.info.sessionID,
                    reason: "disposed" as const,
                  })
                  .pipe(Effect.provideService(InstanceRef, instance))
                yield* Deferred.fail(
                  entry.deferred,
                  new HostError({ code: "disconnected", detail: "The browser host disconnected" }),
                )
              }
            })
            const state: State = { pending, dispose }
            states.set(directory, state)
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (states.get(directory) === state) states.delete(directory)
                yield* state.dispose()
              }),
            )
            return StateService.of(state)
          }),
        )
      const map = yield* LayerMap.make((directory: string) => stateLayer(directory), { idleTimeToLive: "10 minutes" })
      const off = registerDisposer((directory) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const state = states.get(directory)
            yield* map.invalidate(directory)
            if (state) {
              yield* state.dispose()
              if (states.get(directory) === state) states.delete(directory)
            }
          }),
        ),
      )
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const use = <A, E>(effect: Effect.Effect<A, E, StateService>): Effect.Effect<A, E> =>
        Effect.gen(function* () {
          const ctx = yield* context
          return yield* effect.pipe(Effect.provide(map.get(ctx.directory)))
        }).pipe(Effect.scoped)

      const cancel = Effect.fn("Browser.cancel")(function* (id: RequestID, reason: "cancelled" | "timeout") {
        const pending = (yield* StateService).pending
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        yield* bus.publish(Event.Cancelled, { requestID: id, sessionID: entry.info.sessionID, reason })
        yield* Deferred.fail(
          entry.deferred,
          new HostError({
            code: reason,
            detail: reason === "timeout" ? "The browser host request timed out" : "The browser request was cancelled",
          }),
        )
      })

      const request = Effect.fn("Browser.request")(function* (input: Input) {
        const pending = (yield* StateService).pending
        const id = RequestID.make(Identifier.create("brr", "ascending"))
        const deferred = yield* Deferred.make<Result, HostError>()
        const info = { ...input, id } as Request
        pending.set(id, { info, deferred })
        return yield* Effect.gen(function* () {
          yield* bus.publish(Event.Requested, info)
          return yield* Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => cancel(id, "timeout").pipe(Effect.andThen(Deferred.await(deferred))),
            }),
          )
        }).pipe(Effect.ensuring(cancel(id, "cancelled")))
      })

      const list = Effect.fn("Browser.list")(function* () {
        return Array.from((yield* StateService).pending.values(), (entry) => entry.info)
      })

      const cancelSession = Effect.fn("Browser.cancelSession")(function* (sessionID: Request["sessionID"]) {
        const pending = (yield* StateService).pending
        const ids = Array.from(pending.values())
          .filter((entry) => entry.info.sessionID === sessionID)
          .map((entry) => entry.info.id)
        yield* Effect.forEach(ids, (id) => cancel(id, "cancelled"), { discard: true })
      })

      const reply = Effect.fn("Browser.reply")(function* (input: Parameters<Interface["reply"]>[0]) {
        const pending = (yield* StateService).pending
        const entry = pending.get(input.requestID)
        if (!entry) {
          log.warn("reply for unknown request", { requestID: input.requestID })
          return yield* new NotFoundError({ requestID: input.requestID })
        }
        if (entry.info.operation !== input.result.operation)
          return yield* new InvalidReplyError({ requestID: input.requestID })
        pending.delete(input.requestID)
        yield* Deferred.succeed(entry.deferred, input.result)
      })

      const reject = Effect.fn("Browser.reject")(function* (input: Parameters<Interface["reject"]>[0]) {
        const pending = (yield* StateService).pending
        const entry = pending.get(input.requestID)
        if (!entry) {
          log.warn("rejection for unknown request", { requestID: input.requestID })
          return yield* new NotFoundError({ requestID: input.requestID })
        }
        pending.delete(input.requestID)
        yield* Deferred.fail(entry.deferred, new HostError({ code: input.error.code, detail: input.error.message }))
      })

      return Service.of({
        request: (input) => use(request(input)),
        list: () => use(list()),
        cancelSession: (sessionID) => use(cancelSession(sessionID)),
        reply: (input) => use(reply(input)),
        reject: (input) => use(reject(input)),
      })
    }),
  )
}

export const defaultLayer = layer().pipe(Layer.provide(Bus.layer))
export const node = LayerNode.make({ service: Service, layer: layer(), deps: [Bus.node] })
export * as Browser from "./service"
