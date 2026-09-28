import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type * as OpenAI from "./openai"
import { OpenAIBinding, OpenAIReservation, OpenAICall } from "./openai-protocol"
import { LiveDuration, LiveCall } from "./live-protocol"
import * as Context from "./mf-context"
import * as Result from "./mf-result"
import type { Envelope, Info } from "./protocol"

export type Service = Pick<
  Effect.Success<ReturnType<typeof OpenAI.make>>,
  "start" | "settle" | "duration" | "close" | "reserve" | "release" | "delegate" | "get"
>
export type State = {
  version?: 1
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
  captions?: Context.State
  tasks?: Record<string, Task>
}
type Task = {
  id: string
  kind?: "work" | "clarification"
  selection?: (typeof LiveCall.Type)["context"]
  fingerprint: string
  phase: "intent" | "admitted" | "clarifying" | "offered" | "accepted" | "unknown" | "failed"
  call?: typeof OpenAICall.Type
  deadline: number
  offer?: typeof Result.Result.Type
  ack?: Awaited<ReturnType<typeof Result.send>>
}
type Final = { event_id: string; model: "gpt-live-1"; reason: string; usage: { seconds: number } }
type Entry = { info: typeof Info.Type; directory: string; mediaKey?: string; live?: State }

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

/** Captions are imperfect task context, never complete turns or heard-audio proof. */
export const event = Effect.fn("RayaVoice.Live.event")(function* (
  entry: Entry,
  input: typeof Envelope.Type,
  service: Service | undefined,
  save: () => Effect.Effect<void>,
  stopped: () => boolean = () => false,
) {
  const state = entry.live
  if (!state || !service || !/^[a-f0-9]{64}$/.test(state.secret) || !entry.directory) return false
  if (!registry(entry)) return false
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
    : dispatch(entry, input, service, save, stopped)
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
  stopped: () => boolean,
) {
  const state = entry.live!
  if (input.event.type === "session.started") return yield* started(entry, input, service, save)
  if (!state.binding) return false
  if (input.event.type === "session.closed") return yield* closed(entry, input, service)
  if (entry.info.status === "closed" || entry.info.status === "failed") return false
  if (input.event.type === "session.delegation.created") return yield* delegate(entry, input, service, save, stopped)
  if (["transcript.input.delta", "transcript.output.delta"].includes(input.event.type)) {
    if (input.event.session !== state.binding.providerCallID || stopped()) return false
    if (
      input.event.item !== input.event.data?.event_id ||
      input.event.text !== input.event.data?.delta ||
      input.event.data?.completeTurn !== false
    )
      return false
    state.captions ??= Context.create()
    state.version = 1
    return Context.receive(state.captions, input.event.type, input.event.data ?? {})
  }
  if (input.event.type === "delegation.request") return false
  if (input.event.type === "session.usage.updated") return running(state, input)
  if (input.event.type === "engine.error") entry.info = { ...entry.info, status: "failed" }
  return true
})

const delegate = Effect.fn("RayaVoice.Live.delegate")(function* (
  entry: Entry,
  input: typeof Envelope.Type,
  service: Service,
  save: () => Effect.Effect<void>,
  stopped: () => boolean,
) {
  const state = entry.live!
  if (stopped() || !entry.mediaKey || input.event.session !== state.binding!.providerCallID) return false
  const data = input.event.data ?? {}
  const delegation = Context.object(data.delegation)
  if (
    !delegation ||
    !Context.identity(delegation.id) ||
    input.event.item !== delegation.id ||
    !Context.offset(data.offset_ms)
  )
    return false
  state.captions ??= Context.create()
  state.version = 1
  if (!Context.receive(state.captions, input.event.type, data)) return false
  state.tasks ??= {}
  const key = createHash("sha256").update(delegation.id).digest("hex")
  const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex")
  const prior = state.tasks[key]
  if (prior) return prior.fingerprint === fingerprint
  if (Object.keys(state.tasks).length >= 64) return false
  const selection = Context.select(state.captions, delegation.id, data.offset_ms)
  if (!selection) {
    const created = new Date().toISOString()
    const deadline = Math.min(
      Date.now() + 5000,
      state.binding!.expiresAt,
      entry.info.createdAt + (entry.info.maximumSeconds ?? 0) * 1000,
    )
    if (deadline <= Date.now()) return false
    state.tasks[key] = {
      id: delegation.id,
      kind: "clarification",
      fingerprint,
      phase: "clarifying",
      deadline,
      offer: {
        version: 2,
        delegationID: delegation.id,
        receiptID: `clarification_${crypto.randomUUID()}`,
        kind: "delegation.result",
        content: clarification,
        ttl: Math.floor(deadline - Date.parse(created)),
        created,
      },
    }
    yield* save()
    return !stopped()
  }
  const task: Task = {
    id: delegation.id,
    kind: "work",
    selection,
    fingerprint,
    phase: "intent",
    deadline: Date.now() + 30 * 60_000,
  }
  state.tasks[key] = task
  yield* save()
  if (stopped()) {
    task.phase = "unknown"
    yield* save()
    return false
  }
  const call = yield* service
    .delegate(
      state.binding!.id,
      { generation: state.binding!.generation, context: selection },
      state.secret,
      entry.directory,
    )
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!call || call.parentSessionID !== entry.info.parentSessionID) {
    task.phase = "unknown"
    yield* save()
    return false
  }
  task.call = call
  task.phase = "admitted"
  yield* save()
  return true
})

export function pending(entry: Entry) {
  return (
    !!entry.mediaKey &&
    Object.values(entry.live?.tasks ?? {}).some((task) => ["admitted", "clarifying"].includes(task.phase))
  )
}

export const poll = Effect.fn("RayaVoice.Live.poll")(function* (
  entry: Entry,
  service: Service,
  save: () => Effect.Effect<void>,
  stopped: () => boolean,
) {
  const state = entry.live!
  if (stopped() || entry.info.status !== "active" || !entry.mediaKey || !state.binding) return
  for (const task of Object.values(state.tasks ?? {})) {
    if (stopped()) return
    if (!["admitted", "clarifying"].includes(task.phase)) continue
    if (Date.now() >= task.deadline) {
      task.phase = "unknown"
      yield* save()
      continue
    }
    if (task.kind === "clarification") return yield* prepare(entry, task, save, stopped)
    if (!task.call) continue
    const call = yield* service
      .get(state.binding.id, task.call.callID, state.binding.generation, state.secret, entry.directory)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!call || call.id !== task.call.id || call.parentSessionID !== entry.info.parentSessionID) {
      task.phase = "unknown"
      yield* save()
      continue
    }
    if (["accepted", "running"].includes(call.status)) continue
    if (stopped() || Date.now() >= task.deadline) return
    task.call = call
    const content = excerpt(call, task, entry)
    task.offer = {
      version: 2,
      delegationID: task.id,
      receiptID: `result_${crypto.randomUUID()}`,
      kind: "delegation.result",
      content,
      ttl: 5000,
      created: new Date().toISOString(),
    }
    return yield* prepare(entry, task, save, stopped)
  }
})

const clarification = "Please tell me what you'd like me to do."
const prepare = Effect.fn("RayaVoice.Live.prepare")(function* (
  entry: Entry,
  task: Task,
  save: () => Effect.Effect<void>,
  stopped: () => boolean,
) {
  const offer = task.offer
  if (!offer || stopped()) return
  task.phase = "offered"
  yield* save()
  if (stopped()) {
    task.phase = "unknown"
    yield* save()
    return
  }
  return {
    task,
    offer,
    url: entry.info.mediaURL,
    id: entry.info.id,
    key: entry.mediaKey,
    token: entry.info.controlToken,
    provider: entry.live!.binding!.providerCallID,
  }
})

export const deliver = Effect.fn("RayaVoice.Live.deliver")(function* (
  plan: NonNullable<Effect.Success<ReturnType<typeof poll>>>,
  signal: AbortSignal,
  stopped: () => boolean,
) {
  return yield* Effect.tryPromise({
    try: () => {
      if (stopped() || signal.aborted) throw new Result.ResultError("refused")
      return Result.send(plan.url, plan.id, plan.key!, plan.token, plan.offer, signal)
    },
    catch: (error) => error,
  }).pipe(
    Effect.map((ack) => ({ phase: "accepted" as const, ack })),
    Effect.catch((error) =>
      Effect.succeed(
        error instanceof Result.ResultError && error.status === "refused"
          ? { phase: "failed" as const }
          : { phase: "unknown" as const },
      ),
    ),
  )
})

export const delivered = Effect.fn("RayaVoice.Live.delivered")(function* (
  entry: Entry,
  plan: NonNullable<Effect.Success<ReturnType<typeof poll>>>,
  outcome: Effect.Success<ReturnType<typeof deliver>>,
  save: () => Effect.Effect<void>,
  stopped: () => boolean,
) {
  const task = Object.values(entry.live?.tasks ?? {}).find((task) => task === plan.task)
  if (
    !task ||
    !["offered", "unknown"].includes(task.phase) ||
    task.offer !== plan.offer ||
    entry.info.id !== plan.id ||
    entry.live?.binding?.providerCallID !== plan.provider
  )
    return
  if ("ack" in outcome) task.ack = outcome.ack
  task.phase = "ack" in outcome ? "accepted" : stopped() ? "unknown" : outcome.phase
  yield* save()
})

function excerpt(call: typeof OpenAICall.Type, task: Task, entry: Entry) {
  if (call.status !== "completed")
    return call.status === "cancelled"
      ? "The task was cancelled. Details are available in chat."
      : "The task could not finish. Details are available in chat."
  const fallback = "The task response is available in chat."
  const text = call.result?.text?.trim() || fallback
  const ids = [
    task.id,
    call.id,
    call.callID,
    call.messageID,
    call.result?.assistantMessageID,
    entry.live?.binding?.id,
    entry.live?.binding?.generation,
    entry.live?.binding?.providerCallID,
    entry.info.id,
    entry.info.parentSessionID,
    entry.live?.secret,
    entry.info.controlToken,
    entry.mediaKey,
    ...(task.selection?.fragments ?? []).flatMap((item) => [item.id, item.client]),
  ]
  if (ids.some((id) => id && text.includes(id))) return fallback
  const content = Buffer.from(text, "utf8").toString("utf8").trim()
  let output = ""
  for (const point of content) {
    if (Buffer.byteLength(output + point, "utf8") > 500) break
    output += point
  }
  return output || fallback
}

function registry(entry: Entry) {
  const state = entry.live!
  if (state.version !== 1) return state.version === undefined && !state.captions && !state.tasks
  if (state.captions && !Context.valid(state.captions)) return false
  if (!state.tasks) return true
  const tasks = Context.object(state.tasks)
  if (!tasks || Object.keys(tasks).length > 64) return false
  return Object.entries(tasks).every(([key, value]) => {
    const task = Context.object(value)
    if (
      !task ||
      !Context.identity(task.id) ||
      key !== createHash("sha256").update(task.id).digest("hex") ||
      typeof task.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(task.fingerprint) ||
      !["intent", "admitted", "clarifying", "offered", "accepted", "unknown", "failed"].includes(String(task.phase)) ||
      typeof task.deadline !== "number" ||
      !Number.isSafeInteger(task.deadline) ||
      task.deadline < 0
    )
      return false
    if (task.call && (!Schema.is(OpenAICall)(task.call) || task.call.parentSessionID !== entry.info.parentSessionID))
      return false
    if (task.offer && !Schema.is(Result.Result)(task.offer)) return false
    if (task.kind === "clarification") return validClarification(task)
    if (task.kind !== undefined && task.kind !== "work") return false
    if (
      task.phase === "clarifying" ||
      !Schema.is(LiveCall)({ generation: state.binding?.generation, context: task.selection })
    )
      return false
    if (["admitted", "offered", "accepted"].includes(String(task.phase)) && !task.call) return false
    if (["offered", "accepted"].includes(String(task.phase)) && !task.offer) return false
    return true
  })
}

function validClarification(task: Record<string, unknown>) {
  const offer = Context.object(task.offer)
  return (
    task.selection === undefined &&
    task.call === undefined &&
    !!offer &&
    offer.delegationID === task.id &&
    offer.kind === "delegation.result" &&
    offer.content === clarification &&
    typeof offer.created === "string" &&
    typeof offer.ttl === "number" &&
    Date.parse(offer.created) + offer.ttl === task.deadline &&
    ["clarifying", "offered", "accepted", "unknown", "failed"].includes(String(task.phase))
  )
}

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
