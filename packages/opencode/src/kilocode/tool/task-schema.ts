import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Option } from "effect"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { MessageID, SessionID } from "@/session/schema"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { example } from "@/kilocode/task-resume"
import * as RoutineSchema from "./routine-schema"

const originals = new WeakMap<JSONSchema7, JSONSchema7>()
const instructions = new WeakMap<JSONSchema7, string>()

/** Ollama's grammar parser selects alternatives before reading sibling object constraints. */
function alternatives(schema: JSONSchema7): JSONSchema7[] {
  const text = { type: "string" as const, minLength: 1, pattern: "\\S" }
  const prompt = schema.properties?.prompt
  const brief = schema.properties?.brief
  const object: JSONSchema7 = brief && typeof brief === "object" ? brief : { type: "object" }
  const objective = object.properties?.objective
  return [
    {
      ...schema,
      required: [...new Set([...(schema.required ?? []), "prompt"])],
      properties: {
        ...schema.properties,
        prompt: { ...(prompt && typeof prompt === "object" ? prompt : {}), ...text },
      },
    },
    {
      ...schema,
      required: [...new Set([...(schema.required ?? []), "brief"])],
      properties: {
        ...schema.properties,
        brief: {
          ...object,
          required: [...new Set([...(object.required ?? []), "objective"])],
          properties: {
            ...object.properties,
            objective: { ...(objective && typeof objective === "object" ? objective : {}), ...text },
          },
        },
      },
    },
  ]
}

/** Preserve static tool instructions and append only authenticated recovery guidance. */
export function description(value: string, schema: JSONSchema7) {
  const instruction = instructions.get(schema)
  return instruction ? `${value}\n\n${instruction}` : value
}

/** Advertise fresh objectives without changing legacy execution or saved-task authority. */
export function objective(schema: JSONSchema7): JSONSchema7 {
  const text = { type: "string" as const, minLength: 1, pattern: "\\S" }
  const fresh = schema.properties?.access
    ? { ...schema, required: [...new Set([...(schema.required ?? []), "access"])] }
    : schema
  const result: JSONSchema7 = {
    ...schema,
    anyOf: [
      ...alternatives(fresh),
      {
        ...schema,
        required: [...new Set([...(schema.required ?? []), "task_id"])],
      },
      {
        ...schema,
        required: [...new Set([...(schema.required ?? []), "branch_id"])],
        properties: { ...schema.properties, branch_id: text },
      },
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
  if (id === "delegate_work") return yield* RoutineSchema.prepare(schema, sessionID).pipe(Effect.orDie)
  if (id === "assign_organization_work" && agent === "auto")
    return yield* RoutineSchema.assignment(schema, sessionID, messageID).pipe(Effect.orDie)
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
    // Retained recovery is admitted only in goal/verify; planned branches execute in task phase.
    const resumed: JSONSchema7 = {
      ...original,
      required: [...new Set([...(original.required ?? []), "task_id"])],
      properties: { ...original.properties, task_id: { type: "string", const: worker.taskID } },
    }
    const guide = `${original.description ?? ""} Recover this same worker with task_id="${worker.taskID}". Its summary is not verified file evidence.${worker.correction ? " The completion audit was rejected: supply a concrete correction objective describing the missing work and actual verification, not a progress query or repeated success claim." : ""} Put the retained ID in arguments.task_id, not only in prompt or brief text. The following is a call example: replace its prompt with the concrete continuation or correction; existing permissions still govern execution.
${example(worker.taskID)}`
    const result: JSONSchema7 = {
      ...resumed,
      ...(worker.correction ? { anyOf: alternatives(resumed) } : {}),
      description: guide,
    }
    instructions.set(result, guide)
    return result
  }
  return (yield* ChiefVerification.saved({ sessions, storage, sessionID, messageID }).pipe(Effect.orDie))
    ? original
    : schema
})

export * as TaskSchema from "./task-schema"
