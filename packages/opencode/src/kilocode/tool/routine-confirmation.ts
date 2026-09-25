import { createHash } from "node:crypto"
import { Effect, Option, Schema } from "effect"
import { RayaAskOptions } from "@/kilocode/ask-options"
import { Question } from "@/question"
import { Storage } from "@/storage/storage"
import type * as Tool from "@/tool/tool"

const Receipt = Schema.Struct({ version: Schema.Literal(1), signature: Schema.String, approved: Schema.Literal(true) })
const Denial = Schema.Struct({ version: Schema.Literal(1), denied: Schema.Literal(true) })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

/** Approval is bound to one tool call and its exact validated plan, before any durable native effect. */
export const confirm = Effect.fn("RayaRoutineConfirmation.confirm")(function* (
  storage: Storage.Interface,
  ctx: Pick<Tool.Context, "sessionID" | "messageID" | "callID" | "messages">,
  kind: string,
  plan: unknown,
  prompt: string,
) {
  if (!ctx.callID) return yield* Effect.fail(new Error("Routine confirmation requires a stable tool call."))
  const signature = hash(JSON.stringify(canonical(plan)))
  const user =
    ctx.messages
      .filter((item) => item.info.role === "user" && item.parts.some((part) => part.type === "text" && !part.synthetic))
      .at(-1)?.info.id ?? ctx.messageID
  const denied = ["raya", "routine-confirmations", hash(JSON.stringify([ctx.sessionID, user, kind, "denied"]))]
  const cancelled = yield* storage.read(denied).pipe(
    Effect.catchIf(
      (err) => Storage.NotFoundError.isInstance(err),
      () => Effect.succeed(undefined),
    ),
    Effect.orDie,
  )
  if (cancelled !== undefined) {
    yield* Schema.decodeUnknownEffect(Denial)(cancelled).pipe(
      Effect.mapError(
        () => new Error("The saved routine cancellation is unreadable. Review Routines before retrying."),
      ),
    )
    return false
  }
  const key = ["raya", "routine-confirmations", hash(JSON.stringify([ctx.sessionID, ctx.messageID, ctx.callID, kind]))]
  const saved = yield* storage.read(key).pipe(
    Effect.catchIf(
      (err) => Storage.NotFoundError.isInstance(err),
      () => Effect.succeed(undefined),
    ),
    Effect.orDie,
  )
  if (saved !== undefined) {
    const receipt = yield* Schema.decodeUnknownEffect(Receipt)(saved).pipe(
      Effect.mapError(
        () => new Error("The saved routine confirmation is unreadable. Review Routines before retrying."),
      ),
    )
    if (receipt.signature !== signature)
      return yield* Effect.fail(new Error("The reviewed routine plan changed. Review it again in a new request."))
    return true
  }
  const service = yield* Effect.serviceOption(Question.Service)
  if (Option.isNone(service))
    return yield* Effect.fail(new Error("Routine confirmation is unavailable. No worker was created."))
  const answers = yield* RayaAskOptions.ask(service.value, {
    sessionID: ctx.sessionID,
    questions: [RayaAskOptions.confirm(prompt)],
    tool: { messageID: ctx.messageID, callID: ctx.callID },
  }).pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed([])))
  if (answers[0]?.selected[0]?.id !== "confirm") {
    yield* storage.create(denied, { version: 1, denied: true }).pipe(Effect.orDie)
    return false
  }
  const receipt = { version: 1 as const, signature, approved: true as const }
  if (yield* storage.create(key, receipt).pipe(Effect.orDie)) return true
  const prior = yield* Schema.decodeUnknownEffect(Receipt)(yield* storage.read(key).pipe(Effect.orDie)).pipe(
    Effect.mapError(() => new Error("The saved routine confirmation is unreadable. Review Routines before retrying.")),
  )
  if (prior.signature !== signature)
    return yield* Effect.fail(new Error("The reviewed routine plan changed. Review it again in a new request."))
  return true
})
