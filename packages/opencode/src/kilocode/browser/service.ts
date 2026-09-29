// raya_change - Milestone F workspace-isolated browser host bridge
import { Bus } from "@/bus"
import { InstanceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import { Identifier } from "@/id/id"
import { Receipt } from "@/kilocode/computer-use/protocol"
import { capture } from "@/kilocode/instance"
import { Context, Deferred, Duration, Effect, Layer, LayerMap, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ErrorCode, Event, type Failure, type Request, RequestID, type Result } from "./protocol"
import { UploadStage } from "./upload-stage"
import {
  confirmations,
  type Proof as ProofSchema,
  type Completion as CompletionSchema,
  type Admission as AdmissionSchema,
  type Dispatch as DispatchSchema,
  type Acknowledgement as AcknowledgementSchema,
  Conflict,
} from "./confirmation"
import { check } from "./origin"
import { Storage } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"

const log = Log.create({ service: "browser-host" })
type WithoutID<T> = T extends unknown ? Omit<T, "id" | "confirmation"> : never
export type Input = WithoutID<Request>
/** Version 1 binds semantic JSON content, independent of schema/object property order. */
export function digest(value: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item
        return Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        )
      }),
    )
    .digest("hex")
}
export type Origin = { messageID: string; callID?: string; tool: string; supported?: 1 }
type Proof = typeof ProofSchema.Type
type Completion = typeof CompletionSchema.Type
type Admission = typeof AdmissionSchema.Type
type Dispatch = typeof DispatchSchema.Type
type Acknowledgement = typeof AcknowledgementSchema.Type
export type Confirmation = {
  version: 1
  proof: Proof
  granted: false
  pending: boolean
  dispatch?: Dispatch
  completion?: Completion
  acknowledgement?: Acknowledgement
}

export class HostError extends Schema.TaggedErrorClass<HostError>()("BrowserHostError", {
  code: ErrorCode,
  detail: Schema.String,
  receipt: Schema.optional(Receipt),
}) {
  override get message() {
    if (this.receipt?.outcome === "unknown")
      return `${this.detail}\nThe browser request may already have affected the destination. Do not automatically retry it. Inspect the destination first and ask the user if the result cannot be verified safely.`
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
  readonly request: (input: Input, origin?: Origin) => Effect.Effect<Result, HostError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly cancelSession: (sessionID: Request["sessionID"]) => Effect.Effect<void>
  readonly reply: (input: {
    requestID: RequestID
    result: Result
  }) => Effect.Effect<void, NotFoundError | InvalidReplyError>
  readonly reject: (input: { requestID: RequestID; error: Failure }) => Effect.Effect<void, NotFoundError>
  readonly dispatch: (input: {
    requestID: RequestID
    proof: Proof
    invocation: string
  }) => Effect.Effect<{ granted: boolean; dispatch: Dispatch }, Conflict>
  readonly confirm: (input: {
    requestID: RequestID
    proof: Proof
    completion: Completion
  }) => Effect.Effect<Completion, Conflict>
  readonly confirmation: (input: { requestID: RequestID; proof: Proof }) => Effect.Effect<Confirmation, Conflict>
  readonly acknowledge: (input: {
    requestID: RequestID
    proof: Proof
    ack: string
  }) => Effect.Effect<Acknowledgement, Conflict>
}

export class Service extends Context.Service<Service, Interface>()("@kilocode/Browser") {}

export function layer(timeout: Duration.Input = "2 minutes") {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const storage = yield* Storage.Service
      const flock = yield* EffectFlock.Service
      const database = yield* Database.Service
      const global = yield* Global.Service
      const ledger = confirmations(storage, { flock, directory: path.join(global.data, "browser-confirmation-locks") })
      const origin = (admission: Admission, directory: string, live: boolean) =>
        check(admission, directory, live).pipe(Effect.provideService(Database.Service, database))
      const hash = (value: string) => createHash("sha256").update(value).digest("hex")
      const scope = (directory: string) =>
        hash(process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory))
      const eligible = (admission: Admission) =>
        Effect.gen(function* () {
          if ([...states.values()].some((state) => state.pending.has(admission.requestID as RequestID))) return false
          const ctx = yield* context
          if (admission.proof.scope !== scope(ctx.directory)) return false
          const part = yield* origin(admission, ctx.directory, false)
          return Boolean(part) && !(yield* origin(admission, ctx.directory, true))
        })
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

      const request = Effect.fn("Browser.request")(function* (input: Input, owner?: Origin) {
        const pending = (yield* StateService).pending
        const id = RequestID.make(Identifier.create("brr", "ascending"))
        const deferred = yield* Deferred.make<Result, HostError>()
        const ctx = yield* context
        const admission =
          input.operation === "authorize"
            ? undefined
            : yield* Effect.gen(function* () {
                if (!owner?.callID || owner.supported !== 1)
                  return yield* new HostError({
                    code: "invalid_request",
                    detail: "Browser request is missing canonical tool identity or durable host support",
                  })
                const part = yield* check(
                  { ...owner, callID: owner.callID, sessionID: input.sessionID },
                  ctx.directory,
                  true,
                ).pipe(Effect.provideService(Database.Service, database))
                if (!part)
                  return yield* new HostError({
                    code: "invalid_request",
                    detail: "Browser request does not match a live canonical tool",
                  })
                return yield* ledger
                  .reserve(
                    {
                      version: 1,
                      requestID: id,
                      scope: scope(ctx.directory),
                      digest: digest(input),
                      sessionID: input.sessionID,
                      messageID: owner.messageID,
                      callID: owner.callID,
                      partID: part,
                      tool: owner.tool,
                      operation: input.operation,
                      at: Date.now(),
                    },
                    eligible,
                  )
                  .pipe(
                    Effect.mapError(
                      () =>
                        new HostError({
                          code: "invalid_request",
                          detail: "Browser safety admission could not be retained; no request was dispatched",
                        }),
                    ),
                  )
              })
        const info = { ...input, id, ...(admission ? { confirmation: admission.proof } : {}) } as Request
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
        if ("confirmation" in entry.info && entry.info.confirmation) {
          const value = yield* ledger
            .read(entry.info.confirmation)
            .pipe(Effect.mapError(() => new InvalidReplyError({ requestID: input.requestID })))
          const completion = value.completion
          const evidence = "receipt" in input.result ? input.result.receipt : undefined
          if (
            !completion ||
            completion.outcome !== "confirmed" ||
            completion.resultDigest !== digest(input.result) ||
            completion.startedAt !== evidence?.startedAt ||
            completion.finishedAt !== evidence?.finishedAt
          )
            return yield* new InvalidReplyError({ requestID: input.requestID })
          if (pending.get(input.requestID) !== entry) return yield* new NotFoundError({ requestID: input.requestID })
        }
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
        yield* Deferred.fail(
          entry.deferred,
          new HostError({ code: input.error.code, detail: input.error.message, receipt: input.error.receipt }),
        )
      })

      const retained = Effect.fn("Browser.retained")(function* (input: { requestID: RequestID; proof: Proof }) {
        const ctx = yield* context
        if (input.proof.scope !== scope(ctx.directory))
          return yield* new Conflict({ message: "Browser confirmation scope changed" })
        const value = yield* ledger.read(input.proof)
        if (value.admission.requestID !== input.requestID || !(yield* origin(value.admission, ctx.directory, false)))
          return yield* new Conflict({ message: "Browser confirmation canonical identity changed" })
        return value
      })
      const dispatch = Effect.fn("Browser.dispatch")(function* (input: Parameters<Interface["dispatch"]>[0]) {
        const pending = (yield* StateService).pending
        const entry = pending.get(input.requestID)
        const value = yield* retained(input)
        const ctx = yield* context
        if (!entry || !(yield* origin(value.admission, ctx.directory, true)) || pending.get(input.requestID) !== entry)
          return yield* new Conflict({ message: "Browser dispatch has no live canonical request" })
        const result = yield* ledger.dispatch(input.proof, input.invocation)
        if (pending.get(input.requestID) !== entry || !(yield* origin(value.admission, ctx.directory, true))) {
          if (result.granted) {
            const at = Math.max(Date.now(), value.admission.at)
            const completion = yield* ledger.confirm(input.proof, {
              version: 1,
              identity: input.proof.identity,
              invocation: input.invocation,
              ack: randomUUID(),
              requestID: input.requestID,
              operation: value.admission.operation,
              outcome: "cancelled",
              startedAt: at,
              finishedAt: at,
            })
            yield* ledger.acknowledge(input.proof, { ack: completion.ack })
          }
          return yield* new Conflict({
            message: "Browser request was cancelled before dispatch ownership was returned",
          })
        }
        return result
      })
      const confirm = Effect.fn("Browser.confirm")(function* (input: Parameters<Interface["confirm"]>[0]) {
        yield* retained(input)
        return yield* ledger.confirm(input.proof, input.completion)
      })
      const confirmation = Effect.fn("Browser.confirmation")(function* (
        input: Parameters<Interface["confirmation"]>[0],
      ) {
        const value = yield* retained(input)
        return {
          version: 1 as const,
          proof: value.admission.proof,
          granted: false as const,
          pending: [...states.values()].some((state) => state.pending.has(input.requestID)),
          ...(value.dispatch ? { dispatch: value.dispatch } : {}),
          ...(value.completion ? { completion: value.completion } : {}),
          ...(value.acknowledgement ? { acknowledgement: value.acknowledgement } : {}),
        }
      })
      const acknowledge = Effect.fn("Browser.acknowledge")(function* (input: Parameters<Interface["acknowledge"]>[0]) {
        yield* retained(input)
        return yield* ledger.acknowledge(input.proof, { ack: input.ack })
      })

      return Service.of({
        request: (input, origin) => use(request(input, origin)),
        list: () => use(list()),
        cancelSession: (sessionID) => use(cancelSession(sessionID)),
        reply: (input) => use(reply(input)),
        reject: (input) => use(reject(input)),
        dispatch: (input) => use(dispatch(input)),
        confirm: (input) => use(confirm(input)),
        confirmation: (input) => use(confirmation(input)),
        acknowledge: (input) => use(acknowledge(input)),
      })
    }),
  )
}

export const defaultLayer = layer().pipe(
  Layer.provide(
    Layer.mergeAll(
      Bus.layer,
      AppNodeBuilder.build(Storage.node),
      AppNodeBuilder.build(Database.node),
      AppNodeBuilder.build(EffectFlock.node),
      AppNodeBuilder.build(Global.node),
    ),
  ),
)
export const node = LayerNode.make({
  service: Service,
  layer: layer(),
  deps: [Bus.node, Storage.node, Database.node, EffectFlock.node, Global.node],
})
export * as Browser from "./service"
