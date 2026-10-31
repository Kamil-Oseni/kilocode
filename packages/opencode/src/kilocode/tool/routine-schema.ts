import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect, Option, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import type { MessageID, SessionID } from "@/session/schema"
import { record } from "@/kilocode/task/continuation"
import { RayaTaskDelegation } from "@/kilocode/task/delegation"
import * as Handoff from "@/kilocode/goal/handoff"
import { kickoff, omits } from "@/kilocode/task/request"
import { required as contractRequired } from "@/kilocode/task/job-contract-request"
import { RayaTask } from "@/kilocode/task"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import * as Contract from "@/kilocode/task/job-contract-store"

/** Require a useful expected result in new model proposals without changing saved contracts. */
function expectation(proposal: JSONSchema7 | boolean | undefined) {
  if (!proposal || typeof proposal !== "object") return undefined
  const stages = proposal.properties?.stages
  if (!stages || typeof stages !== "object") return undefined
  const stage = stages.items
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) return undefined
  const expected = stage.properties?.expected
  if (!expected || typeof expected !== "object") return undefined
  return {
    ...proposal,
    properties: {
      ...proposal.properties,
      stages: {
        ...stages,
        items: {
          ...stage,
          required: [...new Set([...(stage.required ?? []), "expected"])],
          properties: {
            ...stage.properties,
            expected: {
              ...expected,
              description:
                "Preserve the owner's exact expected result when supplied. Otherwise state a concise outcome summary for this stage without adding requirements or unsupported facts.",
            },
          },
        },
      },
    },
  } satisfies JSONSchema7
}

/** Offer complete contract or legacy grammars only for the current authenticated owner. */
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
  const removed = new Set<string>((["budget", "deadline", "context"] as const).filter((field) => omits(request, field)))
  const derived = new Set(["recipientID", "objective", "expected", "outputs", "criteria"])
  const contract = expectation(schema.properties?.contract)
  if (!contract) return yield* Effect.fail(new Error("The contract assignment model schema is unavailable."))
  const fixed: JSONSchema7 = {
    ...schema,
    type: "object",
    additionalProperties: false,
    required: [
      ...new Set([
        ...(schema.required ?? []).filter((key) => !removed.has(key) && !derived.has(key)),
        "organizationID",
        "expectedRevision",
        "senderID",
        "contract",
      ]),
    ],
    properties: {
      ...Object.fromEntries(
        Object.entries(schema.properties ?? {}).filter(([key]) => !removed.has(key) && !derived.has(key)),
      ),
      contract,
    },
  }
  if (contractRequired(request)) return fixed
  const result: JSONSchema7 = {
    type: "object",
    anyOf: [
      fixed,
      {
        ...schema,
        type: "object",
        additionalProperties: false,
        required: [
          ...new Set([
            ...(schema.required ?? []).filter((key) => key !== "contract" && !removed.has(key)),
            ...(kickoff(request) ? ["criteria", "outputs"] : []),
          ]),
        ],
        properties: Object.fromEntries(
          Object.entries(schema.properties ?? {}).filter(([key]) => key !== "contract" && !removed.has(key)),
        ),
      },
    ],
  }
  return result
})

/** Advertise the owning request's deadline bounds and required file handoffs. */
export const prepare = Effect.fn("RoutineSchema.prepare")(function* (schema: JSONSchema7, sessionID: SessionID) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(sessionID)
  const marker = session.metadata?.rayaRoutine
  const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine).pipe(
    Effect.orElseSucceed(() => undefined),
  )
  const database = yield* Database.Service
  const incoming = identity ? yield* RayaTaskDelegation.make(database).bySession(sessionID) : undefined
  if (
    incoming?.contract ||
    identity?.contract ||
    (marker && typeof marker === "object" && ("contract" in marker || ("version" in marker && marker.version === 3)))
  ) {
    const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service))
    if (!storage)
      return yield* Effect.fail(new Contract.Invalid({ message: "The saved parent contract is unavailable." }))
    const run = identity
      ? (yield* RayaTask.make({ storage, database }).runsFor(identity.agentID)).find(
          (item) => item.id === identity.runID && item.sessionID === sessionID && RayaTask.pending(item),
        )
      : undefined
    const goal = yield* RayaGoal.make({ storage, database, sessions }).get(sessionID)
    const snapshot = run ? yield* RayaTaskSnapshot.make({ storage }).find(run.id) : undefined
    if (!run || !goal || !snapshot)
      return yield* Effect.fail(new Contract.Invalid({ message: "The saved parent contract is unavailable." }))
    const view = yield* Contract.make({ database, sessions }).current({ run, goal, session, snapshot })
    if (!view) return yield* Effect.fail(new Contract.Invalid({ message: "The saved parent contract is unavailable." }))
    const deadline = omits(incoming?.context, "deadline") ? undefined : incoming?.deadline
    return {
      type: "object",
      additionalProperties: false,
      required: ["stageID", ...(deadline === undefined ? [] : ["deadline"])],
      properties: {
        stageID: {
          type: "string",
          ...(view.next.length
            ? { enum: view.next.map((stage) => stage.id) }
            : { description: "This is a final stage with no allowed next stage. Do not call delegate_work." }),
        },
        ...(schema.properties?.artifacts === undefined ? {} : { artifacts: schema.properties.artifacts }),
        ...(omits(incoming?.context) || schema.properties?.budget === undefined
          ? {}
          : { budget: schema.properties.budget }),
        ...(deadline === undefined ? {} : { deadline: { type: "integer", minimum: 1, maximum: deadline } }),
      },
    } satisfies JSONSchema7
  }
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
