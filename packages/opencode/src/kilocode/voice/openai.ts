import {
  OpenAIUsageInput,
  valid,
  fingerprint,
  pricing,
  transcriptionAllowance,
  type OpenAIPricing,
} from "./openai-usage"
import {
  allowance as liveAllowance,
  LiveCall,
  LiveMeter,
  prompt as livePrompt,
  valid as liveValid,
} from "./live-protocol"
import fs from "node:fs/promises"
import { createHash, timingSafeEqual } from "node:crypto"
import { Cause, Effect, Exit, Fiber, Schema, Scope, Semaphore } from "effect"
import { MessageID, type SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import type { Database } from "@opencode-ai/core/database/database"
import * as Store from "./openai-store"
import * as Spoken from "./openai-spoken"
import * as Obligations from "./openai-obligations"
import { Storage } from "@/storage/storage"
import type * as TaskWorker from "@/kilocode/session/task-worker"
import { mutate } from "@/kilocode/task/mutation"
import { Reconciliation } from "./reconciliation-schema"
import {
  OpenAIBinding,
  OpenAICall,
  OpenAICallInput,
  OpenAIStart,
  OpenAIImage,
  OpenAIImageInput,
  OpenAIReservation,
  OpenAIReserve,
  OpenAIHandoffCandidate,
  OpenAIHandoffReady,
  OpenAIHandoffRearm,
  OpenAIHandoffRearmReceipt,
  OpenAIHandoffActivate,
  OpenAIHandoffTransfer,
  OpenAIHandoffReceipt,
  OpenAIHandoffContext,
  handoff as validHandoff,
  VoiceID,
  VoiceKey,
} from "./openai-protocol"

type Binding = typeof OpenAIBinding.Type
type Call = typeof OpenAICall.Type
type Input = typeof OpenAICallInput.Type
type Image = { receipt: typeof OpenAIImage.Type; data: string }
type Usage = (typeof OpenAIUsageInput.Type)["receipt"]
type UsageCharge = {
  sessionID: SessionID
  id: string
  callID: string
  at: number
  model: "gpt-realtime-2.1" | "gpt-live-transcribe"
  pricing: OpenAIPricing
}
type Stored = Store.Stored
type Admission = {
  amount?: number
  dispatch: Effect.Effect<void, VoiceError>
  finish: Effect.Effect<void, VoiceError>
  release: Effect.Effect<void, never>
}
type Reservation = {
  fingerprint: string
  input: typeof OpenAIReserve.Type
  lease: Admission
  bound?: boolean
}
type Deps = {
  database: Database.Interface
  storage: Storage.Interface
  sessions: { get: (id: SessionID) => Effect.Effect<Pick<Session.Info, "id" | "directory">, Session.NotFound> }
  prompts: Pick<SessionPrompt.Interface, "prompt">
  workers: Pick<TaskWorker.Interface, "cancel">
  charges?: (input: {
    sessionID: SessionID
    id: string
    callID: string
    at: number
    seconds: number
  }) => Effect.Effect<void, VoiceError>
  usageCharges?: (input: UsageCharge) => Effect.Effect<void, VoiceError>
  usageSettlements?: (input: UsageCharge & { identity: string }) => Effect.Effect<void, VoiceError>
  admissions?: (sessionID: SessionID, identity: string) => Effect.Effect<Admission, VoiceError>
  completions?: (sessionID: SessionID, identity: string) => Effect.Effect<boolean, VoiceError>
}

export class VoiceError extends Schema.TaggedErrorClass<VoiceError>()("VoiceError", {
  code: Schema.Literals(["unauthorized", "missing", "conflict", "expired", "invalid"]),
  message: Schema.String,
}) {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const pending = (call: Call) => call.status === "accepted" || call.status === "running"
const refuse = (code: VoiceError["code"], message: string) => Effect.fail(new VoiceError({ code, message }))
const canonical = (directory: string) => Effect.tryPromise(() => fs.realpath(directory)).pipe(Effect.orDie)

const ledger = (stored: Stored) =>
  Effect.gen(function* () {
    if (
      stored.usage !== undefined &&
      (stored.usage === null || typeof stored.usage !== "object" || Array.isArray(stored.usage))
    )
      return yield* refuse("conflict", "Retained provider usage is invalid.")
    const entries = Object.entries(stored.usage ?? {})
    const reservations = stored.usageReservations
    if (
      entries.length > 512 ||
      entries.some(([key, receipt]) => !valid(receipt) || key !== digest(`${receipt.kind}:${receipt.id}`)) ||
      (reservations !== undefined &&
        (reservations === null ||
          typeof reservations !== "object" ||
          Array.isArray(reservations) ||
          Object.entries(reservations).some(
            ([key, identity]) =>
              !entries.some(([entry]) => entry === key) ||
              typeof identity !== "string" ||
              !/^voice:[a-f0-9]{64}$/.test(identity),
          )))
    )
      return yield* refuse("conflict", "Retained provider usage is invalid.")
    return entries.map(([key, receipt]) => ({ receipt, identity: reservations?.[key] }))
  })

const decode = (mime: (typeof OpenAIImage.Type)["mime"], data: string) => {
  if (data.length > 349528 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    return undefined
  const bytes = Buffer.from(data, "base64")
  if (!bytes.length || bytes.length > 262144 || bytes.toString("base64") !== data) return undefined
  const signature =
    mime === "image/jpeg"
      ? bytes.length >= 4 &&
        bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) &&
        bytes.subarray(-2).equals(Buffer.from([255, 217]))
      : mime === "image/png"
        ? bytes.length >= 33 &&
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          bytes.readUInt32BE(8) === 13 &&
          bytes.toString("ascii", 12, 16) === "IHDR"
        : mime === "image/webp" &&
          bytes.length >= 20 &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.readUInt32LE(4) === bytes.length - 8 &&
          bytes.toString("ascii", 8, 12) === "WEBP" &&
          ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  return signature ? bytes : undefined
}

const images = (stored: Stored, ids: Input["arguments"]["images"]) =>
  Effect.gen(function* () {
    if (ids && (ids.length > 4 || new Set(ids).size !== ids.length || ids.some((id) => !Schema.is(VoiceID)(id))))
      return yield* refuse("invalid", "Select at most four distinct staged image IDs.")
    const selected: Image[] = []
    for (const id of ids ?? []) {
      const image = stored.images?.[digest(id)]
      if (!image) return yield* refuse("missing", "Image is not staged in this voice binding.")
      if (!Schema.is(OpenAIImage)(image.receipt) || image.receipt.id !== id || typeof image.data !== "string")
        return yield* refuse("conflict", "Retained image metadata is invalid.")
      const bytes = decode(image.receipt.mime, image.data)
      if (
        !bytes ||
        bytes.length !== image.receipt.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== image.receipt.sha256
      )
        return yield* refuse("conflict", "Retained image bytes do not match their receipt.")
      selected.push(image)
    }
    return selected
  })

/** A server-scoped owner. Retained intents are never adopted or replayed by another owner. */
export const make = (deps: Deps) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const owner = crypto.randomUUID()
    const gates = new Map<string, { semaphore: ReturnType<typeof Semaphore.makeUnsafe>; refs: number }>()
    const reservations = new Map<string, Reservation>()
    const locked = <A, E, R>(id: string, work: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const gate = gates.get(id) ?? { semaphore: Semaphore.makeUnsafe(1), refs: 0 }
          gate.refs++
          gates.set(id, gate)
          return gate
        }),
        (gate) => work.pipe(gate.semaphore.withPermits(1)),
        (gate) =>
          Effect.sync(() => {
            gate.refs--
            if (gate.refs === 0 && gates.get(id) === gate) gates.delete(id)
          }),
      )
    const store = Store.make(deps.database, deps.storage)
    const reservation = (input: typeof OpenAIReserve.Type, secret: string, directory: string) =>
      digest(JSON.stringify([directory, input.parentSessionID, input.requestID, input.model, digest(secret)]))
    const reserved = (input: typeof OpenAIReserve.Type, entry?: Reservation): typeof OpenAIReservation.Type => ({
      requestID: input.requestID,
      model: input.model,
      status: "reserved",
      ...(entry?.lease.amount !== undefined ? { amount: entry.lease.amount, currency: "USD" as const } : {}),
      ...(entry?.lease.amount !== undefined && ["gpt-live-1", "gpt-live-transcribe"].includes(input.model)
        ? {
            maximumSeconds:
              input.model === "gpt-live-1"
                ? liveAllowance(entry.lease.amount)
                : transcriptionAllowance(entry.lease.amount),
          }
        : {}),
    })
    const finishReservation = (key: string, entry: Reservation) =>
      entry.lease.finish.pipe(Effect.tap(() => Effect.sync(() => reservations.delete(key))))
    const releaseReservation = (key: string, entry: Reservation) =>
      finishReservation(key, entry).pipe(Effect.andThen(entry.lease.release))
    const resolveLive = (stored: Stored, secret: string, outcome: "recorded" | "deferred") =>
      Effect.gen(function* () {
        const input = {
          parentSessionID: stored.binding.parentSessionID,
          requestID: stored.requestID,
          model: "gpt-live-1" as const,
        }
        const id = digest(JSON.stringify([stored.binding.directory, stored.requestID]))
        const proof = reservation(input, secret, stored.binding.directory)
        const entry = reservations.get(id)
        if (entry) {
          if (entry.fingerprint !== proof)
            return yield* refuse("conflict", "Live reservation does not match the provider binding.")
          if (outcome === "recorded") yield* finishReservation(id, entry)
          if (outcome === "recorded") reservations.delete(id)
          yield* entry.lease.release
          return
        }
        if (outcome === "recorded") {
          if (deps.completions) yield* deps.completions(stored.binding.parentSessionID, `voice:${proof}`)
          return
        }
      })
    const save = (stored: Stored) =>
      store
        .replace(stored)
        .pipe(Effect.mapError((error) => new VoiceError({ code: error.code, message: error.message })))
    const read = (id: string) =>
      store.read(id).pipe(Effect.mapError((error) => new VoiceError({ code: error.code, message: error.message })))
    const charge = (stored: Stored, receipt: Usage, identity?: string) => {
      if (stored.transcriptionRequestID && receipt.kind === "transcription") return Effect.void
      const input = {
        sessionID: stored.binding.parentSessionID,
        id: `openai-voice:${stored.binding.id}:${receipt.kind}:${receipt.id}`,
        callID: stored.binding.id,
        at: stored.binding.createdAt,
        model: receipt.model,
        pricing: pricing(receipt),
      }
      if (identity && deps.usageSettlements) return deps.usageSettlements({ ...input, identity })
      return deps.usageCharges ? deps.usageCharges(input) : Effect.void
    }
    const settleTranscription = (stored: Stored) =>
      Effect.gen(function* () {
        if (!stored.transcriptionRequestID) return
        const receipts = Object.values(stored.usage ?? {}).filter((receipt) => receipt.kind === "transcription")
        const seconds = receipts.reduce((sum, receipt) => sum + (receipt.seconds ?? 0), 0)
        const complete = receipts.every(
          (receipt) => receipt.status === "reported" && receipt.seconds !== undefined && receipt.tokens === undefined,
        )
        const price = pricing({
          id: "session_transcription",
          kind: "transcription",
          model: "gpt-live-transcribe",
          status: complete ? "reported" : "missing",
          ...(complete ? { seconds } : {}),
        })
        const input = {
          sessionID: stored.binding.parentSessionID,
          id: `openai-voice:${stored.binding.id}:transcription-total`,
          callID: stored.binding.id,
          at: stored.binding.createdAt,
          model: "gpt-live-transcribe" as const,
          pricing: price,
        }
        const reserve = {
          parentSessionID: stored.binding.parentSessionID,
          requestID: stored.transcriptionRequestID,
          model: "gpt-live-transcribe" as const,
        }
        const id = digest(JSON.stringify([stored.binding.directory, reserve.requestID]))
        const proof = digest(
          JSON.stringify([
            stored.binding.directory,
            reserve.parentSessionID,
            reserve.requestID,
            reserve.model,
            stored.hash,
          ]),
        )
        const identity = `voice:${proof}`
        if (deps.usageSettlements) yield* deps.usageSettlements({ ...input, identity })
        const entry = reservations.get(id)
        if (entry && entry.fingerprint !== proof)
          yield* refuse("conflict", "Transcription reservation does not match the provider binding.")
        reservations.delete(id)
        if (entry) yield* entry.lease.release
      })
    const repairKey = ["raya", "voice", "usage-reconciliation", "v1"]
    const repairStore = {
      read: <T>(parts: string[]) => deps.storage.read<T>(["raya", "voice-reconciliation", ...parts]),
      create: (parts: string[], value: unknown) =>
        deps.storage.create(["raya", "voice-reconciliation", ...parts], value),
      replace: (parts: string[], value: unknown) =>
        deps.storage.replace(["raya", "voice-reconciliation", ...parts], value),
      remove: (parts: string[]) => deps.storage.remove(["raya", "voice-reconciliation", ...parts]),
    }
    const repairRead = () =>
      deps.storage.read<unknown>(repairKey).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
        Effect.flatMap((raw) => {
          if (raw === undefined) return Effect.succeed(undefined)
          return Schema.decodeUnknownEffect(Reconciliation)(raw).pipe(
            Effect.mapError(
              () => new VoiceError({ code: "conflict", message: "Voice usage reconciliation state is invalid." }),
            ),
          )
        }),
      )
    const repairSave = (state: Reconciliation) => deps.storage.replace(repairKey, state).pipe(Effect.orDie)
    const quarantine = (id: string, reason: string) =>
      deps.storage
        .create(["raya", "voice", "usage-reconciliation", "quarantine", digest(id)], {
          version: 1,
          id,
          reason,
          at: Date.now(),
        })
        .pipe(Effect.orDie)
    const reconcile = (limit = 8) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 32)
        return refuse("invalid", "Voice usage reconciliation limit must be between 1 and 32 bindings.")
      return mutate(
        repairStore,
        Effect.gen(function* () {
          const prior = yield* repairRead()
          const reset = prior === undefined || prior.status === "complete"
          const latest = reset ? yield* store.latest() : undefined
          let state: Reconciliation = reset
            ? {
                version: 1,
                cycle: Math.min((prior?.cycle ?? 0) + 1, Number.MAX_SAFE_INTEGER),
                high: latest?.id ?? "",
                status: "running",
                scanned: 0,
                receipts: 0,
                quarantined: 0,
                updatedAt: Date.now(),
              }
            : { ...prior, status: "running", failure: undefined, updatedAt: Date.now() }
          if (!state.high) {
            state = { ...state, status: "complete", updatedAt: Date.now() }
            yield* repairSave(state)
            return state
          }
          const rows = yield* store.page(state.after, state.high, limit)
          for (const row of rows) {
            const parsed = yield* store.inspect(row).pipe(Effect.exit)
            if (Exit.isFailure(parsed)) {
              yield* quarantine(row.id, "The retained voice binding is invalid.")
              state = {
                ...state,
                after: row.id,
                scanned: state.scanned + 1,
                quarantined: state.quarantined + 1,
                updatedAt: Date.now(),
              }
              yield* repairSave(state)
              continue
            }
            const receipts = yield* ledger(parsed.value).pipe(Effect.exit)
            if (Exit.isFailure(receipts)) {
              yield* quarantine(row.id, "The retained voice usage ledger is invalid.")
              state = {
                ...state,
                after: row.id,
                scanned: state.scanned + 1,
                quarantined: state.quarantined + 1,
                updatedAt: Date.now(),
              }
              yield* repairSave(state)
              continue
            }
            const published = yield* Effect.forEach(
              receipts.value,
              (entry) => charge(parsed.value, entry.receipt, entry.identity),
              {
                concurrency: 1,
                discard: true,
              },
            ).pipe(Effect.exit)
            const transcription =
              parsed.value.binding.status === "closed" && parsed.value.transcriptionRequestID
                ? yield* settleTranscription(parsed.value).pipe(Effect.exit)
                : undefined
            if (Exit.isFailure(published) || (transcription && Exit.isFailure(transcription))) {
              state = {
                ...state,
                status: "failed",
                failure: {
                  id: row.id,
                  message: "A retained voice charge could not be published. The same binding will be retried.",
                },
                updatedAt: Date.now(),
              }
              yield* repairSave(state)
              return state
            }
            state = {
              ...state,
              after: row.id,
              scanned: state.scanned + 1,
              receipts: state.receipts + receipts.value.length,
              updatedAt: Date.now(),
            }
            yield* repairSave(state)
          }
          state = {
            ...state,
            status: rows.length < limit || state.after === state.high ? "complete" : "running",
            updatedAt: Date.now(),
          }
          yield* repairSave(state)
          return state
        }),
        "Voice usage reconciliation",
      )
    }
    const load = (id: string, secret: string, directory: string, generation?: string) =>
      Effect.gen(function* () {
        if (!Schema.is(VoiceKey)(secret)) return yield* refuse("unauthorized", "Invalid voice capability.")
        const stored = yield* read(id)
        if (!timingSafeEqual(Buffer.from(digest(secret), "hex"), Buffer.from(stored.hash, "hex")))
          return yield* refuse("unauthorized", "Invalid voice capability.")
        if (stored.binding.directory !== (yield* canonical(directory)))
          return yield* refuse("conflict", "Voice directory changed.")
        if (generation !== undefined && stored.binding.generation !== generation)
          return yield* refuse("conflict", "Voice generation changed.")
        return stored
      })
    const active = (stored: Stored) => {
      if (stored.owner !== owner || stored.binding.status !== "active")
        return refuse("conflict", "Voice binding is closed or belongs to an earlier server owner.")
      if (stored.binding.expiresAt <= Date.now() && stored.binding.handoff?.phase !== "retiring")
        return refuse("expired", "Voice binding expired.")
      return Effect.void
    }
    const entries = (stored: Stored) =>
      Effect.gen(function* () {
        const rows = yield* store.current(stored.binding.parentSessionID, owner, Date.now())
        if (rows.length > 64) return yield* refuse("conflict", "Voice parent inspection limit reached.")
        return yield* Effect.forEach(rows, (row) =>
          store.inspect(row).pipe(
            Effect.mapError(
              () => new VoiceError({ code: "conflict", message: "Voice parent contains invalid retained authority." }),
            ),
            Effect.flatMap((entry) =>
              entry.binding.directory === stored.binding.directory
                ? Effect.succeed(entry)
                : refuse("conflict", "Voice parent directory changed."),
            ),
          ),
        )
      })
    const authority = (stored: Stored) =>
      Effect.gen(function* () {
        yield* active(stored)
        if (stored.binding.handoff && stored.binding.handoff.phase !== "active")
          return yield* refuse("conflict", "Voice binding does not admit new work.")
        const current = yield* entries(stored)
        if (
          current.some(
            (entry) =>
              entry.binding.id !== stored.binding.id &&
              (!entry.binding.handoff || entry.binding.handoff.phase === "active"),
          )
        )
          return yield* refuse("conflict", "Another voice binding owns this parent.")
      })
    const group = <A, E, R>(stored: Stored, work: Effect.Effect<A, E, R>) =>
      locked(`parent:${digest(JSON.stringify([stored.binding.directory, stored.binding.parentSessionID]))}`, work)
    const locks = <A, E, R>(ids: string[], work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      [...new Set(ids)].sort().reduceRight((next, id) => locked(id, next), work)
    const reference = (stored: Stored, call: Call): typeof Obligations.Reference.Type => ({
      version: 1,
      id: `rob_${digest(JSON.stringify([stored.binding.id, stored.binding.generation, call.id])).slice(0, 48)}`,
      originID: stored.binding.id,
      originGeneration: stored.binding.generation,
      callID: call.callID,
      receiptID: call.id,
      messageID: call.messageID,
      parentSessionID: stored.binding.parentSessionID,
      directory: stored.binding.directory,
      createdAt: call.createdAt,
    })
    const origins = (stored: Stored) => (stored.obligations ?? []).map((ref) => ref.originID)
    const origin = (target: Stored, ref: typeof Obligations.Reference.Type) =>
      Effect.gen(function* () {
        const source = yield* read(ref.originID)
        const call = source.calls[digest(ref.callID)]
        const delivery = source.deliveries?.[ref.id]
        if (
          !call ||
          !delivery ||
          source.owner !== target.owner ||
          ref.originGeneration !== source.binding.generation ||
          ref.parentSessionID !== target.binding.parentSessionID ||
          ref.directory !== target.binding.directory ||
          source.binding.directory !== target.binding.directory ||
          call.receipt.id !== ref.receiptID ||
          call.receipt.messageID !== ref.messageID ||
          JSON.stringify(delivery.reference) !== JSON.stringify(ref) ||
          JSON.stringify(reference(source, call.receipt)) !== JSON.stringify(ref)
        )
          return yield* refuse("conflict", "Retained work provenance changed.")
        return { source, call: call.receipt, delivery }
      })
    const selected = (stored: Stored, id: string) => {
      const own = stored.deliveries?.[id]?.reference
      const inherited = stored.obligations?.find((ref) => ref.id === id)
      return own ?? inherited
    }
    const outstanding = (stored: Stored) =>
      Effect.gen(function* () {
        const refs = new Map<string, typeof Obligations.Reference.Type>()
        for (const ref of [
          ...Object.values(stored.deliveries ?? {}).map((delivery) => delivery.reference),
          ...(stored.obligations ?? []),
        ]) {
          const value = yield* origin(stored, ref)
          if (value.delivery.phase === "played" || value.delivery.phase === "omitted") continue
          const prior = refs.get(ref.id)
          if (prior && JSON.stringify(prior) !== JSON.stringify(ref))
            return yield* refuse("conflict", "Retained work identities conflict.")
          refs.set(ref.id, ref)
          if (refs.size > 64) return yield* refuse("conflict", "Retained work allowance was exhausted.")
        }
        return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id))
      })
    const snapshot = (source: Stored, candidate: Stored) =>
      Effect.gen(function* () {
        const references = yield* outstanding(source)
        const ids = new Set(references.map((ref) => ref.id))
        for (const entry of yield* entries(source)) {
          for (const call of Object.values(entry.calls)) {
            if (pending(call.receipt) && !ids.has(reference(entry, call.receipt).id))
              return yield* refuse("conflict", "Pending work has no transferable delivery record.")
          }
        }
        const states = []
        for (const ref of references) {
          const value = yield* origin(source, ref)
          states.push({ reference: ref, epoch: value.delivery.epoch, offer: value.delivery.offer ?? null })
        }
        const relation = {
          version: 1 as const,
          sourceID: source.binding.id,
          sourceGeneration: source.binding.generation,
          candidateID: candidate.binding.id,
          candidateGeneration: candidate.binding.generation,
        }
        const hash = digest(JSON.stringify({ ...relation, states }))
        return { ...relation, manifestID: `rom_${hash.slice(0, 48)}`, hash, references }
      })
    const visible = (stored: Stored): Binding => ({
      ...stored.binding,
      status: stored.owner !== owner || stored.binding.expiresAt <= Date.now() ? "closed" : stored.binding.status,
    })
    const receipt = (stored: Stored, call: Call): Call =>
      stored.owner !== owner && pending(call)
        ? {
            ...call,
            status: "unknown",
            error: {
              code: "owner_lost",
              message: "The previous server stopped before a final receipt. This call will not be replayed.",
            },
          }
        : call
    const finish = (id: string, callID: string, update: Partial<Call>) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* read(id)
          const call = stored.calls[digest(callID)]
          if (stored.owner !== owner || !call || !pending(call.receipt)) return
          call.receipt = { ...call.receipt, ...update, updatedAt: Date.now() }
          yield* save(stored)
        }),
      )
    const run = (id: string, callID: string) =>
      Effect.gen(function* () {
        const admitted = yield* locked(
          id,
          Effect.gen(function* () {
            const stored = yield* read(id)
            if (stored.owner !== owner) return undefined
            const call = stored.calls[digest(callID)]
            if (!call || call.receipt.status !== "accepted") return undefined
            call.receipt = { ...call.receipt, status: "running", updatedAt: Date.now() }
            const selected = yield* images(stored, call.input.arguments.images)
            if (JSON.stringify(selected.map((image) => image.receipt)) !== JSON.stringify(call.receipt.images ?? []))
              return yield* refuse("conflict", "Selected image receipts changed before dispatch.")
            yield* save(stored)
            return { ...call, images: selected }
          }),
        )
        if (!admitted) return
        const call = admitted.receipt
        const result = yield* deps.prompts
          .prompt({
            sessionID: call.parentSessionID,
            messageID: call.messageID,
            parts: [
              { type: "text", text: admitted.input.arguments.request },
              ...admitted.images.map((image) => ({
                type: "file" as const,
                mime: image.receipt.mime,
                url: `data:${image.receipt.mime};base64,${image.data}`,
              })),
            ],
          })
          .pipe(Effect.exit)
        if (Exit.isFailure(result)) {
          yield* finish(id, callID, {
            status: Cause.hasInterrupts(result.cause) ? "unknown" : "failed",
            error: {
              code: "prompt_failed",
              message: "Voice work did not finish successfully. Inspect the Raya session before retrying work.",
            },
          })
          return
        }
        const message = result.value
        if (
          message.info.role !== "assistant" ||
          message.info.parentID !== call.messageID ||
          message.info.sessionID !== call.parentSessionID ||
          message.parts.some((part) => part.messageID !== message.info.id || part.sessionID !== call.parentSessionID)
        ) {
          yield* finish(id, callID, {
            status: "unknown",
            error: {
              code: "superseded",
              message: "The runtime returned another turn; no result is attributed to this voice call.",
            },
          })
          return
        }
        if (message.info.error) {
          yield* finish(id, callID, {
            status: "failed",
            error: { code: "assistant_failed", message: "The Raya session reports an error for this voice call." },
          })
          return
        }
        const tools = message.parts.filter((part) => part.type === "tool")
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        const receipt = {
          text:
            text.length > 12000
              ? `${text.slice(0, 11800)}\n[Response shortened; inspect the Raya session for the full result.]`
              : text,
          assistantMessageID: message.info.id,
          evidence: tools
            .filter((part) => part.tool.length <= 128)
            .slice(0, 64)
            .map((part) => ({
              messageID: part.messageID,
              partID: part.id,
              tool: part.tool,
              status: part.state.status,
            })),
        }
        if (
          message.info.time.completed &&
          message.info.finish === "tool-calls" &&
          tools.length > 0 &&
          tools.every((part) => part.state.status === "completed" || part.state.status === "error") &&
          tools.some((part) => part.state.status === "error")
        ) {
          yield* finish(id, callID, {
            status: "failed",
            result: receipt,
            error: {
              code: "tool_failed",
              message:
                "The task stopped after a tool was refused or failed. Inspect the Raya session before continuing.",
            },
          })
          return
        }
        if (
          !message.info.time.completed ||
          !message.info.finish ||
          message.info.finish === "tool-calls" ||
          message.parts.some(
            (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
          )
        ) {
          yield* finish(id, callID, {
            status: "unknown",
            error: {
              code: "incomplete",
              message: "The runtime has not supplied a final assistant result for this voice call.",
            },
          })
          return
        }
        yield* finish(id, callID, {
          status: "completed",
          result: receipt,
        })
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.gen(function* () {
                const stored = yield* read(id)
                const call = stored.calls[digest(callID)]?.receipt
                if (!call || stored.owner !== owner || !pending(call)) return
                yield* finish(id, callID, {
                  status: "unknown",
                  error: {
                    code: "interrupted",
                    message: "Voice execution ended without a final result. This call will not be replayed.",
                  },
                })
              })
            : Effect.void,
        ),
      )

    const reserve = (input: typeof OpenAIReserve.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!Schema.is(VoiceKey)(secret)) return yield* refuse("unauthorized", "Invalid voice capability.")
        if (!Schema.is(OpenAIReserve)(input)) return yield* refuse("invalid", "Invalid voice reservation request.")
        const dir = yield* canonical(directory)
        const parent = yield* deps.sessions.get(input.parentSessionID)
        if ((yield* canonical(parent.directory)) !== dir)
          return yield* refuse("conflict", "Parent session belongs to another directory.")
        const id = digest(JSON.stringify([dir, input.requestID]))
        const proof = reservation(input, secret, dir)
        return yield* locked(
          `reservation:${id}`,
          Effect.gen(function* () {
            const prior = reservations.get(id)
            if (prior) {
              if (prior.fingerprint !== proof)
                return yield* refuse("conflict", "Voice reservation identity was reused with different input.")
              return reserved(prior.input, prior)
            }
            if (reservations.size >= 64)
              return yield* refuse("conflict", "Voice reservation capacity is held by unresolved calls.")
            const lease = deps.admissions
              ? yield* deps.admissions(parent.id, `voice:${proof}`)
              : {
                  amount: undefined,
                  dispatch: Effect.void,
                  finish: Effect.void,
                  release: Effect.void,
                }
            const entry = { fingerprint: proof, input, lease }
            reservations.set(id, entry)
            const dispatched = yield* lease.dispatch.pipe(Effect.exit)
            if (Exit.isFailure(dispatched)) {
              reservations.delete(id)
              yield* lease.release
              return yield* Effect.failCause(dispatched.cause)
            }
            return reserved(input, entry)
          }).pipe(Effect.uninterruptible),
        )
      })

    const release = (input: typeof OpenAIReserve.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!Schema.is(VoiceKey)(secret)) return yield* refuse("unauthorized", "Invalid voice capability.")
        if (!Schema.is(OpenAIReserve)(input)) return yield* refuse("invalid", "Invalid voice reservation request.")
        const dir = yield* canonical(directory)
        const parent = yield* deps.sessions.get(input.parentSessionID)
        if ((yield* canonical(parent.directory)) !== dir)
          return yield* refuse("conflict", "Parent session belongs to another directory.")
        const id = digest(JSON.stringify([dir, input.requestID]))
        const proof = reservation(input, secret, dir)
        return yield* locked(
          `reservation:${id}`,
          Effect.gen(function* () {
            const entry = reservations.get(id)
            if (!entry) {
              if (input.model === "gpt-live-1" || input.model === "gpt-live-transcribe")
                return yield* refuse("conflict", "Live reservation ownership cannot be released without its binding.")
              if (deps.completions) yield* deps.completions(parent.id, `voice:${proof}`)
              return { ...reserved(input), status: "released" as const }
            }
            if (entry.fingerprint !== proof)
              return yield* refuse("conflict", "Voice reservation identity was reused with different input.")
            if (entry.bound) return yield* refuse("conflict", "A provider call is using this voice reservation.")
            yield* finishReservation(id, entry)
            yield* entry.lease.release
            return { ...reserved(input, entry), status: "released" as const }
          }).pipe(Effect.uninterruptible),
        )
      })

    const bind = (input: typeof OpenAIStart.Type, secret: string, directory: string, accounting = false) =>
      Effect.gen(function* () {
        if (!Schema.is(VoiceKey)(secret)) return yield* refuse("unauthorized", "Invalid voice capability.")
        const dir = yield* canonical(directory)
        const parent = yield* deps.sessions.get(input.parentSessionID)
        if ((yield* canonical(parent.directory)) !== dir)
          return yield* refuse("conflict", "Parent session belongs to another directory.")
        const id = `rov_${digest(JSON.stringify([dir, input.providerCallID])).slice(0, 48)}`
        const model = input.model ?? "gpt-realtime-2.1"
        if (accounting && (model !== "gpt-live-1" || input.transcriptionRequestID))
          return yield* refuse("invalid", "Only Live setup receipts can create accounting bindings.")
        const reservationInput = { parentSessionID: parent.id, requestID: input.requestID, model }
        const reservationID = digest(JSON.stringify([dir, input.requestID]))
        if (
          input.transcriptionRequestID &&
          (model !== "gpt-realtime-2.1" || input.transcriptionRequestID === input.requestID)
        )
          return yield* refuse("invalid", "Invalid transcription reservation identity.")
        const transcriptionInput = input.transcriptionRequestID
          ? {
              parentSessionID: parent.id,
              requestID: input.transcriptionRequestID,
              model: "gpt-live-transcribe" as const,
            }
          : undefined
        const transcriptionID = transcriptionInput
          ? digest(JSON.stringify([dir, transcriptionInput.requestID]))
          : undefined
        const work = locked(
          id,
          Effect.gen(function* () {
            const prior = yield* load(id, secret, dir).pipe(
              Effect.catchTag("VoiceError", (error) =>
                error.code === "missing" ? Effect.succeed(undefined) : Effect.fail(error),
              ),
            )
            const admission = reservations.get(reservationID)
            const proof = reservation(reservationInput, secret, dir)
            const transcriptionAdmission = transcriptionID ? reservations.get(transcriptionID) : undefined
            const transcriptionProof = transcriptionInput ? reservation(transcriptionInput, secret, dir) : undefined
            if (prior) {
              if (prior.binding.handoff?.phase === "candidate" || prior.binding.handoff?.phase === "ready")
                return yield* refuse("conflict", "Prepared voice bindings require the handoff protocol.")
              if (
                prior.requestID !== input.requestID ||
                prior.transcriptionRequestID !== input.transcriptionRequestID ||
                prior.binding.parentSessionID !== parent.id ||
                prior.binding.model !== model
              )
                return yield* refuse("conflict", "Provider call already has another binding.")
              if (transcriptionAdmission) {
                if (transcriptionAdmission.fingerprint !== transcriptionProof)
                  return yield* refuse("conflict", "Transcription reservation does not match the provider binding.")
                transcriptionAdmission.bound = true
              }
              if (admission) {
                if (admission.fingerprint !== proof)
                  return yield* refuse("conflict", "Voice reservation does not match the provider binding.")
                if (model === "gpt-live-1") admission.bound = true
                if (model !== "gpt-live-1") yield* releaseReservation(reservationID, admission)
              }
              return visible(prior)
            }
            if (!admission || admission.fingerprint !== proof)
              return yield* refuse("conflict", "Reserve voice budget before starting the provider call.")
            if (
              transcriptionInput &&
              (!transcriptionAdmission || transcriptionAdmission.fingerprint !== transcriptionProof)
            )
              return yield* refuse("conflict", "Reserve transcription budget before starting the provider call.")
            const now = Date.now()
            const stored: Stored = {
              owner,
              hash: digest(secret),
              requestID: input.requestID,
              ...(input.transcriptionRequestID ? { transcriptionRequestID: input.transcriptionRequestID } : {}),
              calls: {},
              binding: {
                id,
                generation: crypto.randomUUID(),
                parentSessionID: parent.id,
                directory: dir,
                providerCallID: input.providerCallID,
                model,
                status: accounting ? "closed" : "active",
                createdAt: now,
                expiresAt: now + 60 * 60 * 1000,
              },
            }
            const current = yield* entries(stored)
            if (
              !accounting &&
              current.some((entry) => !entry.binding.handoff || entry.binding.handoff.phase === "active")
            )
              return yield* refuse("conflict", "Another voice binding owns this parent.")
            if (
              yield* store
                .create(stored)
                .pipe(Effect.mapError((error) => new VoiceError({ code: error.code, message: error.message })))
            ) {
              if (transcriptionAdmission) transcriptionAdmission.bound = true
              if (model === "gpt-live-1") admission.bound = true
              if (model !== "gpt-live-1") yield* releaseReservation(reservationID, admission)
              return stored.binding
            }
            const existing = yield* load(id, secret, dir)
            if (
              existing.requestID !== input.requestID ||
              existing.transcriptionRequestID !== input.transcriptionRequestID ||
              existing.binding.parentSessionID !== parent.id ||
              existing.binding.model !== model
            )
              return yield* refuse("conflict", "Provider call already has another binding.")
            if (transcriptionAdmission) transcriptionAdmission.bound = true
            if (model === "gpt-live-1") admission.bound = true
            if (model !== "gpt-live-1") yield* releaseReservation(reservationID, admission)
            return visible(existing)
          }),
        )
        const grouped = locked(`parent:${digest(JSON.stringify([dir, parent.id]))}`, work)
        const guarded = transcriptionID ? locked(`reservation:${transcriptionID}`, grouped) : grouped
        return yield* locked(`reservation:${reservationID}`, guarded)
      })
    const start = (input: typeof OpenAIStart.Type, secret: string, directory: string) => bind(input, secret, directory)
    const settle = (input: typeof OpenAIStart.Type, secret: string, directory: string) =>
      bind(input, secret, directory, true)
    const stage = (id: string, input: typeof OpenAIImageInput.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        const initial = yield* load(id, secret, directory, input.generation)
        return yield* group(
          initial,
          locked(
            id,
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, input.generation)
              yield* authority(stored)
              if (!Schema.is(OpenAIImageInput)(input)) return yield* refuse("invalid", "Invalid image staging payload.")
              const parent = yield* deps.sessions.get(stored.binding.parentSessionID)
              if ((yield* canonical(parent.directory)) !== stored.binding.directory)
                return yield* refuse("conflict", "Parent directory changed.")
              const bytes = decode(input.mime, input.data)
              if (!bytes)
                return yield* refuse(
                  "invalid",
                  "Image must be canonical base64 with a matching JPEG, PNG or WebP signature, at most 256 KiB.",
                )
              const image: Image = {
                data: input.data,
                receipt: {
                  id: input.id,
                  mime: input.mime,
                  bytes: bytes.length,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                },
              }
              const prior = stored.images?.[digest(input.id)]
              if (prior) {
                if (prior.data !== image.data || JSON.stringify(prior.receipt) !== JSON.stringify(image.receipt))
                  return yield* refuse("conflict", "Image ID already names different retained bytes.")
                return prior.receipt
              }
              if (Object.keys(stored.images ?? {}).length >= 8)
                return yield* refuse("conflict", "Voice binding image limit reached.")
              stored.images = { ...stored.images, [digest(input.id)]: image }
              yield* save(stored)
              return image.receipt
            }).pipe(Effect.uninterruptible),
          ),
        )
      })
    const meter = (id: string, input: typeof OpenAIUsageInput.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!Schema.is(OpenAIUsageInput)(input)) return yield* refuse("invalid", "Invalid provider usage receipt.")
        const initial = yield* load(id, secret, directory, input.generation)
        if (input.reservationID && (input.receipt.kind !== "response" || input.receipt.model !== "gpt-realtime-2.1"))
          return yield* refuse("invalid", "Only a Realtime response can settle a response reservation.")
        const reserve = input.reservationID
          ? {
              parentSessionID: initial.binding.parentSessionID,
              requestID: input.reservationID,
              model: "gpt-realtime-2.1" as const,
            }
          : undefined
        const key = reserve ? digest(JSON.stringify([initial.binding.directory, reserve.requestID])) : undefined
        const identity = reserve ? `voice:${reservation(reserve, secret, initial.binding.directory)}` : undefined
        const work = locked(
          id,
          Effect.gen(function* () {
            const stored = yield* load(id, secret, directory, input.generation)
            yield* active(stored)
            if (!valid(input.receipt)) return yield* refuse("invalid", "Invalid provider usage receipt.")
            yield* ledger(stored)
            const index = digest(`${input.receipt.kind}:${input.receipt.id}`)
            const prior = stored.usage?.[index]
            const saved = stored.usageReservations?.[index]
            if (prior && saved !== identity && (saved !== undefined || identity !== undefined))
              return yield* refuse("conflict", "Provider usage reservation identity changed.")
            const entry = key ? reservations.get(key) : undefined
            if (entry && identity !== `voice:${entry.fingerprint}`)
              return yield* refuse("conflict", "Provider usage reservation does not match its preflight.")
            const retain = charge(stored, input.receipt, identity)
            if (prior) {
              if (fingerprint(prior) !== fingerprint(input.receipt))
                return yield* refuse("conflict", "Provider usage identity was reused with different counts.")
              yield* retain
              if (key) {
                reservations.delete(key)
                if (entry) yield* entry.lease.release
              }
              return prior
            }
            if (Object.keys(stored.usage ?? {}).length >= 512)
              return yield* refuse("conflict", "Voice usage receipt limit reached.")
            stored.usage = { ...stored.usage, [index]: input.receipt }
            if (identity) stored.usageReservations = { ...stored.usageReservations, [index]: identity }
            yield* save(stored)
            yield* retain
            if (key) {
              reservations.delete(key)
              if (entry) yield* entry.lease.release
            }
            return input.receipt
          }).pipe(Effect.uninterruptible),
        )
        return yield* key ? locked(`reservation:${key}`, work) : work
      })
    const usage = (id: string, generation: string, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, generation)
          const receipts = yield* ledger(stored)
          yield* Effect.forEach(receipts, (entry) => charge(stored, entry.receipt, entry.identity), {
            concurrency: 1,
            discard: true,
          })
          return { receipts: receipts.map((entry) => entry.receipt) }
        }),
      )
    const submit = (id: string, input: Input, secret: string, directory: string, cursor?: number) =>
      Effect.gen(function* () {
        const initial = yield* load(id, secret, directory, input.generation)
        return yield* group(
          initial,
          locked(
            id,
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, input.generation)
              yield* active(stored)
              if (stored.binding.model !== (cursor === undefined ? "gpt-realtime-2.1" : "gpt-live-1"))
                return yield* refuse("conflict", "Voice admission protocol does not match the binding.")
              const prior = stored.calls[digest(input.callID)]
              if (prior) {
                if (
                  prior.input.arguments.request !== input.arguments.request ||
                  JSON.stringify(prior.input.arguments.images ?? []) !== JSON.stringify(input.arguments.images ?? []) ||
                  prior.input.function !== input.function ||
                  prior.input.responseID !== input.responseID ||
                  prior.input.itemID !== input.itemID
                )
                  return yield* refuse("conflict", "Function call ID was reused with different input.")
                return prior.receipt
              }
              yield* authority(stored)
              if (cursor !== undefined && cursor <= (stored.liveCursor ?? 0))
                return yield* refuse("conflict", "No new live request context is available.")
              if (Object.keys(stored.calls).length >= 64)
                return yield* refuse("conflict", "Voice binding call limit reached; start a new voice connection.")
              if ((yield* outstanding(stored)).length >= 64)
                return yield* refuse("conflict", "Retained work delivery allowance was exhausted.")
              if (
                (yield* entries(stored)).some((entry) =>
                  Object.values(entry.calls).some((call) => pending(call.receipt)),
                )
              )
                return yield* refuse("conflict", "Voice work is already running.")
              const parent = yield* deps.sessions.get(stored.binding.parentSessionID)
              if ((yield* canonical(parent.directory)) !== stored.binding.directory)
                return yield* refuse("conflict", "Parent directory changed.")
              const selected = yield* images(stored, input.arguments.images)
              const now = Date.now()
              const call: Call = {
                id: crypto.randomUUID(),
                callID: input.callID,
                messageID: MessageID.ascending(),
                parentSessionID: parent.id,
                status: "accepted",
                ...(selected.length ? { images: selected.map((image) => image.receipt) } : {}),
                createdAt: now,
                updatedAt: now,
              }
              stored.calls[digest(input.callID)] = { input, receipt: call }
              const ref = reference(stored, call)
              stored.deliveries = {
                ...stored.deliveries,
                [ref.id]: {
                  version: 1,
                  reference: ref,
                  epoch: 0,
                  phase: "pending",
                  acks: [],
                },
              }
              if (cursor !== undefined) stored.liveCursor = cursor
              // Persist before scheduling. A crash between these steps remains an unknown intent, never replayed.
              yield* save(stored)
              yield* run(id, input.callID).pipe(Effect.interruptible, Effect.forkIn(scope))
              return call
            }).pipe(Effect.uninterruptible),
          ),
        )
      })
    const delegate = (id: string, input: typeof LiveCall.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!liveValid(input)) return yield* refuse("invalid", "Live delegation context is invalid or incomplete.")
        const cursor = Math.max(
          ...input.context.fragments
            .filter((part) => part.speaker === "user" && !part.client && part.text.trim())
            .map((part) => part.sequence),
        )
        return yield* submit(
          id,
          {
            generation: input.generation,
            callID: `liv_${digest(input.context.delegation).slice(0, 48)}`,
            function: "raya_work",
            arguments: { request: livePrompt(input), ...(input.images ? { images: input.images } : {}) },
          },
          secret,
          directory,
          cursor,
        )
      })
    const duration = (id: string, input: typeof LiveMeter.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!Schema.is(LiveMeter)(input) || !Number.isFinite(input.receipt.seconds))
          return yield* refuse("invalid", "Invalid Live duration receipt.")
        const initial = yield* load(id, secret, directory, input.generation)
        const reservationID = digest(JSON.stringify([initial.binding.directory, initial.requestID]))
        return yield* locked(
          `reservation:${reservationID}`,
          locked(
            id,
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, input.generation)
              if (stored.owner !== owner || stored.binding.model !== "gpt-live-1")
                return yield* refuse("conflict", "Live duration belongs to another voice binding.")
              const retain = deps.charges
                ? deps.charges({
                    sessionID: stored.binding.parentSessionID,
                    id: `gpt-live:${stored.binding.id}:${input.receipt.id}`,
                    callID: stored.binding.id,
                    at: stored.binding.createdAt,
                    seconds: input.receipt.seconds,
                  })
                : Effect.void
              if (stored.duration) {
                if (JSON.stringify(stored.duration) !== JSON.stringify(input.receipt))
                  return yield* refuse("conflict", "Final Live duration is immutable.")
                yield* retain
                yield* resolveLive(stored, secret, "recorded")
                return stored.duration
              }
              stored.duration = input.receipt
              yield* save(stored)
              yield* retain
              yield* resolveLive(stored, secret, "recorded")
              return input.receipt
            }).pipe(Effect.uninterruptible),
          ),
        )
      })
    const get = (id: string, callID: string, generation: string, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, generation)
          const call = stored.calls[digest(callID)]
          if (!call) return yield* refuse("missing", "Voice call not found.")
          return receipt(stored, call.receipt)
        }),
      )
    const cancel = (id: string, callID: string, generation: string, secret: string, directory: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const call = yield* locked(
            id,
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, generation)
              const entry = stored.calls[digest(callID)]
              if (!entry) return yield* refuse("missing", "Voice call not found.")
              if (stored.owner !== owner) return { receipt: receipt(stored, entry.receipt), stopping: false }
              if (pending(entry.receipt)) {
                if (stored.binding.handoff?.phase === "retiring")
                  return yield* refuse("conflict", "Retained work cancellation belongs to the active replacement.")
                entry.receipt = { ...entry.receipt, status: "cancelled", updatedAt: Date.now() }
                yield* save(stored)
                return { receipt: entry.receipt, stopping: true }
              }
              return { receipt: entry.receipt, stopping: false }
            }),
          )
          if (call.stopping) {
            // A disconnected HTTP waiter must not abandon a persisted cancellation request.
            const stopping = yield* deps.workers
              .cancel(call.receipt.parentSessionID, call.receipt.messageID)
              .pipe(Effect.interruptible, Effect.forkIn(scope))
            yield* restore(Fiber.join(stopping))
          }
          return call.receipt
        }),
      )
    const close = (id: string, generation: string, secret: string, directory: string) =>
      Effect.gen(function* () {
        const initial = yield* load(id, secret, directory, generation)
        if (initial.binding.model !== "gpt-live-1" && !initial.transcriptionRequestID)
          return yield* locked(
            id,
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, generation)
              if (stored.owner === owner) {
                stored.binding = { ...stored.binding, status: "closed" }
                yield* save(stored)
              }
              return visible(stored)
            }),
          )
        const requestID = initial.binding.model === "gpt-live-1" ? initial.requestID : initial.transcriptionRequestID!
        const reservationID = digest(JSON.stringify([initial.binding.directory, requestID]))
        return yield* locked(
          `reservation:${reservationID}`,
          locked(
            id,
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, generation)
              if (stored.owner !== owner && stored.binding.status !== "closed") return visible(stored)
              // Closing speech admission does not revoke already-admitted parent-session work.
              if (stored.owner === owner && stored.binding.status !== "closed") {
                stored.binding = { ...stored.binding, status: "closed" }
                yield* save(stored)
              }
              if (stored.transcriptionRequestID) {
                yield* settleTranscription(stored)
                return stored.binding
              }
              // Stop the heartbeat but leave the dispatched lease durable. A late final duration can
              // still reconcile it; otherwise the existing expiry path records an unknown charge.
              if (!stored.duration) yield* resolveLive(stored, secret, "deferred")
              return stored.binding
            }),
          ),
        )
      })
    const parent = (stored: Stored) =>
      Effect.gen(function* () {
        const session = yield* deps.sessions.get(stored.binding.parentSessionID)
        if ((yield* canonical(session.directory)) !== stored.binding.directory)
          return yield* refuse("conflict", "Voice parent directory changed.")
      })
    const checkpoint = (stored: Stored) => ({
      sourceRevision: stored.spoken?.revision ?? 0,
      sourceHash: digest(Spoken.fingerprint(stored.spoken ?? { revision: 0, items: [], incomplete: false })),
    })
    const related = (source: Stored, candidate: Stored) => {
      const relation = candidate.binding.handoff
      const prior = source.binding.handoff
      if (
        !relation ||
        !prior ||
        relation.sourceID !== source.binding.id ||
        relation.sourceGeneration !== source.binding.generation ||
        relation.candidateID !== candidate.binding.id ||
        relation.candidateGeneration !== candidate.binding.generation ||
        prior.sourceID !== relation.sourceID ||
        prior.sourceGeneration !== relation.sourceGeneration ||
        prior.candidateID !== relation.candidateID ||
        prior.candidateGeneration !== relation.candidateGeneration ||
        prior.requestID !== relation.requestID ||
        source.owner !== owner ||
        candidate.owner !== owner ||
        source.binding.model !== candidate.binding.model ||
        source.binding.directory !== candidate.binding.directory ||
        source.binding.parentSessionID !== candidate.binding.parentSessionID
      )
        return refuse("conflict", "Voice handoff relation changed.")
      return Effect.void
    }
    const candidate = (
      id: string,
      input: typeof OpenAIHandoffCandidate.Type,
      secret: string,
      target: string,
      directory: string,
    ) =>
      Effect.gen(function* () {
        if (!validHandoff(input, "candidate")) return yield* refuse("invalid", "Invalid handoff candidate.")
        if (!Schema.is(VoiceKey)(target) || target.length !== 64 || target === secret)
          return yield* refuse("unauthorized", "Handoff requires a distinct target capability.")
        const initial = yield* load(id, secret, directory, input.generation)
        const dir = initial.binding.directory
        if (
          input.reservationID === initial.requestID ||
          (input.transcriptionRequestID &&
            (input.transcriptionRequestID === initial.transcriptionRequestID ||
              input.transcriptionRequestID === input.reservationID))
        )
          return yield* refuse("conflict", "Handoff requires distinct reservation identities.")
        const reservationID = digest(JSON.stringify([dir, input.reservationID]))
        const transcriptionID = input.transcriptionRequestID
          ? digest(JSON.stringify([dir, input.transcriptionRequestID]))
          : undefined
        const next = `rov_${digest(JSON.stringify([dir, input.providerCallID])).slice(0, 48)}`
        if (next === id) return yield* refuse("conflict", "Handoff provider call must change.")
        const work = group(
          initial,
          locked(
            id,
            locked(
              next,
              Effect.gen(function* () {
                const source = yield* load(id, secret, directory, input.generation)
                yield* authority(source)
                yield* parent(source)
                const existing = yield* load(next, target, directory).pipe(
                  Effect.catchTag("VoiceError", (error) =>
                    error.code === "missing" ? Effect.succeed(undefined) : Effect.fail(error),
                  ),
                )
                if (existing) {
                  yield* related(source, existing)
                  if (
                    existing.binding.handoff?.requestID !== input.requestID ||
                    existing.requestID !== input.reservationID ||
                    existing.transcriptionRequestID !== input.transcriptionRequestID
                  )
                    return yield* refuse("conflict", "Handoff request was reused with different input.")
                  return visible(existing)
                }
                if (
                  (yield* entries(source)).some(
                    (entry) => entry.binding.id !== id && entry.binding.handoff?.phase !== "retiring",
                  )
                )
                  return yield* refuse("conflict", "Another voice replacement is already prepared.")
                const model = source.binding.model
                if (input.transcriptionRequestID && model !== "gpt-realtime-2.1")
                  return yield* refuse("invalid", "Transcription reservation requires a Realtime binding.")
                const admission = reservations.get(reservationID)
                const proof = reservation(
                  { parentSessionID: source.binding.parentSessionID, requestID: input.reservationID, model },
                  target,
                  dir,
                )
                if (!admission || admission.fingerprint !== proof)
                  return yield* refuse("conflict", "Reserve target voice budget before warming replacement.")
                const transcription = transcriptionID ? reservations.get(transcriptionID) : undefined
                if (
                  transcriptionID &&
                  (!transcription ||
                    transcription.fingerprint !==
                      reservation(
                        {
                          parentSessionID: source.binding.parentSessionID,
                          requestID: input.transcriptionRequestID!,
                          model: "gpt-live-transcribe",
                        },
                        target,
                        dir,
                      ))
                )
                  return yield* refuse("conflict", "Target transcription reservation changed.")
                const now = Date.now()
                const generation = crypto.randomUUID()
                const relation = {
                  version: 1 as const,
                  requestID: input.requestID,
                  sourceID: id,
                  sourceGeneration: source.binding.generation,
                  candidateID: next,
                  candidateGeneration: generation,
                }
                const stored: Stored = {
                  owner,
                  hash: digest(target),
                  requestID: input.reservationID,
                  ...(input.transcriptionRequestID ? { transcriptionRequestID: input.transcriptionRequestID } : {}),
                  calls: {},
                  binding: {
                    id: next,
                    generation,
                    parentSessionID: source.binding.parentSessionID,
                    directory: dir,
                    providerCallID: input.providerCallID,
                    model,
                    status: "active",
                    createdAt: now,
                    expiresAt: now + 3600000,
                    handoff: { ...relation, phase: "candidate" },
                  },
                }
                source.binding = { ...source.binding, handoff: { ...relation, phase: "active" } }
                yield* store
                  .pair(source, stored, true)
                  .pipe(Effect.mapError((error) => new VoiceError({ code: error.code, message: error.message })))
                if (transcription) transcription.bound = true
                if (model === "gpt-live-1") admission.bound = true
                if (model !== "gpt-live-1") yield* releaseReservation(reservationID, admission)
                return stored.binding
              }).pipe(Effect.uninterruptible),
            ),
          ),
        )
        return yield* locked(
          `reservation:${reservationID}`,
          transcriptionID ? locked(`reservation:${transcriptionID}`, work) : work,
        )
      })
    const handoffContext = (id: string, generation: string, secret: string, directory: string) =>
      Effect.gen(function* () {
        const initial = yield* load(id, secret, directory, generation)
        const relation = initial.binding.handoff
        if (
          !relation ||
          relation.sourceID === id ||
          relation.candidateID !== id ||
          (relation.phase !== "candidate" && relation.phase !== "ready")
        )
          return yield* refuse("conflict", "Voice binding has no warming handoff context.")
        return yield* group(
          initial,
          locked(
            relation.sourceID,
            locked(
              id,
              Effect.gen(function* () {
                const candidate = yield* load(id, secret, directory, generation)
                yield* active(candidate)
                if (candidate.binding.handoff?.phase !== "candidate" && candidate.binding.handoff?.phase !== "ready")
                  return yield* refuse("conflict", "Voice replacement is no longer warming.")
                const source = yield* read(relation.sourceID)
                yield* related(source, candidate)
                yield* authority(source)
                yield* parent(source)
                const ordered = source.spoken ? Spoken.ordered(source.spoken) : { items: [], incomplete: false }
                const items: (typeof OpenAIHandoffContext.Type)["items"][number][] = []
                let bytes = 0
                let incomplete = ordered.incomplete
                for (const item of ordered.items) {
                  if (item.state !== "final") {
                    incomplete = true
                    continue
                  }
                  if (item.role === "other" || !item.text) continue
                  items.push({ itemID: item.id, role: item.role, text: item.text })
                  bytes += Buffer.byteLength(item.text, "utf8")
                  while (bytes > 8192 || items.length > 128) {
                    bytes -= Buffer.byteLength(items.shift()!.text, "utf8")
                    incomplete = true
                  }
                }
                return {
                  version: 1 as const,
                  sourceID: source.binding.id,
                  sourceGeneration: source.binding.generation,
                  ...checkpoint(source),
                  items,
                  incomplete,
                }
              }),
            ),
          ),
        )
      })
    const ready = (id: string, input: typeof OpenAIHandoffReady.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!validHandoff(input, "ready")) return yield* refuse("invalid", "Invalid handoff readiness.")
        const initial = yield* load(id, secret, directory, input.generation)
        const relation = initial.binding.handoff
        if (
          !relation ||
          relation.sourceID === id ||
          relation.candidateID !== id ||
          (relation.phase !== "candidate" && relation.phase !== "ready")
        )
          return yield* refuse("conflict", "Voice binding is not a warming replacement.")
        return yield* group(
          initial,
          locked(
            relation.sourceID,
            locked(
              id,
              Effect.gen(function* () {
                const stored = yield* load(id, secret, directory, input.generation)
                yield* active(stored)
                const source = yield* read(relation.sourceID)
                yield* related(source, stored)
                yield* authority(source)
                yield* parent(source)
                const current = checkpoint(source)
                if (
                  current.sourceRevision !== input.sourceRevision ||
                  current.sourceHash !== input.sourceHash ||
                  source.spoken?.items.some((item) => item.state === "pending")
                )
                  return yield* refuse("conflict", "Voice source checkpoint changed or is unfinished.")
                const prior = stored.binding.handoff!
                if (prior.phase === "ready") {
                  if (
                    prior.readyID !== input.readyID ||
                    prior.sourceRevision !== input.sourceRevision ||
                    prior.sourceHash !== input.sourceHash
                  )
                    return yield* refuse("conflict", "Readiness identity was reused with different input.")
                  if (prior.deadline! <= Date.now()) return yield* refuse("expired", "Voice readiness expired.")
                  return stored.binding
                }
                if (prior.phase !== "candidate") return yield* refuse("conflict", "Voice replacement is not warming.")
                stored.binding = {
                  ...stored.binding,
                  handoff: {
                    ...prior,
                    phase: "ready",
                    sourceRevision: input.sourceRevision,
                    sourceHash: input.sourceHash,
                    readyID: input.readyID,
                    deadline: Math.min(Date.now() + 30000, source.binding.expiresAt, stored.binding.expiresAt),
                  },
                }
                yield* save(stored)
                return stored.binding
              }).pipe(Effect.uninterruptible),
            ),
          ),
        )
      })
    const rearm = (id: string, input: typeof OpenAIHandoffRearm.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!validHandoff(input, "rearm") || input.priorReadyID === input.readyID)
          return yield* refuse("invalid", "Invalid handoff rearming.")
        const initial = yield* load(id, secret, directory, input.generation)
        const relation = initial.binding.handoff
        const recorded = initial.rearms?.find((receipt) => receipt.readyID === input.readyID)
        // A completed retry is a read; it must never acquire a later relation's source lock.
        if (recorded)
          return yield* locked(
            id,
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, input.generation)
              if (stored.owner !== owner)
                return yield* refuse("conflict", "Handoff belongs to an earlier backend owner.")
              const receipt = stored.rearms?.find((value) => value.readyID === input.readyID)
              if (
                !receipt ||
                receipt.priorReadyID !== input.priorReadyID ||
                receipt.sourceRevision !== input.sourceRevision ||
                receipt.sourceHash !== input.sourceHash
              )
                return yield* refuse("conflict", "Rearming identity was reused with different input.")
              return receipt
            }),
          )
        if (!relation || relation.sourceID === id || relation.candidateID !== id || relation.phase !== "ready")
          return yield* refuse("conflict", "Voice replacement is not ready for rearming.")
        return yield* group(
          initial,
          locked(
            relation.sourceID,
            locked(
              id,
              Effect.gen(function* () {
                const stored = yield* load(id, secret, directory, input.generation)
                if (stored.owner !== owner)
                  return yield* refuse("conflict", "Handoff belongs to an earlier backend owner.")
                const duplicate = stored.rearms?.find((receipt) => receipt.readyID === input.readyID)
                if (duplicate) {
                  if (
                    duplicate.priorReadyID !== input.priorReadyID ||
                    duplicate.sourceRevision !== input.sourceRevision ||
                    duplicate.sourceHash !== input.sourceHash
                  )
                    return yield* refuse("conflict", "Rearming identity was reused with different input.")
                  return duplicate
                }
                yield* active(stored)
                const source = yield* read(relation.sourceID)
                yield* related(source, stored)
                yield* authority(source)
                yield* parent(source)
                const prior = stored.binding.handoff!
                if (
                  prior.phase !== "ready" ||
                  prior.readyID !== input.priorReadyID ||
                  input.readyID === prior.readyID ||
                  stored.rearms?.some((receipt) => receipt.priorReadyID === input.readyID)
                )
                  return yield* refuse("conflict", "Voice readiness changed before rearming.")
                if (prior.deadline! <= Date.now()) return yield* refuse("expired", "Voice readiness expired.")
                if ((stored.rearms?.length ?? 0) >= 16)
                  return yield* refuse("conflict", "Voice rearming limit reached.")
                const current = checkpoint(source)
                if (
                  current.sourceRevision !== input.sourceRevision ||
                  current.sourceHash !== input.sourceHash ||
                  source.spoken?.items.some((item) => item.state === "pending")
                )
                  return yield* refuse("conflict", "Voice source checkpoint changed or is unfinished.")
                const receipt: typeof OpenAIHandoffRearmReceipt.Type = {
                  version: 1,
                  requestID: prior.requestID,
                  sourceID: prior.sourceID,
                  sourceGeneration: prior.sourceGeneration,
                  candidateID: id,
                  candidateGeneration: input.generation,
                  priorReadyID: input.priorReadyID,
                  readyID: input.readyID,
                  sourceRevision: input.sourceRevision,
                  sourceHash: input.sourceHash,
                  deadline: prior.deadline!,
                  rearmedAt: Date.now(),
                }
                stored.binding = {
                  ...stored.binding,
                  handoff: {
                    ...prior,
                    readyID: input.readyID,
                    sourceRevision: input.sourceRevision,
                    sourceHash: input.sourceHash,
                  },
                }
                stored.rearms = [...(stored.rearms ?? []), receipt]
                yield* save(stored)
                return receipt
              }).pipe(Effect.uninterruptible),
            ),
          ),
        )
      })
    const activate = (id: string, input: typeof OpenAIHandoffActivate.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!validHandoff(input, "activate")) return yield* refuse("invalid", "Invalid handoff activation.")
        const initial = yield* load(id, secret, directory, input.generation)
        if (input.candidateID === id) return yield* refuse("conflict", "Handoff target must differ.")
        return yield* group(
          initial,
          locked(
            id,
            locked(
              input.candidateID,
              Effect.gen(function* () {
                const source = yield* load(id, secret, directory, input.generation)
                if (source.owner !== owner)
                  return yield* refuse("conflict", "Handoff belongs to an earlier backend owner.")
                const prior = source.binding.handoff!
                const match = (value: typeof OpenAIHandoffReceipt.Type) =>
                  value.requestID === input.requestID &&
                  value.sourceGeneration === input.generation &&
                  value.candidateID === input.candidateID &&
                  value.candidateGeneration === input.candidateGeneration &&
                  value.readyID === input.readyID &&
                  value.sourceRevision === input.sourceRevision &&
                  value.sourceHash === input.sourceHash
                if (prior?.receipt) {
                  if (!match(prior.receipt))
                    return yield* refuse("conflict", "Activation identity was reused with different input.")
                  return prior.receipt
                }
                const candidate = yield* read(input.candidateID)
                yield* related(source, candidate)
                yield* authority(source)
                yield* active(candidate)
                yield* parent(source)
                const prepared = candidate.binding.handoff!
                const current = checkpoint(source)
                if (
                  prepared.phase !== "ready" ||
                  prepared.deadline! <= Date.now() ||
                  prepared.readyID !== input.readyID ||
                  prepared.requestID !== input.requestID ||
                  candidate.binding.generation !== input.candidateGeneration ||
                  prepared.sourceRevision !== input.sourceRevision ||
                  prepared.sourceHash !== input.sourceHash ||
                  current.sourceRevision !== input.sourceRevision ||
                  current.sourceHash !== input.sourceHash ||
                  source.spoken?.items.some((item) => item.state === "pending") ||
                  (yield* entries(source)).some((entry) =>
                    Object.values(entry.calls).some((call) => pending(call.receipt)),
                  )
                )
                  return yield* refuse(
                    "conflict",
                    "Voice handoff checkpoint is no longer ready or work remains pending.",
                  )
                const receipt: typeof OpenAIHandoffReceipt.Type = {
                  version: 1,
                  requestID: input.requestID,
                  sourceID: id,
                  sourceGeneration: input.generation,
                  candidateID: input.candidateID,
                  candidateGeneration: input.candidateGeneration,
                  sourceRevision: input.sourceRevision,
                  sourceHash: input.sourceHash,
                  readyID: input.readyID,
                  activatedAt: Date.now(),
                }
                source.binding = { ...source.binding, handoff: { ...prepared, phase: "retiring", receipt } }
                candidate.binding = { ...candidate.binding, handoff: { ...prepared, phase: "active", receipt } }
                yield* store
                  .pair(source, candidate)
                  .pipe(Effect.mapError((error) => new VoiceError({ code: error.code, message: error.message })))
                return receipt
              }).pipe(Effect.uninterruptible),
            ),
          ),
        )
      })
    const handoffReceipt = (id: string, generation: string, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, generation)
          const receipt = stored.binding.handoff?.receipt
          if (!receipt || receipt.sourceID !== id)
            return yield* refuse("missing", "Voice activation receipt is not available.")
          return receipt
        }),
      )
    const manifest = (id: string, generation: string, secret: string, directory: string) =>
      Effect.gen(function* () {
        const initial = yield* load(id, secret, directory, generation)
        const relation = initial.binding.handoff
        if (
          !relation ||
          relation.sourceID === id ||
          relation.candidateID !== id ||
          (relation.phase !== "candidate" && relation.phase !== "ready")
        )
          return yield* refuse("conflict", "Voice binding has no retained work preparation.")
        const initialsource = yield* read(relation.sourceID)
        return yield* group(
          initial,
          locks(
            [id, relation.sourceID, ...origins(initialsource)],
            Effect.gen(function* () {
              const target = yield* load(id, secret, directory, generation)
              yield* active(target)
              const source = yield* read(relation.sourceID)
              yield* related(source, target)
              yield* authority(source)
              yield* parent(source)
              return yield* snapshot(source, target)
            }),
          ),
        )
      })
    const activateRetained = (
      id: string,
      input: typeof OpenAIHandoffTransfer.Type,
      secret: string,
      directory: string,
    ) =>
      Effect.gen(function* () {
        if (!validHandoff(input, "transfer")) return yield* refuse("invalid", "Invalid retained work activation.")
        const initial = yield* load(id, secret, directory, input.generation)
        if (input.candidateID === id) return yield* refuse("conflict", "Handoff target must differ.")
        return yield* group(
          initial,
          locks(
            [id, input.candidateID, ...origins(initial)],
            Effect.gen(function* () {
              const source = yield* load(id, secret, directory, input.generation)
              if (source.owner !== owner)
                return yield* refuse("conflict", "Handoff belongs to an earlier backend owner.")
              const saved = source.transfer
              if (saved) {
                const value = saved.activation
                if (
                  saved.manifest.manifestID !== input.manifestID ||
                  saved.manifest.hash !== input.manifestHash ||
                  value.requestID !== input.requestID ||
                  value.sourceGeneration !== input.generation ||
                  value.candidateID !== input.candidateID ||
                  value.candidateGeneration !== input.candidateGeneration ||
                  value.readyID !== input.readyID ||
                  value.sourceRevision !== input.sourceRevision ||
                  value.sourceHash !== input.sourceHash
                )
                  return yield* refuse("conflict", "Retained activation identity was reused with different input.")
                return saved
              }
              if (source.binding.handoff?.receipt)
                return yield* refuse("conflict", "Voice authority was already committed without retained work.")
              const candidate = yield* read(input.candidateID)
              yield* related(source, candidate)
              yield* authority(source)
              yield* active(candidate)
              yield* parent(source)
              const prepared = candidate.binding.handoff!
              const current = checkpoint(source)
              if (
                prepared.phase !== "ready" ||
                prepared.deadline! <= Date.now() ||
                prepared.readyID !== input.readyID ||
                prepared.requestID !== input.requestID ||
                candidate.binding.generation !== input.candidateGeneration ||
                prepared.sourceRevision !== input.sourceRevision ||
                prepared.sourceHash !== input.sourceHash ||
                current.sourceRevision !== input.sourceRevision ||
                current.sourceHash !== input.sourceHash ||
                source.spoken?.items.some((item) => item.state === "pending")
              )
                return yield* refuse("conflict", "Voice retained work checkpoint is no longer ready.")
              const manifest = yield* snapshot(source, candidate)
              if (manifest.manifestID !== input.manifestID || manifest.hash !== input.manifestHash)
                return yield* refuse("conflict", "Retained work manifest changed before activation.")
              const activation: typeof OpenAIHandoffReceipt.Type = {
                version: 1,
                requestID: input.requestID,
                sourceID: id,
                sourceGeneration: input.generation,
                candidateID: input.candidateID,
                candidateGeneration: input.candidateGeneration,
                sourceRevision: input.sourceRevision,
                sourceHash: input.sourceHash,
                readyID: input.readyID,
                activatedAt: Date.now(),
              }
              const receipt: typeof Obligations.TransferReceipt.Type = { version: 1, manifest, activation }
              source.binding = { ...source.binding, handoff: { ...prepared, phase: "retiring", receipt: activation } }
              source.transfer = receipt
              candidate.binding = {
                ...candidate.binding,
                handoff: { ...prepared, phase: "active", receipt: activation },
              }
              candidate.obligations = manifest.references
              yield* store
                .pair(source, candidate)
                .pipe(Effect.mapError((error) => new VoiceError({ code: error.code, message: error.message })))
              return receipt
            }).pipe(Effect.uninterruptible),
          ),
        )
      })
    const transferReceipt = (id: string, generation: string, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, generation)
          if (!stored.transfer || stored.transfer.activation.sourceID !== id)
            return yield* refuse("missing", "Retained activation receipt is not available.")
          return stored.transfer
        }),
      )
    const obligations = (id: string, generation: string, secret: string, directory: string) =>
      Effect.gen(function* () {
        const initial = yield* load(id, secret, directory, generation)
        return yield* group(
          initial,
          locks(
            [id, ...origins(initial)],
            Effect.gen(function* () {
              const stored = yield* load(id, secret, directory, generation)
              return { version: 1 as const, references: yield* outstanding(stored) }
            }),
          ),
        )
      })
    const obligation = (id: string, obligationID: string, generation: string, secret: string, directory: string) =>
      Effect.gen(function* () {
        const initial = yield* load(id, secret, directory, generation)
        const ref = selected(initial, obligationID)
        if (!ref) return yield* refuse("missing", "Retained work obligation was not found.")
        return yield* locks(
          [id, ref.originID],
          Effect.gen(function* () {
            const stored = yield* load(id, secret, directory, generation)
            const current = selected(stored, obligationID)
            if (!current || JSON.stringify(current) !== JSON.stringify(ref))
              return yield* refuse("conflict", "Retained work reference changed.")
            const value = yield* origin(stored, ref)
            const call = receipt(value.source, value.call)
            return {
              version: 1 as const,
              reference: ref,
              delivery: value.delivery,
              receipt: call,
              ...(!pending(call) ? { resultHash: digest(JSON.stringify(call)) } : {}),
            }
          }),
        )
      })
    const delivery = (
      id: string,
      obligationID: string,
      input: typeof Obligations.DeliveryInput.Type,
      secret: string,
      directory: string,
    ) =>
      Effect.gen(function* () {
        if (!Obligations.validInput(input)) return yield* refuse("invalid", "Invalid retained result delivery.")
        const initial = yield* load(id, secret, directory, input.generation)
        const ref = selected(initial, obligationID)
        if (!ref) return yield* refuse("missing", "Retained work obligation was not found.")
        return yield* group(
          initial,
          locks(
            [id, ref.originID],
            Effect.gen(function* () {
              const target = yield* load(id, secret, directory, input.generation)
              if (target.owner !== owner)
                return yield* refuse("conflict", "Retained delivery belongs to an earlier backend owner.")
              const current = selected(target, obligationID)
              if (!current || JSON.stringify(current) !== JSON.stringify(ref))
                return yield* refuse("conflict", "Retained work reference changed.")
              const value = yield* origin(target, ref)
              const prior = value.delivery
              const match = (offer: typeof Obligations.Offer.Type, response = offer.responseID) =>
                offer.offerID === input.offerID &&
                offer.targetID === id &&
                offer.targetGeneration === input.generation &&
                offer.providerCallID === input.providerCallID &&
                offer.itemID === input.itemID &&
                response === input.responseID &&
                offer.resultHash === input.resultHash &&
                offer.deliveryEpoch === input.deliveryEpoch
              if (input.action === "offer") {
                if (prior.offer) {
                  if (!match(prior.offer))
                    return yield* refuse("conflict", "A retained result offer is already recorded.")
                  return { version: 1 as const, reference: ref, offer: prior.offer }
                }
                yield* authority(target)
                yield* parent(target)
                if (
                  pending(value.call) ||
                  input.resultHash !== digest(JSON.stringify(value.call)) ||
                  input.providerCallID !== target.binding.providerCallID ||
                  input.deliveryEpoch !== prior.epoch + 1
                )
                  return yield* refuse("conflict", "Retained result is not ready for an exact delivery offer.")
                const offer: typeof Obligations.Offer.Type = {
                  version: 1,
                  offerID: input.offerID,
                  targetID: id,
                  targetGeneration: input.generation,
                  providerCallID: input.providerCallID,
                  itemID: input.itemID,
                  responseID: input.responseID,
                  resultHash: input.resultHash,
                  deliveryEpoch: input.deliveryEpoch,
                  offeredAt: Date.now(),
                }
                value.source.deliveries = {
                  ...value.source.deliveries,
                  [ref.id]: { ...prior, epoch: input.deliveryEpoch, phase: "offered", offer },
                }
                yield* save(value.source)
                return { version: 1 as const, reference: ref, offer }
              }
              const duplicate = prior.acks.find((ack) => ack.ackID === input.ackID)
              if (duplicate) {
                if (
                  !prior.offer ||
                  !match(prior.offer, duplicate.responseID) ||
                  duplicate.phase !== input.phase ||
                  duplicate.eventID !== input.eventID
                )
                  return yield* refuse("conflict", "Delivery acknowledgement identity was reused with different input.")
                return duplicate
              }
              // The exact original presentation lane may settle after retirement, but cannot create new work or an offer.
              yield* parent(target)
              const generated = prior.acks.find((ack) => ack.phase === "generated")
              const response =
                input.phase === "generated" ? input.responseID : (generated?.responseID ?? prior.offer?.responseID)
              if (
                !prior.offer ||
                !match(prior.offer, response) ||
                (prior.phase !== "offered" && prior.phase !== "accepted" && prior.phase !== "generated") ||
                (input.phase === "accepted" && prior.phase !== "offered") ||
                (input.phase === "generated" &&
                  (prior.phase !== "accepted" ||
                    !input.responseID ||
                    (prior.offer.responseID !== undefined && prior.offer.responseID !== input.responseID))) ||
                (input.phase === "played" && prior.phase !== "generated") ||
                prior.acks.length >= 16
              )
                return yield* refuse("conflict", "Delivery acknowledgement does not follow its retained offer.")
              const ack: typeof Obligations.AckReceipt.Type = {
                version: 1,
                generation: input.generation,
                ackID: input.ackID,
                offerID: input.offerID,
                phase: input.phase,
                eventID: input.eventID,
                providerCallID: input.providerCallID,
                itemID: input.itemID,
                responseID: input.responseID,
                resultHash: input.resultHash,
                deliveryEpoch: input.deliveryEpoch,
                targetID: id,
                reference: ref,
                acknowledgedAt: Date.now(),
              }
              value.source.deliveries = {
                ...value.source.deliveries,
                [ref.id]: { ...prior, phase: input.phase, acks: [...prior.acks, ack] },
              }
              yield* save(value.source)
              return ack
            }).pipe(Effect.uninterruptible),
          ),
        )
      })
    const cancelObligation = (
      id: string,
      obligationID: string,
      generation: string,
      secret: string,
      directory: string,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const initial = yield* load(id, secret, directory, generation)
          const ref = selected(initial, obligationID)
          if (!ref) return yield* refuse("missing", "Retained work obligation was not found.")
          const result = yield* group(
            initial,
            locks(
              [id, ref.originID],
              Effect.gen(function* () {
                const target = yield* load(id, secret, directory, generation)
                yield* authority(target)
                yield* parent(target)
                const current = selected(target, obligationID)
                if (!current || JSON.stringify(current) !== JSON.stringify(ref))
                  return yield* refuse("conflict", "Retained work reference changed.")
                const value = yield* origin(target, ref)
                if (!pending(value.call)) return { receipt: value.call, stopping: false }
                const call = { ...value.call, status: "cancelled" as const, updatedAt: Date.now() }
                value.source.calls[digest(ref.callID)] = { ...value.source.calls[digest(ref.callID)]!, receipt: call }
                yield* save(value.source)
                return { receipt: call, stopping: true }
              }),
            ),
          )
          if (result.stopping) {
            const stopping = yield* deps.workers
              .cancel(ref.parentSessionID, ref.messageID)
              .pipe(Effect.interruptible, Effect.forkIn(scope))
            yield* restore(Fiber.join(stopping))
          }
          return result.receipt
        }),
      )
    const spoken = (id: string, input: typeof Spoken.Input.Type, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          if (!Spoken.valid(input)) return yield* refuse("invalid", "Invalid spoken recovery snapshot.")
          const stored = yield* load(id, secret, directory, input.generation)
          yield* active(stored)
          yield* parent(stored)
          if (input.providerCallID !== stored.binding.providerCallID)
            return yield* refuse("conflict", "Spoken provider call changed.")
          const snapshot: typeof Spoken.Snapshot.Type = {
            version: 1,
            revision: input.revision,
            items: input.items,
            incomplete: input.incomplete ?? false,
            updatedAt: Date.now(),
          }
          const prior = stored.spoken
          if (stored.binding.handoff?.phase === "candidate" || stored.binding.handoff?.phase === "ready")
            return yield* refuse("conflict", "Warming voice bindings cannot publish speech.")
          if (
            stored.binding.handoff?.phase === "retiring" &&
            (!prior ||
              snapshot.items.length !== prior.items.length ||
              snapshot.items.some((item, index) => {
                const before = prior.items[index]!
                return (
                  item.id !== before.id ||
                  item.previous !== before.previous ||
                  item.role !== before.role ||
                  !(
                    (item.state === before.state && item.text === before.text) ||
                    (item.state === "omitted" && item.text === undefined)
                  )
                )
              }) ||
              (prior.incomplete && !snapshot.incomplete))
          )
            return yield* refuse("conflict", "Retiring speech permits only terminal corrections.")
          if (prior && snapshot.revision === prior.revision) {
            if (Spoken.fingerprint(snapshot) !== Spoken.fingerprint(prior))
              return yield* refuse("conflict", "Spoken revision was reused with different content.")
            return { version: 1 as const, revision: prior.revision, updatedAt: prior.updatedAt }
          }
          if (snapshot.revision !== (prior?.revision ?? 0) + 1 || (prior && !Spoken.follows(prior, snapshot)))
            return yield* refuse("conflict", "Spoken snapshot does not follow its retained revision.")
          stored.spoken = snapshot
          yield* save(stored)
          return { version: 1 as const, revision: snapshot.revision, updatedAt: snapshot.updatedAt }
        }).pipe(Effect.uninterruptible),
      )
    const context = (id: string, generation: string, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, generation)
          yield* active(stored)
          yield* parent(stored)
          const rows = yield* store.context(stored.binding.parentSessionID, id, stored.binding.createdAt)
          const result: { version: 1; items: (typeof Spoken.Context.Type)["items"][number][]; incomplete: boolean } = {
            version: 1,
            items: [],
            incomplete: rows.length > 8,
          }
          const now = Date.now()
          let size = 0
          for (const row of rows.slice(0, 8).toReversed()) {
            const parsed = yield* store.inspect(row).pipe(Effect.exit)
            if (Exit.isFailure(parsed)) {
              result.incomplete = true
              continue
            }
            const prior = parsed.value
            const snapshot = prior.spoken
            if (
              prior.binding.directory !== stored.binding.directory ||
              !Number.isFinite(prior.binding.createdAt) ||
              prior.binding.createdAt < 0 ||
              prior.binding.createdAt > stored.binding.createdAt ||
              !snapshot ||
              snapshot.updatedAt < prior.binding.createdAt ||
              snapshot.updatedAt > now ||
              snapshot.updatedAt + 3600000 <= now ||
              !Spoken.valid({
                generation: prior.binding.generation,
                providerCallID: prior.binding.providerCallID,
                version: snapshot.version,
                revision: snapshot.revision,
                items: snapshot.items,
                incomplete: snapshot.incomplete,
              })
            ) {
              result.incomplete = true
              continue
            }
            const ordered = Spoken.ordered(snapshot)
            result.incomplete ||= ordered.incomplete
            for (const item of ordered.items) {
              if (item.state !== "final") {
                result.incomplete = true
                continue
              }
              if (item.role === "other") continue
              if (!item.text) {
                result.incomplete = true
                continue
              }
              const bytes = Buffer.byteLength(item.text, "utf8")
              result.items.push({ bindingID: prior.binding.id, itemID: item.id, role: item.role, text: item.text })
              size += bytes
              while (size > 8192 || result.items.length > 128) {
                size -= Buffer.byteLength(result.items.shift()!.text, "utf8")
                result.incomplete = true
              }
            }
          }
          // A slow historical read cannot authorize recovery after Stop, expiry, or parent deletion.
          const current = yield* load(id, secret, directory, generation)
          yield* active(current)
          yield* parent(current)
          return result
        }),
      )
    return {
      reserve,
      release,
      start,
      settle,
      stage,
      meter,
      usage,
      reconcile,
      submit,
      delegate,
      duration,
      get,
      cancel,
      close,
      spoken,
      context,
      candidate,
      handoffContext,
      rearm,
      ready,
      activate,
      handoffReceipt,
      manifest,
      activateRetained,
      transferReceipt,
      obligation,
      obligations,
      delivery,
      cancelObligation,
    }
  })
