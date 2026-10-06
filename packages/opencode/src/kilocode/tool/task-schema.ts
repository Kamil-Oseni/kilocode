import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Option } from "effect"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { MessageID, SessionID } from "@/session/schema"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { example } from "@/kilocode/task-resume"

const originals = new WeakMap<JSONSchema7, JSONSchema7>()
const instructions = new WeakMap<JSONSchema7, string>()

/** Preserve static tool instructions and append only authenticated recovery guidance. */
export function description(value: string, schema: JSONSchema7) {
  const instruction = instructions.get(schema)
  return instruction ? `${value}\n\n${instruction}` : value
}

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
  const worker = yield* ChiefVerification.retained({
    sessions,
    storage,
    background: Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service)),
    sessionID,
    messageID,
    agent,
    planned: false,
  }).pipe(Effect.orDie)
  if (worker) {
    const text = { type: "string" as const, minLength: 1, pattern: "\\S" }
    const resumed: JSONSchema7 = {
      required: ["task_id"],
      properties: { task_id: { const: worker.taskID } },
      ...(worker.correction
        ? {
            anyOf: [
              { required: ["prompt"], properties: { prompt: text } },
              {
                required: ["brief"],
                properties: { brief: { type: "object", required: ["objective"], properties: { objective: text } } },
              },
            ],
          }
        : {}),
    }
    const guide = `${original.description ?? ""} Recover this same worker with task_id="${worker.taskID}". Its summary is not verified file evidence.${worker.correction ? " The completion audit was rejected: supply a concrete correction objective describing the missing work and actual verification, not a progress query or repeated success claim." : ""} Put the retained ID in arguments.task_id, not only in prompt or brief text. The following is a call example: replace its prompt with the concrete continuation or correction; existing permissions still govern execution.
${example(worker.taskID)}`
    const result: JSONSchema7 = {
      ...original,
      description: guide,
      anyOf: [resumed, { required: ["branch_id"], properties: { branch_id: text } }],
    }
    instructions.set(result, guide)
    return result
  }
  return (yield* ChiefVerification.saved({ sessions, storage, sessionID, messageID }).pipe(Effect.orDie))
    ? original
    : schema
})

export * as TaskSchema from "./task-schema"
