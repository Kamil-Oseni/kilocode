import { createHash } from "node:crypto"
import { Effect, Option } from "effect"
import { z } from "zod"
import * as Log from "@opencode-ai/core/util/log"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { Storage, NotFoundError } from "@/storage/storage"
import { RayaChief } from "../chief"
import { acknowledged } from "./turn"

const log = Log.create({ service: "capture.routing" })
const schema = z
  .object({
    session: z.string(),
    assistant: z.string(),
    user: z.string(),
    request: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledgement: z.boolean(),
  })
  .strict()
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const key = (session: string, assistant: string) => ["raya", "capture-routes", hash(`${session}\0${assistant}`)]

/** Immutable per-message records avoid session metadata races and never impose a chat lifetime cap. */
const retain = Effect.fn("SecondBrain.captureRouting")(function* (
  context: Session.Info,
  user: MessageV2.WithParts,
  assistant: string,
  acknowledgement: boolean,
) {
  if (user.info.role !== "user" || user.info.sessionID !== context.id)
    throw new Error("Original capture route requires its stored user")
  const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service))
  if (!storage) throw new Error("Original capture routing storage unavailable")
  const row = {
    session: context.id,
    assistant,
    user: user.info.id,
    request: hash(RayaChief.requestText(user.parts)),
    acknowledgement,
  }
  const path = key(context.id, assistant)
  if (!(yield* storage.create(path, row))) {
    const prior = schema.parse(yield* storage.read(path))
    if (JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("Original capture routing decision changed")
  }
})
export const remember = (...args: Parameters<typeof retain>) =>
  retain(...args).pipe(
    Effect.catchCause(() =>
      Effect.sync(() =>
        log.warn("Original capture routing evidence was not retained; capture must verify its original route"),
      ),
    ),
  )

/** Authentication comes from the original host decision, never model text or successor routing. */
export const routing = Effect.fn("SecondBrain.originalCaptureRouting")(function* (
  messages: readonly MessageV2.WithParts[],
  context: { id: string; parentID?: string; metadata?: Record<string, unknown> },
  assistant: MessageV2.Assistant,
) {
  const user = messages.find((row) => row.info.id === assistant.parentID)
  if (!user || user.info.role !== "user" || user.info.sessionID !== context.id || assistant.sessionID !== context.id)
    throw new Error("Original capture route user is absent")
  const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service))
  const held = storage
    ? yield* storage
        .read<unknown>(key(context.id, assistant.id))
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
    : undefined
  if (held !== undefined) {
    const row = schema.parse(held)
    if (
      row.session !== context.id ||
      row.assistant !== assistant.id ||
      row.user !== user.info.id ||
      row.request !== hash(RayaChief.requestText(user.parts))
    )
      throw new Error("Original capture routing evidence changed")
    return assistant.agent === "auto" && !context.parentID && row.acknowledgement
  }
  if (assistant.agent !== "auto") return false
  if (RayaChief.request(context.metadata) !== RayaChief.requestText(user.parts))
    throw new Error("Original Auto capture routing evidence is unavailable after a successor")
  return acknowledged(messages, context, user.info.id)
})
