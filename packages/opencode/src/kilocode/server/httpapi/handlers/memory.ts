import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { MemoryError } from "@kilocode/kilo-memory/effect/errors"
import { MemoryContract } from "@kilocode/kilo-memory/effect/httpapi"
import { MemoryService } from "@kilocode/kilo-memory/effect/service"
import { KiloToolRegistry } from "@/kilocode/tool/registry"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Provider } from "@/provider/provider"
import { generate } from "@/kilocode/memory/dream-generation"
import { inspect, track, type Records } from "@/kilocode/memory/dream-tracking"
import { disconnect } from "@/kilocode/server/sse"
import {
  MemoryConfigurePayload,
  MemoryCorrectPayload,
  MemoryForgetPayload,
  MemoryPurgePayload,
  MemoryQuery,
  MemoryRememberPayload,
} from "../groups/memory"

function api<T>(effect: Effect.Effect<T, MemoryError>) {
  return effect.pipe(Effect.mapError(MemoryError.toHttp))
}

function invalidate<T extends { root: string }>(input: T) {
  KiloToolRegistry.invalidateMemoryEnabled(input.root)
  return input
}

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* MemoryService.Service
    const provider = yield* Provider.Service
    const dreams = yield* InstanceState.make(() => Effect.sync((): Records => new Map()))
    const dreamGenerate = Effect.fn("MemoryHttpApi.dreamGenerate")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryContract.DreamGeneratePayload.Type
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const records = yield* InstanceState.get(dreams)
      return yield* api(
        track(
          records,
          req.payload,
          generate(provider, req.payload).pipe(
            Effect.timeout(req.payload.timeoutMs),
            Effect.mapError(MemoryError.from),
            Effect.raceFirst(disconnect(request).pipe(Effect.andThen(Effect.interrupt))),
          ),
        ),
      )
    })
    const dreamInspect = Effect.fn("MemoryHttpApi.dreamInspect")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryContract.DreamInspectPayload.Type
    }) {
      return yield* api(inspect(yield* InstanceState.get(dreams), req.payload))
    })
    const status = Effect.fn("MemoryHttpApi.status")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return MemoryContract.output(yield* api(svc.status({ ctx })))
    })

    const show = Effect.fn("MemoryHttpApi.show")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return MemoryContract.output(yield* api(svc.show({ ctx })))
    })

    const enable = Effect.fn("MemoryHttpApi.enable")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return MemoryContract.output(invalidate(yield* api(svc.enable({ ctx }))))
    })

    const disable = Effect.fn("MemoryHttpApi.disable")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return MemoryContract.output(invalidate(yield* api(svc.disable({ ctx }))))
    })

    const configure = Effect.fn("MemoryHttpApi.configure")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryConfigurePayload.Type
    }) {
      const ctx = yield* InstanceState.context
      return MemoryContract.output(
        yield* api(
          svc.configure({
            ctx,
            settings: { autoConsolidate: req.payload.autoConsolidate, verbose: req.payload.verbose },
          }),
        ),
      )
    })

    const rebuild = Effect.fn("MemoryHttpApi.rebuild")(function* (req: { query: typeof MemoryQuery.Type }) {
      const ctx = yield* InstanceState.context
      return MemoryContract.output(yield* api(svc.rebuild({ ctx })))
    })

    const remember = Effect.fn("MemoryHttpApi.remember")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryRememberPayload.Type
    }) {
      const state = yield* InstanceState.context
      return MemoryContract.operation(
        yield* api(
          svc.remember({
            ctx: state,
            sessionID: req.payload.sessionID,
            file: req.payload.file,
            section: req.payload.section,
            key: req.payload.key,
            text: req.payload.text,
          }),
        ),
      )
    })

    const correct = Effect.fn("MemoryHttpApi.correct")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryCorrectPayload.Type
    }) {
      const state = yield* InstanceState.context
      return MemoryContract.operation(
        yield* api(
          svc.correct({
            ctx: state,
            sessionID: req.payload.sessionID,
            key: req.payload.key,
            text: req.payload.text,
          }),
        ),
      )
    })

    const forget = Effect.fn("MemoryHttpApi.forget")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryForgetPayload.Type
    }) {
      const state = yield* InstanceState.context
      return MemoryContract.operation(
        yield* api(svc.forget({ ctx: state, query: req.payload.query, sessionID: req.payload.sessionID })),
      )
    })

    const purge = Effect.fn("MemoryHttpApi.purge")(function* (req: {
      query: typeof MemoryQuery.Type
      payload: typeof MemoryPurgePayload.Type
    }) {
      const ctx = yield* InstanceState.context
      return invalidate(yield* api(svc.purge({ ctx })))
    })

    return handlers
      .handle("dreamGenerate", dreamGenerate)
      .handle("dreamInspect", dreamInspect)
      .handle("status", status)
      .handle("show", show)
      .handle("enable", enable)
      .handle("disable", disable)
      .handle("configure", configure)
      .handle("rebuild", rebuild)
      .handle("remember", remember)
      .handle("correct", correct)
      .handle("forget", forget)
      .handle("purge", purge)
  }),
)
