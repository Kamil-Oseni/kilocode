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
import { Storage } from "@/storage/storage"
import type * as TaskWorker from "@/kilocode/session/task-worker"
import { mutate } from "@/kilocode/task/mutation"
import {
  OpenAIBinding,
  OpenAICall,
  OpenAICallInput,
  OpenAIStart,
  OpenAIImage,
  OpenAIImageInput,
  OpenAIReservation,
  OpenAIReserve,
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
const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Key = Schema.String.check(Schema.isMaxLength(128))
const Reconciliation = Schema.Struct({
  version: Schema.Literal(1),
  cycle: Count,
  high: Key,
  after: Schema.optional(Key),
  status: Schema.Literals(["running", "failed", "complete"]),
  scanned: Count,
  receipts: Count,
  quarantined: Count,
  updatedAt: Schema.Finite,
  failure: Schema.optional(
    Schema.Struct({
      id: Key,
      message: Schema.String.check(Schema.isMaxLength(240)),
    }),
  ),
})
type Reconciliation = typeof Reconciliation.Type
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
      if (stored.binding.expiresAt <= Date.now()) return refuse("expired", "Voice binding expired.")
      return Effect.void
    }
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
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        yield* finish(id, callID, {
          status: "completed",
          result: {
            text:
              text.length > 12000
                ? `${text.slice(0, 11800)}\n[Response shortened; inspect the Raya session for the full result.]`
                : text,
            assistantMessageID: message.info.id,
            evidence: message.parts
              .filter((part) => part.type === "tool")
              .filter((part) => part.tool.length <= 128)
              .slice(0, 64)
              .map((part) => ({
                messageID: part.messageID,
                partID: part.id,
                tool: part.tool,
                status: part.state.status,
              })),
          },
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

    const start = (input: typeof OpenAIStart.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!Schema.is(VoiceKey)(secret)) return yield* refuse("unauthorized", "Invalid voice capability.")
        const dir = yield* canonical(directory)
        const parent = yield* deps.sessions.get(input.parentSessionID)
        if ((yield* canonical(parent.directory)) !== dir)
          return yield* refuse("conflict", "Parent session belongs to another directory.")
        const id = `rov_${digest(JSON.stringify([dir, input.providerCallID])).slice(0, 48)}`
        const model = input.model ?? "gpt-realtime-2.1"
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
                status: "active",
                createdAt: now,
                expiresAt: now + 60 * 60 * 1000,
              },
            }
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
        const guarded = transcriptionID ? locked(`reservation:${transcriptionID}`, work) : work
        return yield* locked(`reservation:${reservationID}`, guarded)
      })
    const stage = (id: string, input: typeof OpenAIImageInput.Type, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, input.generation)
          yield* active(stored)
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
      )
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
          if (cursor !== undefined && cursor <= (stored.liveCursor ?? 0))
            return yield* refuse("conflict", "No new live request context is available.")
          if (Object.keys(stored.calls).length >= 64)
            return yield* refuse("conflict", "Voice binding call limit reached; start a new voice connection.")
          if (Object.values(stored.calls).some((call) => pending(call.receipt)))
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
          if (cursor !== undefined) stored.liveCursor = cursor
          // Persist before scheduling. A crash between these steps remains an unknown intent, never replayed.
          yield* save(stored)
          yield* run(id, input.callID).pipe(Effect.interruptible, Effect.forkIn(scope))
          return call
        }).pipe(Effect.uninterruptible),
      )
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
              if (stored.owner !== owner) return receipt(stored, entry.receipt)
              if (pending(entry.receipt)) {
                entry.receipt = { ...entry.receipt, status: "cancelled", updatedAt: Date.now() }
                yield* save(stored)
              }
              return entry.receipt
            }),
          )
          if (call.status === "cancelled") {
            // A disconnected HTTP waiter must not abandon a persisted cancellation request.
            const stopping = yield* deps.workers
              .cancel(call.parentSessionID, call.messageID)
              .pipe(Effect.interruptible, Effect.forkIn(scope))
            yield* restore(Fiber.join(stopping))
          }
          return call
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
    return { reserve, release, start, stage, meter, usage, reconcile, submit, delegate, duration, get, cancel, close }
  })
