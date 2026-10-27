import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"
import { record } from "@/kilocode/task/continuation"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import * as Handoff from "@/kilocode/goal/handoff"
import { kickoff, omits } from "@/kilocode/task/request"

/** Bind job-start grammar to the current owner's request, without changing question assignments. */
export const assignment = Effect.fn("RoutineSchema.assignment")(function* (
  schema: JSONSchema7,
  sessionID: SessionID,
  messageID: MessageID,
) {
  const sessions = yield* Session.Service
  const messages = yield* sessions.messages({ sessionID })
  const assistant = messages.find((row) => row.info.id === messageID && row.info.sessionID === sessionID)
  const user = messages.findLast((row) => row.info.role === "user" && row.info.sessionID === sessionID)
  if (assistant?.info.role !== "assistant" || assistant.info.parentID !== user?.info.id) return schema
  const request = user?.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : [])).join("\n")
  if (!kickoff(request)) return schema
  const removed = new Set<string>((["budget", "deadline"] as const).filter((field) => omits(request, field)))
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => !removed.has(key)))
  return {
    ...schema,
    additionalProperties: false,
    required: [...new Set([...(schema.required ?? []).filter((key) => !removed.has(key)), "criteria", "outputs"])],
    properties,
  } satisfies JSONSchema7
})

/** Advertise the owning request's deadline bounds and required file handoffs. */
export const prepare = Effect.fn("RoutineSchema.prepare")(function* (schema: JSONSchema7, sessionID: SessionID) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  const database = yield* Database.Service
  const incoming = identity ? yield* RayaTaskDelegation.make(database).bySession(sessionID) : undefined
  const request =
    incoming &&
    incoming.recipientID === identity?.agentID &&
    incoming.childRunID === identity?.runID &&
    (incoming.state === "running" || incoming.state === "needs_input") &&
    (!identity?.organizationID || incoming.organizationID === identity.organizationID) &&
    (!identity?.organizationRevision || incoming.organizationRevision === identity.organizationRevision)
      ? incoming
      : undefined
  const deadline = omits(request?.context, "deadline") ? undefined : request?.deadline
  const scoped = request?.outputs !== undefined
  const files = request?.criteria?.some(
    (criterion) =>
      Handoff.artifacts(criterion.description, criterion.verification) ||
      (!!request.outputs?.length && Handoff.required(criterion.description, criterion.verification)),
  )
  const properties = { ...schema.properties }
  delete properties.deadline
  if (omits(request?.context)) delete properties.budget
  const artifacts = properties.artifacts
  const criteria = properties.criteria
  const result: JSONSchema7 = {
    ...schema,
    additionalProperties: false,
    required: [
      ...new Set([
        ...(schema.required ?? []).filter((key) => key !== "deadline"),
        ...(deadline === undefined ? [] : ["deadline"]),
        ...(files && !scoped ? ["artifacts", "criteria"] : []),
        ...(request?.outputs === undefined ? [] : ["outputs"]),
      ]),
    ],
    properties: {
      ...properties,
      ...(files && !scoped
        ? {
            artifacts: { ...(artifacts && typeof artifacts === "object" ? artifacts : {}), type: "array", minItems: 1 },
            criteria: { ...(criteria && typeof criteria === "object" ? criteria : {}), type: "array", minItems: 1 },
          }
        : {}),
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
  }
  if (scoped) {
    const outputs = properties.outputs
    const question = { ...result.properties }
    const required = (result.required ?? []).filter((key) => key !== "artifacts" && key !== "criteria")
    return {
      ...result,
      anyOf: [
        {
          ...result,
          required,
          properties: {
            ...question,
            outputs: { ...(outputs && typeof outputs === "object" ? outputs : {}), type: "array", maxItems: 0 },
          },
        },
        {
          ...result,
          required: [...new Set([...required, "criteria", ...(files ? ["artifacts"] : [])])],
          properties: {
            ...result.properties,
            outputs: { ...(outputs && typeof outputs === "object" ? outputs : {}), type: "array", minItems: 1 },
            criteria: { ...(criteria && typeof criteria === "object" ? criteria : {}), type: "array", minItems: 1 },
            ...(files
              ? {
                  artifacts: {
                    ...(artifacts && typeof artifacts === "object" ? artifacts : {}),
                    type: "array",
                    minItems: 1,
                  },
                }
              : {}),
          },
        },
      ],
    } satisfies JSONSchema7
  }
  if (files || !request?.criteria?.length) return result
  const question = { ...result.properties }
  delete question.artifacts
  return {
    ...result,
    anyOf: [
      { ...result, properties: question },
      {
        ...result,
        required: [...new Set([...(result.required ?? []), "artifacts", "criteria"])],
        properties: {
          ...result.properties,
          artifacts: { ...(artifacts && typeof artifacts === "object" ? artifacts : {}), type: "array", minItems: 1 },
          criteria: { ...(criteria && typeof criteria === "object" ? criteria : {}), type: "array", minItems: 1 },
        },
      },
    ],
  } satisfies JSONSchema7
})
