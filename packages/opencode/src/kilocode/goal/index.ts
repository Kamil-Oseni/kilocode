// raya_change - Milestone A durable native goal state and evidence audit
import { Effect, Schema } from "effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Storage } from "@/storage/storage"
import { RayaSelfHeal } from "@/kilocode/self-heal" // raya_change - synchronize autonomous repair outcomes
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

  // raya_change - the last completion-audit attempt, accepted or rejected. A rejected audit
  // otherwise only surfaces as an AuditError the model narrates into chat; persisting it lets
  // the goal audit-log view show exactly which requirement failed and which evidence was cited.
  export const AuditAttempt = Schema.Struct({
    at: Schema.Number,
    accepted: Schema.Boolean,
    reason: Schema.optional(Schema.String),
    requirements: Schema.Array(Requirement),
  })
  export type AuditAttempt = typeof AuditAttempt.Type

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
    startMessageID: Schema.optional(MessageID), // raya_change - restore the pre-goal checkpoint on discard
    startSnapshot: Schema.optional(Schema.String), // raya_change - restore edits made by child sessions and missing patch parts
    selfHealID: Schema.optional(Schema.String), // raya_change - link an isolated repair session to the global backlog
    status: Status,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    activeMs: Schema.optional(Schema.Number), // raya_change - accumulated execution time excluding paused/terminal time
    activeAt: Schema.optional(Schema.Number), // raya_change - start of the current active interval
    usage: Usage,
    blockedReason: Schema.optional(Schema.String),
    audit: Schema.optional(Audit),
    auditAttempt: Schema.optional(AuditAttempt), // raya_change - last completion attempt for the audit-log view
    progress: Schema.Array(Progress),
  })
  export type State = typeof State.Type

  export const Create = Schema.Struct({
    objective: Schema.String,
    messageID: Schema.optional(MessageID), // raya_change - bind review/discard to the goal's first turn
    selfHealID: Schema.optional(Schema.String), // raya_change - autonomous feedback work linkage
  })

  export const Control = Schema.Struct({
    status: Schema.optional(Schema.Literals(["active", "paused"])),
    objective: Schema.optional(Schema.String), // raya_change - steer the next goal turn without cancelling this one
  })

  // raya_change - model providers require tool parameters to be a top-level JSON object
  export const ModelUpdate = Schema.Struct({
    status: Schema.Literals(["blocked", "complete", "active", "paused"]),
    reason: Schema.optional(Schema.String),
    summary: Schema.optional(Schema.String), // raya_change - top-level summary fills a missing nested audit.summary
    audit: Schema.optional(
      Schema.Struct({
        requirements: Schema.Array(
          Schema.Struct({
            requirement: Schema.String,
            passed: Schema.Boolean,
            evidence: Schema.Array(Evidence),
          }),
        ),
        summary: Schema.optional(Schema.String), // raya_change - accept a complete audit when only the top-level summary is present
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

  type Store = Pick<Storage.Interface, "read" | "write" | "remove" | "list">
  type Sessions = Pick<Session.Interface, "messages" | "children">
  type Deps = {
    storage: Store
    sessions: Sessions
  }

  const controls = new Set(["create_goal", "get_goal", "update_goal"])
  const decode = Schema.decodeUnknownEffect(State)
  const key = (sessionID: SessionID) => ["raya", "goal", sessionID]
  const clean = (value: string) => value.trim()
  const progress = (state: State, item: Progress): Progress[] => [...state.progress, item].slice(-30)
  const retention = 30 * 24 * 60 * 60 * 1000 // raya_change - completed goals expire after one month
  const elapsed = (state: State, now: number) =>
    (state.activeMs ?? 0) + (state.status === "active" ? Math.max(0, now - (state.activeAt ?? state.updatedAt)) : 0)

  export function make(deps: Deps) {
    const healing = RayaSelfHeal.make(deps.storage) // raya_change - linked repairs close or block their global item
    const prune = Effect.fn("RayaGoal.prune")(function* () {
      const keys = yield* deps.storage.list(["raya", "goal"]).pipe(Effect.orDie)
      const rows = yield* Effect.forEach(keys, (path) =>
        deps.storage.read<unknown>(path).pipe(
          Effect.flatMap(decode),
          Effect.map((state) => ({ path, state })),
          Effect.orDie,
        ),
      )
      yield* Effect.forEach(
        rows.filter((row) => row.state.status === "complete" && row.state.updatedAt < Date.now() - retention),
        (row) => deps.storage.remove(row.path).pipe(Effect.orDie),
        { discard: true },
      )
    }) // raya_change - sweep orphaned completed goals whenever goal state is read

    const get = Effect.fn("RayaGoal.get")(function* (sessionID: SessionID) {
      yield* prune()
      const raw = yield* deps.storage.read<unknown>(key(sessionID)).pipe(
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        Effect.orDie,
      )
      if (raw === undefined) return undefined
      const state = yield* decode(raw).pipe(Effect.orDie)
      if (state.status !== "complete" || state.updatedAt >= Date.now() - retention) return state
      yield* deps.storage.remove(key(sessionID)).pipe(Effect.orDie)
      return undefined // raya_change - lazy retention avoids an always-running cleanup process
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

    const create = Effect.fn("RayaGoal.create")(function* (
      sessionID: SessionID,
      objective: string,
      startMessageID?: MessageID,
      startSnapshot?: string,
      selfHealID?: string,
    ) {
      const text = clean(objective)
      if (!text) return yield* new AuditError({ message: "A goal objective is required." })
      const existing = yield* get(sessionID)
      if (existing?.objective === text && existing.status === "active") return existing // raya_change - retry failed first request
      if (existing) return yield* new ExistsError({ sessionID })
      const now = Date.now()
      return yield* save(sessionID, {
        objective: text,
        startMessageID,
        startSnapshot,
        selfHealID,
        status: "active",
        createdAt: now,
        updatedAt: now,
        activeMs: 0,
        activeAt: now,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [{ at: now, kind: "status", message: "Goal armed." }],
      })
    })

    const control = Effect.fn("RayaGoal.control")(function* (sessionID: SessionID, status: "active" | "paused") {
      const state = yield* requireGoal(sessionID)
      if (state.status === "complete") {
        return yield* new AuditError({
          message: `A ${state.status} goal cannot be ${status === "active" ? "resumed" : "paused"}.`,
        })
      }
      if (status === "paused" && state.status === "blocked") {
        return yield* new AuditError({ message: "A blocked goal cannot be paused." })
      }
      const now = Date.now()
      return yield* save(sessionID, {
        ...state,
        status,
        updatedAt: now,
        activeMs: elapsed(state, now),
        activeAt: status === "active" ? now : undefined,
        progress: progress(state, {
          at: now,
          kind: "status",
          message: status === "active" ? "Goal resumed." : "Goal paused.",
        }),
      })
    })

    // raya_change start - persist steering immediately; the current model turn
    // remains untouched and the continuation reads the revised objective.
    const revise = Effect.fn("RayaGoal.revise")(function* (sessionID: SessionID, objective: string) {
      const state = yield* requireGoal(sessionID)
      if (state.status === "complete") {
        return yield* new AuditError({ message: "A completed goal cannot be revised." })
      }
      const text = clean(objective)
      if (!text) return yield* new AuditError({ message: "A goal objective is required." })
      if (text === state.objective) return state
      const now = Date.now()
      return yield* save(sessionID, {
        ...state,
        objective: text,
        blockedReason: undefined,
        status: state.status === "blocked" ? "active" : state.status,
        updatedAt: now,
        activeAt: state.status === "blocked" ? now : state.activeAt,
        audit: undefined,
        progress: progress(state, {
          at: now,
          kind: "status",
          message:
            state.status === "blocked"
              ? "Goal updated. Work will resume with the revision."
              : "Goal updated. The current step will finish before the revision takes effect.",
        }),
      })
    })
    // raya_change end

    const clear = Effect.fn("RayaGoal.clear")(function* (sessionID: SessionID) {
      yield* deps.storage.remove(key(sessionID)).pipe(Effect.orDie)
    })

    const tools = (messages: SessionV1.WithParts[]) =>
      messages.flatMap((message) =>
        message.info.role === "assistant"
          ? message.parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
          : [],
      )

    // raya_change start - the Auto orchestrator delegates work to subagents whose
    // tool calls (the real file writes and verifications) land in child sessions.
    // The completion audit and get_goal evidence must see those callIDs, otherwise
    // valid evidence is rejected and the goal can never complete — it gets forced
    // to blocked. Gather the goal session plus every descendant, matching how
    // files-only discard (SessionRevert.discardChanges) already walks children.
    const collect = Effect.fn("RayaGoal.collect")(function* (sessionID: SessionID) {
      const all: SessionV1.WithParts[] = []
      const queue: SessionID[] = [sessionID]
      while (queue.length > 0) {
        const id = queue.shift()
        if (!id) break
        const msgs = yield* deps.sessions.messages({ sessionID: id })
        for (const msg of msgs) all.push(msg)
        const kids = yield* deps.sessions.children(id)
        for (const kid of kids) queue.push(kid.id)
      }
      return all
    })
    // raya_change end

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
      const messages = yield* collect(sessionID) // raya_change - include subagent child-session tool calls
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
          // raya_change - Milestone G exposes host-authored smoke evidence to the completion audit
          smoke:
            part.state.status === "completed" && part.tool === "browser_smoke_test"
              ? {
                  passed: part.state.metadata["passed"],
                  runID: part.state.metadata["runID"],
                  artifact: part.state.metadata["artifact"],
                  failingStep: part.state.metadata["failingStep"],
                }
              : undefined,
        }))
    })

    const update = Effect.fn("RayaGoal.update")(function* (sessionID: SessionID, input: ModelUpdate) {
      const state = yield* requireGoal(sessionID)
      const now = Date.now()
      if (input.status === "active") {
        if (state.status !== "blocked" && state.status !== "paused") {
          return yield* new AuditError({ message: `Only a blocked or paused goal can be marked active.` })
        }
        return yield* save(sessionID, {
          ...state,
          status: "active",
          blockedReason: undefined,
          updatedAt: now,
          activeAt: now,
          progress: progress(state, { at: now, kind: "status", message: "Goal resumed." }),
        })
      }
      if (input.status === "blocked") {
        // raya_change start - blocking is idempotent. recordTurn can auto-block a goal
        // when the model narrates completion without a clean update_goal; the model then
        // has no way to report blocked because the old rule required an active goal, so it
        // burned steps retrying a rejected call. Only a completed goal cannot be blocked.
        if (state.status === "complete") {
          return yield* new AuditError({ message: `A completed goal cannot be marked blocked.` })
        }
        const reason = clean(input.reason ?? "")
        if (!reason) return yield* new AuditError({ message: "A blocked goal requires a plain reason." })
        const wasActive = state.status === "active"
        const next = yield* save(sessionID, {
          ...state,
          status: "blocked",
          blockedReason: reason,
          updatedAt: now,
          activeMs: wasActive ? elapsed(state, now) : state.activeMs,
          activeAt: undefined,
          progress: progress(state, { at: now, kind: "status", message: `Blocked: ${reason}` }),
        })
        // raya_change end
        if (state.selfHealID) {
          yield* healing
            .update(state.selfHealID, { status: "blocked", blockedReason: reason, reloadRequired: false })
            .pipe(Effect.orDie)
        }
        return next
      }
      // raya_change start - let the agent self-pause when it hits an approval wall
      // instead of blocking, so the user can act and the goal resumes cleanly.
      if (input.status === "paused") {
        if (state.status !== "active") {
          return yield* new AuditError({ message: `Only an active goal can be paused.` })
        }
        const reason = clean(input.reason ?? "")
        return yield* save(sessionID, {
          ...state,
          status: "paused",
          updatedAt: now,
          activeMs: elapsed(state, now),
          activeAt: undefined,
          progress: progress(state, {
            at: now,
            kind: "status",
            message: reason ? `Paused: ${reason}` : "Goal paused.",
          }),
        })
      }
      // raya_change end
      if (state.status !== "active" && state.status !== "blocked") {
        return yield* new AuditError({ message: `Only an active or blocked goal can be marked complete.` })
      }
      if (!input.audit) {
        return yield* new AuditError({ message: "Completion requires a requirement-by-requirement audit." })
      }
      const messages = yield* collect(sessionID) // raya_change - subagent child-session calls are valid evidence
      const submitted = {
        ...input.audit,
        summary: input.audit.summary ?? input.summary ?? input.audit.requirements[0]?.requirement ?? "",
      }
      // raya_change start - persist the attempt whether it passes or fails, so a goal that
      // stays blocked/active after a rejected completion still carries the requirement-by-
      // requirement detail and rejection reason for the audit-log view.
      const audit = yield* validateForSession(submitted, messages, state.createdAt, state.objective).pipe(
        Effect.catchTag("RayaGoal.AuditError", (err) =>
          save(sessionID, {
            ...state,
            updatedAt: now,
            auditAttempt: { at: now, accepted: false, reason: err.message, requirements: submitted.requirements },
            progress: progress(state, {
              at: now,
              kind: "status",
              message: `Completion audit rejected: ${err.message}`,
            }),
          }).pipe(Effect.flatMap(() => Effect.fail(err))),
        ),
      )
      const next = yield* save(sessionID, {
        ...state,
        status: "complete",
        audit,
        auditAttempt: { at: now, accepted: true, requirements: audit.requirements },
        updatedAt: now,
        activeMs: elapsed(state, now),
        activeAt: undefined,
        progress: progress(state, { at: now, kind: "status", message: "Completion audit passed." }),
      })
      // raya_change end
      if (state.selfHealID) {
        const evidence = audit.requirements.flatMap((requirement) =>
          requirement.evidence.map((item) => ({
            summary: `${requirement.requirement}: ${item.summary}`,
            artifact: item.callID,
            at: now,
          })),
        )
        yield* healing
          .update(state.selfHealID, {
            status: "verified",
            evidence,
            blockedReason: undefined,
            reloadRequired: true,
          })
          .pipe(Effect.orDie)
      }
      return next
    })

    const validateForSession = Effect.fn("RayaGoal.validateAuditForSession")(function* (
      audit: NonNullable<ModelUpdate["audit"]>,
      messages: SessionV1.WithParts[],
      createdAt: number,
      objective: string,
    ) {
      if (audit.requirements.length === 0) {
        return yield* new AuditError({ message: "Completion requires at least one concrete requirement." })
      }
      const parts = tools(messages)
      // raya_change start - build an actionable menu of the real, eligible evidence callIDs.
      // Providers that expose tool calls as text markup emit unstable/colliding callIDs
      // (e.g. dsml-0), so the model repeatedly cites the wrong one and exhausts its step
      // budget guessing. Listing the true eligible IDs in the rejection lets it self-correct
      // in one retry instead of many.
      const eligible = parts.filter(
        (part) => part.state.status === "completed" && started(part) >= createdAt && !controls.has(part.tool),
      )
      const menu =
        eligible
          .map((part) => `${part.callID} (${part.tool})`)
          .slice(0, 20)
          .join(", ") || "none yet — perform and verify concrete work before completing"
      // raya_change end
      const needsSmoke = (value: string) =>
        /smoke(?:\s|-)*test.{0,40}(?:pass|green)|(?:pass|green).{0,40}smoke(?:\s|-)*test/i.test(value)
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
        const cited: SessionV1.ToolPart[] = []
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
              // raya_change - name the real eligible callIDs so the model retries correctly once
              message: `Evidence ${ref} is not a completed post-goal work or verification tool call. Eligible evidence callIDs: ${menu}.`,
            })
          }
          cited.push(part)
          if (part.tool === "bash" && part.state.metadata["exit"] !== 0) {
            return yield* new AuditError({
              message: `Command evidence ${ref} did not exit successfully.`,
            })
          }
          // raya_change start - Milestone G failed smoke reports can never prove completion
          if (
            part.tool === "browser_smoke_test" &&
            (part.state.metadata["passed"] !== true || part.state.metadata["evidence"] !== "raya-smoke-v1")
          ) {
            return yield* new AuditError({
              message: `Smoke-test evidence ${ref} is not green${
                part.state.metadata["failingStep"] ? `; failing step: ${part.state.metadata["failingStep"]}` : ""
              }.`,
            })
          }
          // raya_change end
          if (!clean(evidence.summary)) {
            return yield* new AuditError({ message: "Every evidence reference needs a plain summary." })
          }
        }
        // raya_change start - Milestone G smoke-gated goals require genuine host smoke evidence
        if (
          (needsSmoke(objective) || needsSmoke(requirement.requirement)) &&
          !cited.some(
            (part) =>
              part.tool === "browser_smoke_test" &&
              part.state.status === "completed" &&
              part.state.metadata["passed"] === true &&
              part.state.metadata["evidence"] === "raya-smoke-v1",
          )
        ) {
          return yield* new AuditError({
            message: `Requirement needs a completed green browser_smoke_test result: ${requirement.requirement}`,
          })
        }
        // raya_change end
      }
      const summary = clean(audit.summary ?? "")
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
      const assistants = messages.filter(
        (message) => message.info.role === "assistant" && message.info.parentID === user.info.id,
      )
      const calls = assistants
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && !controls.has(part.tool))
      // raya_change start - a provider can expose tool-call markup as plain text.
      // Stop instead of repeating destructive work when the model says it is done
      // but update_goal never actually reached the runtime.
      const reply = assistants
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      const claimed =
        /\b(?:task|goal|objective|work)\s+(?:is|was|has been)\s+(?:now\s+)?(?:complete|completed|done|satisfied)\b|\bnothing further\b|\bno further (?:work|action)\b|\bobjective is satisfied\b/i.test(
          reply,
        )
      const invalid = state.status === "active" && claimed
      // raya_change end
      const current = new Set(calls.map((part) => part.callID))
      const prior = tools(messages).filter((part) => !current.has(part.callID) && started(part) >= state.createdAt)
      const repeated =
        calls.length > 0 && calls.every((call) => prior.some((part) => fingerprint(part) === fingerprint(call)))
      const stalled = state.status === "active" && calls.length === 0 // raya_change - never leave a silent active zombie
      const now = Date.now()
      const reason = invalid
        ? "The model reported completion without successfully calling update_goal. Review the result, then steer or stop it."
        : repeated
          ? "Automatic continuation repeated the same tool work without new evidence."
          : "The turn ended without work, verification, or a goal status update. Steer the goal or stop it."
      const stopped = invalid || repeated || stalled
      const next = yield* save(sessionID, {
        ...state,
        status: stopped ? "blocked" : state.status,
        blockedReason: stopped ? reason : state.blockedReason,
        updatedAt: now,
        activeMs: stopped ? elapsed(state, now) : state.activeMs,
        activeAt: stopped ? undefined : state.activeAt,
        usage: {
          ...state.usage,
          turns: state.usage.turns + 1,
          toolCalls: state.usage.toolCalls + calls.length,
        },
        progress: progress(state, {
          at: now,
          kind: stopped ? "status" : "turn",
          message: stopped
            ? `Blocked: ${reason}`
            : calls.length > 0
              ? `Turn finished with ${calls.length} work or verification tool call${calls.length === 1 ? "" : "s"}.`
              : "Automatic continuation suppressed because the turn made no work or verification tool calls.",
        }),
      })
      return { state: next, productive: calls.length > 0 && !stopped }
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

    return { get, create, control, revise, clear, update, evidence, recordTurn, continued }
  }
}
