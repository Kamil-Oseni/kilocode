// raya_change - Milestone A durable native goal state and evidence audit
import { Effect, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"

export namespace RayaGoal {
  export const Status = Schema.Literals(["active", "paused", "complete", "blocked"])
  export type Status = typeof Status.Type

  export const Evidence = Schema.Struct({
    messageID: Schema.optional(MessageID),
    callID: Schema.String,
    summary: Schema.String,
  })
  export type Evidence = typeof Evidence.Type

  export const Requirement = Schema.Struct({
    requirement: Schema.String,
    passed: Schema.Boolean,
    evidence: Schema.Array(Evidence),
  })
  export type Requirement = typeof Requirement.Type

  export const Audit = Schema.Struct({
    requirements: Schema.Array(Requirement),
    summary: Schema.String,
    verifiedAt: Schema.Number,
  })
  export type Audit = typeof Audit.Type

  export const Progress = Schema.Struct({
    at: Schema.Number,
    kind: Schema.Literals(["status", "turn", "continuation"]),
    message: Schema.String,
  })
  export type Progress = typeof Progress.Type

  export const Usage = Schema.Struct({
    turns: Schema.Number,
    continuations: Schema.Number,
    toolCalls: Schema.Number,
  })
  export type Usage = typeof Usage.Type

  export const State = Schema.Struct({
    objective: Schema.String,
    status: Status,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    usage: Usage,
    blockedReason: Schema.optional(Schema.String),
    audit: Schema.optional(Audit),
    progress: Schema.Array(Progress),
  })
  export type State = typeof State.Type

  export const Create = Schema.Struct({
    objective: Schema.String,
  })

  export const Control = Schema.Struct({
    status: Schema.Literals(["active", "paused"]),
  })

  // raya_change - model providers require tool parameters to be a top-level JSON object
  export const ModelUpdate = Schema.Struct({
    status: Schema.Literals(["blocked", "complete"]),
    reason: Schema.optional(Schema.String),
    audit: Schema.optional(
      Schema.Struct({
        requirements: Schema.Array(
          Schema.Struct({
            requirement: Schema.String,
            passed: Schema.Boolean,
            evidence: Schema.Array(Evidence),
          }),
        ),
        summary: Schema.String,
      }),
    ),
  })
  export type ModelUpdate = typeof ModelUpdate.Type

  export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("RayaGoal.NotFoundError", {
    sessionID: SessionID,
  }) {}

  export class ExistsError extends Schema.TaggedErrorClass<ExistsError>()("RayaGoal.ExistsError", {
    sessionID: SessionID,
  }) {}

  export class AuditError extends Schema.TaggedErrorClass<AuditError>()("RayaGoal.AuditError", {
    message: Schema.String,
  }) {}

  type Store = Pick<Storage.Interface, "read" | "write" | "remove">
  type Sessions = Pick<Session.Interface, "messages">
  type Deps = {
    storage: Store
    sessions: Sessions
  }

  const controls = new Set(["create_goal", "get_goal", "update_goal"])
  const decode = Schema.decodeUnknownEffect(State)
  const key = (sessionID: SessionID) => ["raya", "goal", sessionID]
  const clean = (value: string) => value.trim()
  const progress = (state: State, item: Progress): Progress[] => [...state.progress, item].slice(-30)

  export function make(deps: Deps) {
    const get = Effect.fn("RayaGoal.get")(function* (sessionID: SessionID) {
      const raw = yield* deps.storage.read<unknown>(key(sessionID)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (raw === undefined) return undefined
      return yield* decode(raw).pipe(Effect.orDie)
    })

    const requireGoal = Effect.fn("RayaGoal.require")(function* (sessionID: SessionID) {
      const state = yield* get(sessionID)
      if (!state) return yield* new NotFoundError({ sessionID })
      return state
    })

    const save = Effect.fn("RayaGoal.save")(function* (sessionID: SessionID, state: State) {
      yield* deps.storage.write(key(sessionID), state).pipe(Effect.orDie)
      return state
    })

    const create = Effect.fn("RayaGoal.create")(function* (sessionID: SessionID, objective: string) {
      const text = clean(objective)
      if (!text) return yield* new AuditError({ message: "A goal objective is required." })
      const existing = yield* get(sessionID)
      if (existing?.objective === text && existing.status === "active") return existing // raya_change - retry failed first request
      if (existing) return yield* new ExistsError({ sessionID })
      const now = Date.now()
      return yield* save(sessionID, {
        objective: text,
        status: "active",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [{ at: now, kind: "status", message: "Goal armed." }],
      })
    })

    const control = Effect.fn("RayaGoal.control")(function* (sessionID: SessionID, status: "active" | "paused") {
      const state = yield* requireGoal(sessionID)
      if (state.status === "complete" || state.status === "blocked") {
        return yield* new AuditError({
          message: `A ${state.status} goal cannot be ${status === "active" ? "resumed" : "paused"}.`,
        })
      }
      const now = Date.now()
      return yield* save(sessionID, {
        ...state,
        status,
        updatedAt: now,
        progress: progress(state, {
          at: now,
          kind: "status",
          message: status === "active" ? "Goal resumed." : "Goal paused.",
        }),
      })
    })

    const clear = Effect.fn("RayaGoal.clear")(function* (sessionID: SessionID) {
      yield* deps.storage.remove(key(sessionID)).pipe(Effect.orDie)
    })

    const tools = (messages: SessionV1.WithParts[]) =>
      messages.flatMap((message) =>
        message.info.role === "assistant"
          ? message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
          : [],
      )

    const fingerprint = (part: SessionV1.ToolPart) =>
      JSON.stringify({
        tool: part.tool,
        input: part.state.input,
        result:
          part.state.status === "completed"
            ? part.state.output
            : part.state.status === "error"
              ? part.state.error
              : part.state.status,
      })
    const started = (part: SessionV1.ToolPart) => ("time" in part.state ? part.state.time.start : 0)

    const evidence = Effect.fn("RayaGoal.evidence")(function* (sessionID: SessionID) {
      const state = yield* requireGoal(sessionID)
      const messages = yield* deps.sessions.messages({ sessionID })
      return tools(messages)
        .filter(
          (part) =>
            part.state.status === "completed" && part.state.time.start >= state.createdAt && !controls.has(part.tool),
        )
        .map((part) => ({
          messageID: part.messageID,
          callID: part.callID,
          tool: part.tool,
          title: part.state.status === "completed" ? part.state.title : "",
          output: part.state.status === "completed" ? part.state.output.slice(0, 500) : "",
          exit: part.state.status === "completed" ? part.state.metadata["exit"] : undefined,
        }))
    })

    const update = Effect.fn("RayaGoal.update")(function* (sessionID: SessionID, input: ModelUpdate) {
      const state = yield* requireGoal(sessionID)
      if (state.status !== "active") {
        return yield* new AuditError({ message: `Only an active goal can be marked ${input.status}.` })
      }
      const now = Date.now()
      if (input.status === "blocked") {
        const reason = clean(input.reason ?? "")
        if (!reason) return yield* new AuditError({ message: "A blocked goal requires a plain reason." })
        return yield* save(sessionID, {
          ...state,
          status: "blocked",
          blockedReason: reason,
          updatedAt: now,
          progress: progress(state, { at: now, kind: "status", message: `Blocked: ${reason}` }),
        })
      }
      if (!input.audit) {
        return yield* new AuditError({ message: "Completion requires a requirement-by-requirement audit." })
      }
      const messages = yield* deps.sessions.messages({ sessionID })
      const audit = yield* validateForSession(input.audit, messages, state.createdAt)
      return yield* save(sessionID, {
        ...state,
        status: "complete",
        audit,
        updatedAt: now,
        progress: progress(state, { at: now, kind: "status", message: "Completion audit passed." }),
      })
    })

    const validateForSession = Effect.fn("RayaGoal.validateAuditForSession")(function* (
      audit: NonNullable<ModelUpdate["audit"]>,
      messages: SessionV1.WithParts[],
      createdAt: number,
    ) {
      if (audit.requirements.length === 0) {
        return yield* new AuditError({ message: "Completion requires at least one concrete requirement." })
      }
      const parts = tools(messages)
      for (const requirement of audit.requirements) {
        if (!clean(requirement.requirement)) {
          return yield* new AuditError({ message: "Every audited requirement needs a concrete description." })
        }
        if (!requirement.passed) {
          return yield* new AuditError({ message: `Requirement is not satisfied: ${requirement.requirement}` })
        }
        if (requirement.evidence.length === 0) {
          return yield* new AuditError({ message: `Requirement has no real evidence: ${requirement.requirement}` })
        }
        for (const evidence of requirement.evidence) {
          const part = parts.find(
            (item) => item.callID === evidence.callID && (!evidence.messageID || item.messageID === evidence.messageID),
          )
          const ref = evidence.messageID ? `${evidence.messageID}/${evidence.callID}` : evidence.callID
          if (
            !part ||
            part.state.status !== "completed" ||
            part.state.time.start < createdAt ||
            controls.has(part.tool)
          ) {
            return yield* new AuditError({
              message: `Evidence ${ref} is not a completed post-goal work or verification tool call.`,
            })
          }
          if (part.tool === "bash" && part.state.metadata["exit"] !== 0) {
            return yield* new AuditError({
              message: `Command evidence ${ref} did not exit successfully.`,
            })
          }
          if (!clean(evidence.summary)) {
            return yield* new AuditError({ message: "Every evidence reference needs a plain summary." })
          }
        }
      }
      const summary = clean(audit.summary)
      if (!summary) return yield* new AuditError({ message: "Completion requires an audit summary." })
      return { requirements: audit.requirements, summary, verifiedAt: Date.now() } satisfies Audit
    })

    const recordTurn = Effect.fn("RayaGoal.recordTurn")(function* (sessionID: SessionID) {
      const state = yield* get(sessionID)
      if (!state) return
      const messages = yield* deps.sessions.messages({ sessionID })
      const users = messages.filter((message) => message.info.role === "user")
      const user = users.toSorted((a, b) => a.info.time.created - b.info.time.created).at(-1)
      if (!user) return
      const calls = messages
        .filter((message) => message.info.role === "assistant" && message.info.parentID === user.info.id)
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && !controls.has(part.tool))
      const current = new Set(calls.map((part) => part.callID))
      const prior = tools(messages).filter((part) => !current.has(part.callID) && started(part) >= state.createdAt)
      const repeated =
        calls.length > 0 && calls.every((call) => prior.some((part) => fingerprint(part) === fingerprint(call)))
      const now = Date.now()
      const reason = "Automatic continuation repeated the same tool work without new evidence."
      const next = yield* save(sessionID, {
        ...state,
        status: repeated ? "blocked" : state.status,
        blockedReason: repeated ? reason : state.blockedReason,
        updatedAt: now,
        usage: {
          ...state.usage,
          turns: state.usage.turns + 1,
          toolCalls: state.usage.toolCalls + calls.length,
        },
        progress: progress(state, {
          at: now,
          kind: repeated ? "status" : "turn",
          message: repeated
            ? `Blocked: ${reason}`
            : calls.length > 0
              ? `Turn finished with ${calls.length} work or verification tool call${calls.length === 1 ? "" : "s"}.`
              : "Automatic continuation suppressed because the turn made no work or verification tool calls.",
        }),
      })
      return { state: next, productive: calls.length > 0 && !repeated }
    })

    const continued = Effect.fn("RayaGoal.continued")(function* (sessionID: SessionID) {
      const state = yield* requireGoal(sessionID)
      if (state.status !== "active") {
        return yield* new AuditError({ message: `A ${state.status} goal cannot continue automatically.` })
      }
      const now = Date.now()
      return yield* save(sessionID, {
        ...state,
        updatedAt: now,
        usage: { ...state.usage, continuations: state.usage.continuations + 1 },
        progress: progress(state, {
          at: now,
          kind: "continuation",
          message: `Continuation ${state.usage.continuations + 1} started.`,
        }),
      })
    })

    return { get, create, control, clear, update, evidence, recordTurn, continued }
  }
}
