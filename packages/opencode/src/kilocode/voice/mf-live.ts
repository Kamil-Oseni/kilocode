import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type * as OpenAI from "./openai"
import { OpenAIBinding, OpenAIReservation } from "./openai-protocol"
import { LiveDuration } from "./live-protocol"
import type { Envelope, Info } from "./protocol"

export type Service = Pick<
  Effect.Success<ReturnType<typeof OpenAI.make>>,
  "start" | "settle" | "duration" | "close" | "reserve" | "release"
>
export type State = {
  secret: string
  phase?: "reserving" | "reserved" | "binding" | "bound" | "failed"
  admission?: typeof OpenAIReservation.Type
  binding?: typeof OpenAIBinding.Type
  last?: number
  hash?: string
  accepted?: boolean
  usage?: typeof LiveDuration.Type
  running?: typeof LiveDuration.Type
  setup?: { provider: string; started: { event_id: string; model: "gpt-live-1" }; final?: Final }
}
type Final = { event_id: string; model: "gpt-live-1"; reason: string; usage: { seconds: number } }
type Entry = { info: typeof Info.Type; directory: string; live?: State }

export const reserve = Effect.fn("RayaVoice.Live.reserve")(function* (
  entry: Entry,
  service: Service,
  save: () => Effect.Effect<void>,
) {
  const state = entry.live!
  state.phase = "reserving"
  yield* save()
  const admission = yield* service.reserve(
    { parentSessionID: entry.info.parentSessionID, requestID: entry.info.id, model: "gpt-live-1" },
    state.secret,
    entry.directory,
  )
  if (
    !Schema.is(OpenAIReservation)(admission) ||
    admission.status !== "reserved" ||
    admission.requestID !== entry.info.id ||
    admission.model !== "gpt-live-1"
  ) {
    state.phase = "failed"
    yield* save()
    return false
  }
  state.admission = admission
  state.phase = "reserved"
  if (
    !Number.isFinite(admission.maximumSeconds) ||
    admission.maximumSeconds === undefined ||
    admission.maximumSeconds <= 1.4 ||
    admission.maximumSeconds > 86_400
  ) {
    yield* save()
    return false
  }
  entry.info = { ...entry.info, maximumSeconds: admission.maximumSeconds }
  yield* save()
  return true
})

/** MF transport events have authority only under their own callback capability.
 * Caption text remains imperfect evidence; this foundation admits no Live work. */
export const event = Effect.fn("RayaVoice.Live.event")(function* (
  entry: Entry,
  input: typeof Envelope.Type,
  service: Service | undefined,
  save: () => Effect.Effect<void>,
) {
  const state = entry.live
  if (!state || !service || !/^[a-f0-9]{64}$/.test(state.secret) || !entry.directory) return false
  if (!Number.isSafeInteger(input.seq) || input.seq < 1 || input.event.seq !== input.seq) return false
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex")
  if (input.seq === state.last) return hash === state.hash && state.accepted === true
  if (
    state.last !== undefined &&
    (input.seq <= state.last ||
      (!["session.closed", "session.setup.closed"].includes(input.event.type) && input.seq !== state.last + 1))
  )
    return false
  if (state.phase === "failed" && input.event.type !== "session.setup.closed") return false
  const accepted = yield* input.event.type === "session.setup.closed"
    ? settlement(entry, input, service, save).pipe(Effect.catch(() => Effect.succeed(false)))
    : dispatch(entry, input, service, save)
  if (accepted || input.event.type === "session.delegation.created" || input.event.type === "delegation.request") {
    state.last = input.seq
    state.hash = hash
    state.accepted = accepted
  }
  return accepted
})

const settlement = Effect.fn("RayaVoice.Live.settlement")(function* (
  entry: Entry,
  input: typeof Envelope.Type,
  service: Service,
  save: () => Effect.Effect<void>,
) {
  const state = entry.live!
  const data = setup(input.event.data)
  const provider = input.event.session
  if (!data || !identity(provider)) return false
  if (state.binding && state.binding.providerCallID !== provider) return false
  if (!state.setup && !state.binding && state.phase !== "reserved") return false
  if (!admitted(entry)) return false
  if (
    state.usage &&
    (!data.final ||
      JSON.stringify(state.usage) !==
        JSON.stringify({
          id: data.final.event_id,
          model: data.final.model,
          seconds: data.final.usage.seconds,
        }))
  )
    return false
  if (
    state.setup &&
    (state.setup.provider !== provider ||
      JSON.stringify(state.setup.started) !== JSON.stringify(data.started) ||
      (state.setup.final && JSON.stringify(state.setup.final) !== JSON.stringify(data.final)))
  )
    return false
  state.setup = { provider, started: data.started, ...(data.final ? { final: data.final } : {}) }
  entry.info = { ...entry.info, status: entry.info.status === "closed" ? "closed" : "failed" }
  yield* save()
  const binding =
    state.binding ??
    (yield* service.settle(
      {
        parentSessionID: entry.info.parentSessionID,
        requestID: entry.info.id,
        providerCallID: provider,
        model: "gpt-live-1",
      },
      state.secret,
      entry.directory,
    ))
  if (
    !Schema.is(OpenAIBinding)(binding) ||
    binding.providerCallID !== provider ||
    binding.parentSessionID !== entry.info.parentSessionID ||
    binding.model !== "gpt-live-1"
  )
    return false
  state.binding = binding
  state.phase = "bound"
  yield* save()
  yield* service.close(binding.id, binding.generation, state.secret, entry.directory)
  if (!data.final) return true
  return yield* closed(entry, { ...input, event: { ...input.event, data: data.final } }, service)
})

function setup(value: unknown): { started: { event_id: string; model: "gpt-live-1" }; final?: Final } | undefined {
  const data = record(value)
  if (
    !data ||
    data.version !== 1 ||
    !keys(data, ["version", "started", ...(data.final === undefined ? [] : ["final"])])
  )
    return
  const started = record(data.started)
  if (
    !started ||
    !keys(started, ["event_id", "model"]) ||
    !identity(started.event_id) ||
    started.model !== "gpt-live-1"
  )
    return
  const base = { started: { event_id: started.event_id, model: "gpt-live-1" as const } }
  if (data.final === undefined) return base
  const final = record(data.final)
  const usage = record(final?.usage)
  if (
    !final ||
    !usage ||
    !keys(final, ["event_id", "model", "reason", "usage"]) ||
    !keys(usage, ["seconds"]) ||
    !identity(final.event_id) ||
    final.model !== "gpt-live-1" ||
    !reason(final.reason) ||
    typeof usage.seconds !== "number" ||
    !Number.isFinite(usage.seconds) ||
    usage.seconds < 0 ||
    usage.seconds > 86_400
  )
    return
  return {
    ...base,
    final: {
      event_id: final.event_id,
      model: "gpt-live-1" as const,
      reason: String(final.reason),
      usage: { seconds: usage.seconds },
    },
  }
}

function keys(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
}

function admitted(entry: Entry) {
  const admission = entry.live?.admission
  const seconds = entry.info.maximumSeconds
  return (
    !!admission &&
    admission.requestID === entry.info.id &&
    admission.model === "gpt-live-1" &&
    admission.status === "reserved" &&
    seconds === admission.maximumSeconds &&
    seconds !== undefined &&
    Number.isFinite(seconds) &&
    seconds > 1.4 &&
    seconds <= 86_400
  )
}

const dispatch = Effect.fn("RayaVoice.Live.dispatch")(function* (
  entry: Entry,
  input: typeof Envelope.Type,
  service: Service,
  save: () => Effect.Effect<void>,
) {
  const state = entry.live!
  if (input.event.type === "session.started") return yield* started(entry, input, service, save)
  if (!state.binding) return false
  if (input.event.type === "session.closed") return yield* closed(entry, input, service)
  if (entry.info.status === "closed" || entry.info.status === "failed") return false
  if (input.event.type === "session.delegation.created" || input.event.type === "delegation.request") {
    // Never route Live provider IDs through the legacy read-only child prompt.
    entry.info = { ...entry.info, status: "failed" }
    return false
  }
  if (input.event.type === "session.usage.updated") return running(state, input)
  if (input.event.type === "engine.error") entry.info = { ...entry.info, status: "failed" }
  return true
})

const started = Effect.fn("RayaVoice.Live.started")(function* (
  entry: Entry,
  input: typeof Envelope.Type,
  service: Service,
  save: () => Effect.Effect<void>,
) {
  const state = entry.live!
  const data = input.event.data
  if (
    entry.info.status === "closed" ||
    entry.info.status === "failed" ||
    !identity(input.event.session) ||
    data?.model !== "gpt-live-1"
  )
    return false
  if (state.binding) return state.binding.providerCallID === input.event.session
  if (state.phase !== "reserved" || !admitted(entry)) return false
  state.phase = "binding"
  yield* save()
  const bound = yield* service
    .start(
      {
        parentSessionID: entry.info.parentSessionID,
        requestID: entry.info.id,
        providerCallID: input.event.session,
        model: "gpt-live-1",
      },
      state.secret,
      entry.directory,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (
    !bound ||
    !Schema.is(OpenAIBinding)(bound) ||
    bound.providerCallID !== input.event.session ||
    bound.parentSessionID !== entry.info.parentSessionID ||
    bound.model !== "gpt-live-1"
  ) {
    state.phase = "failed"
    return false
  }
  state.binding = bound
  state.phase = "bound"
  entry.info = { ...entry.info, status: "active" }
  return true
})

const closed = Effect.fn("RayaVoice.Live.closed")(function* (
  entry: Entry,
  input: typeof Envelope.Type,
  service: Service,
) {
  const state = entry.live!
  const data = input.event.data
  const binding = state.binding
  const usage = record(data?.usage)
  const receipt = { id: data?.event_id, model: data?.model, seconds: usage?.seconds }
  if (
    !binding ||
    input.event.session !== binding.providerCallID ||
    !Schema.is(LiveDuration)(receipt) ||
    !Number.isFinite(receipt.seconds) ||
    !reason(data?.reason)
  )
    return false
  if (state.usage && JSON.stringify(state.usage) !== JSON.stringify(receipt)) return false
  const recorded = yield* service
    .duration(binding.id, { generation: binding.generation, receipt }, state.secret, entry.directory)
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!recorded || JSON.stringify(recorded) !== JSON.stringify(receipt)) return false
  state.usage = receipt
  entry.info = { ...entry.info, status: "closed" }
  return true
})

function running(state: State, input: typeof Envelope.Type) {
  const data = input.event.data
  const usage = record(data?.usage)
  const receipt = { id: data?.event_id, model: state.binding?.model, seconds: usage?.seconds }
  if (
    input.event.session !== state.binding?.providerCallID ||
    !Schema.is(LiveDuration)(receipt) ||
    !Number.isFinite(receipt.seconds)
  )
    return false
  if (state.running && receipt.seconds < state.running.seconds) return false
  if (state.running?.id === receipt.id && JSON.stringify(state.running) !== JSON.stringify(receipt)) return false
  state.running = receipt
  return true
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^\S+$/.test(value)
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function reason(value: unknown) {
  return ["close_requested", "expired", "content", "remote_hangup", "connection_lost"].includes(String(value))
}
