import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { record } from "@/kilocode/task/continuation"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"

/** Advertise deadlines only when the owning request supplies a verified bound. */
export const prepare = Effect.fn("RoutineSchema.prepare")(function* (schema: JSONSchema7, sessionID: SessionID) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  const database = yield* Database.Service
  const incoming = identity ? yield* RayaTaskDelegation.make(database).bySession(sessionID) : undefined
  const deadline =
    incoming &&
    incoming.recipientID === identity?.agentID &&
    incoming.childRunID === identity?.runID &&
    (incoming.state === "running" || incoming.state === "needs_input") &&
    (!identity?.organizationID || incoming.organizationID === identity.organizationID) &&
    (!identity?.organizationRevision || incoming.organizationRevision === identity.organizationRevision)
      ? incoming.deadline
      : undefined
  const properties = { ...schema.properties }
  delete properties.deadline
  return {
    ...schema,
    additionalProperties: false,
    required:
      deadline === undefined
        ? (schema.required ?? []).filter((key) => key !== "deadline")
        : [...new Set([...(schema.required ?? []), "deadline"])],
    properties: {
      ...properties,
      ...(deadline !== undefined
        ? {
            deadline: {
              type: "integer" as const,
              minimum: 1,
              maximum: deadline,
              description: `Absolute future Unix timestamp in milliseconds. The owner supplied ${deadline}; preserve that bound or an explicitly authorized earlier deadline. Never extend it or use zero.`,
            },
          }
        : {}),
    },
  } satisfies JSONSchema7
})
