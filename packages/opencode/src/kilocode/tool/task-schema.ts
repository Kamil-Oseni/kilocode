import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Option } from "effect"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { MessageID, SessionID } from "@/session/schema"
import { ChiefVerification } from "@/kilocode/chief/verification"

const originals = new WeakMap<JSONSchema7, JSONSchema7>()

/** Advertise fresh objectives without changing legacy execution or saved-task authority. */
export function objective(schema: JSONSchema7): JSONSchema7 {
  const text = { type: "string" as const, minLength: 1, pattern: "\\S" }
  const result: JSONSchema7 = {
    ...schema,
    anyOf: [
      { required: ["prompt"], properties: { prompt: text } },
      {
        required: ["brief"],
        properties: { brief: { type: "object", required: ["objective"], properties: { objective: text } } },
      },
      { required: ["task_id"] },
      { required: ["branch_id"], properties: { branch_id: text } },
    ],
  }
  originals.set(result, schema)
  return result
}

export const prepare = Effect.fn("TaskSchema.prepare")(function* (
  id: string,
  schema: JSONSchema7,
  sessionID: SessionID,
  messageID: MessageID,
  agent: string,
) {
  const original = originals.get(schema)
  if (id !== "task" || agent !== "auto" || !original) return schema
  const sessions = yield* Session.Service
  const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service))
  return (yield* ChiefVerification.saved({ sessions, storage, sessionID, messageID }).pipe(Effect.orDie))
    ? original
    : schema
})

export * as TaskSchema from "./task-schema"
