import fs from "node:fs/promises"
import { createHash, timingSafeEqual } from "node:crypto"
import { Cause, Effect, Exit, Fiber, Schema, Scope, Semaphore } from "effect"
import { MessageID, type SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import type { Storage } from "@/storage/storage"
import type * as TaskWorker from "@/kilocode/session/task-worker"
import {
  OpenAIBinding,
  OpenAICall,
  OpenAICallInput,
  OpenAIStart,
  OpenAIImage,
  OpenAIImageInput,
  VoiceID,
  VoiceKey,
} from "./openai-protocol"

type Binding = typeof OpenAIBinding.Type
type Call = typeof OpenAICall.Type
type Input = typeof OpenAICallInput.Type
type Image = { receipt: typeof OpenAIImage.Type; data: string }
type Stored = {
  binding: Binding
  owner: string
  hash: string
  requestID: string
  calls: Record<string, { input: Input; receipt: Call }>
  images?: Record<string, Image>
}
type Deps = {
  storage: Storage.Interface
  sessions: { get: (id: SessionID) => Effect.Effect<Pick<Session.Info, "id" | "directory">, Session.NotFound> }
  prompts: Pick<SessionPrompt.Interface, "prompt">
  workers: Pick<TaskWorker.Interface, "cancel">
}

export class VoiceError extends Schema.TaggedErrorClass<VoiceError>()("VoiceError", {
  code: Schema.Literals(["unauthorized", "missing", "conflict", "expired", "invalid"]),
  message: Schema.String,
}) {}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const key = (id: string) => ["raya_openai_voice", id]
const pending = (call: Call) => call.status === "accepted" || call.status === "running"
const refuse = (code: VoiceError["code"], message: string) => Effect.fail(new VoiceError({ code, message }))
const canonical = (directory: string) => Effect.tryPromise(() => fs.realpath(directory)).pipe(Effect.orDie)

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
    const save = (stored: Stored) => deps.storage.replace(key(stored.binding.id), stored).pipe(Effect.orDie)
    const read = (id: string) =>
      deps.storage
        .read<Stored>(key(id))
        .pipe(
          Effect.catch((error) =>
            error._tag === "NotFoundError" ? refuse("missing", "Voice binding not found.") : Effect.die(error),
          ),
        )
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

    const start = (input: typeof OpenAIStart.Type, secret: string, directory: string) =>
      Effect.gen(function* () {
        if (!Schema.is(VoiceKey)(secret)) return yield* refuse("unauthorized", "Invalid voice capability.")
        const dir = yield* canonical(directory)
        const parent = yield* deps.sessions.get(input.parentSessionID)
        if ((yield* canonical(parent.directory)) !== dir)
          return yield* refuse("conflict", "Parent session belongs to another directory.")
        const id = `rov_${digest(JSON.stringify([dir, input.providerCallID])).slice(0, 48)}`
        return yield* locked(
          id,
          Effect.gen(function* () {
            const now = Date.now()
            const stored: Stored = {
              owner,
              hash: digest(secret),
              requestID: input.requestID,
              calls: {},
              binding: {
                id,
                generation: crypto.randomUUID(),
                parentSessionID: parent.id,
                directory: dir,
                providerCallID: input.providerCallID,
                model: "gpt-realtime-2.1",
                status: "active",
                createdAt: now,
                expiresAt: now + 60 * 60 * 1000,
              },
            }
            if (yield* deps.storage.create(key(id), stored).pipe(Effect.orDie)) return stored.binding
            const existing = yield* load(id, secret, dir)
            if (existing.requestID !== input.requestID || existing.binding.parentSessionID !== parent.id)
              return yield* refuse("conflict", "Provider call already has another binding.")
            return visible(existing)
          }),
        )
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
    const submit = (id: string, input: Input, secret: string, directory: string) =>
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, input.generation)
          yield* active(stored)
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
          // Persist before scheduling. A crash between these steps remains an unknown intent, never replayed.
          yield* save(stored)
          yield* run(id, input.callID).pipe(Effect.interruptible, Effect.forkIn(scope))
          return call
        }).pipe(Effect.uninterruptible),
      )
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
      locked(
        id,
        Effect.gen(function* () {
          const stored = yield* load(id, secret, directory, generation)
          if (stored.owner !== owner) return visible(stored)
          // Closing speech admission does not revoke already-admitted parent-session work.
          stored.binding = { ...stored.binding, status: "closed" }
          yield* save(stored)
          return stored.binding
        }),
      )
    return { start, stage, submit, get, cancel, close }
  })
