// raya_change - Milestone A durable native goal state and evidence audit
import { Cause, Effect, Fiber, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Storage } from "@/storage/storage"
import { RayaSelfHeal } from "@/kilocode/self-heal" // raya_change - synchronize autonomous repair outcomes
import type { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { references } from "./references"
import { GoalCriteria as Criteria } from "./criteria"
import * as Planning from "./plan"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { mutation } from "./mutation"
import { gate } from "@/kilocode/session/input-gate"
import type { SessionRunState } from "@/session/run-state"
import type * as TaskWorker from "@/kilocode/session/task-worker"
import { Receipt, receipts } from "./stop-receipt"
import type { BackgroundJob } from "@/background/job"
import { outstanding } from "./stop-jobs"
import { settle } from "./owned-jobs"
import * as Artifact from "./artifact"
import { inspection } from "@opencode-ai/core/kilocode/evidence-inspection"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import { collect } from "./evidence-scope"
import { verification, identity as sourceIdentity } from "@/kilocode/self-heal/verification"

const log = Log.create({ service: "raya-goal-retention" })

export namespace RayaGoal {
  export const Stop = Receipt
  export const Status = Schema.Literals(["active", "paused", "complete", "blocked"])
  export type Status = typeof Status.Type

  export const Evidence = Schema.Struct({
    messageID: Schema.optional(MessageID),
    partID: Schema.optional(PartID).annotate({
      description:
        "Exact tool-result part ID from get_goal. Required to disambiguate repeated call IDs within a message.",
    }),
    sessionID: Schema.optional(SessionID),
    callID: Schema.String,
    summary: Schema.String,
    record: Schema.optional(Schema.Struct({ version: Schema.Literal(1), digest: Schema.String, at: Schema.Number })),
  })
  export type Evidence = typeof Evidence.Type

  export const Requirement = Schema.Struct({
    criterionID: Schema.optional(Schema.String).annotate({
      description:
        "For a saved goal criterion, use its exact ID and description. Every saved criterion requires exactly one audited requirement.",
    }),
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

  export const Review = Schema.Struct({
    status: Schema.Literals(["pending", "accepted"]),
    at: Schema.Number,
    criteria: Schema.Array(Schema.String),
    acceptedAt: Schema.optional(Schema.Number),
  })

  export const Revision = Schema.Struct({
    review: Schema.optional(Review),
    id: Schema.String,
    at: Schema.Number,
    source: Schema.Literals(["steering", "control"]),
    intent: Schema.optional(Schema.String),
    objective: Schema.String,
    criteria: Schema.optional(Criteria),
    plan: Schema.optional(Planning.Plan),
    audit: Schema.optional(Audit),
    auditAttempt: Schema.optional(AuditAttempt),
  })

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
    retries: Schema.optional(Schema.Number), // consecutive recoveries; reset after success, steering, or resume
  })
  export type Usage = typeof Usage.Type

  // Completed goals stay visible in the session carousel after a new one is armed.
  export const HistoryItem = Schema.Struct({
    review: Schema.optional(Review),
    revisions: Schema.optional(Schema.Array(Revision)),
    plan: Schema.optional(Planning.Plan),
    usage: Schema.optional(Usage),
    activeMs: Schema.optional(Schema.Number),
    objective: Schema.String,
    criteria: Schema.optional(Criteria),
    status: Status,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    blockedReason: Schema.optional(Schema.String),
    audit: Schema.optional(Audit),
    auditAttempt: Schema.optional(AuditAttempt),
  })
  export type HistoryItem = typeof HistoryItem.Type

  export const State = Schema.Struct({
    review: Schema.optional(Review),
    revisions: Schema.optional(Schema.Array(Revision)),
    plan: Schema.optional(Planning.Plan),
    objective: Schema.String,
    revision: Schema.optional(Schema.String),
    intent: Schema.optional(Schema.String),
    inputs: Schema.optional(Schema.Array(MessageID)).annotate({
      description:
        "Root input identities recorded when this goal's workers bind; retained across continuation and control changes.",
    }),
    dispatch: Schema.optional(
      Schema.Struct({
        id: Schema.String,
        messageID: Schema.optional(MessageID),
        intent: Schema.String,
        phase: Schema.Literals(["queued", "started", "finished"]),
        queuedAt: Schema.Number,
        startedAt: Schema.optional(Schema.Number),
        finishedAt: Schema.optional(Schema.Number),
        assistantID: Schema.optional(MessageID),
        worker: Schema.optional(Schema.String),
        outcome: Schema.optional(Schema.Literals(["completed", "error", "interrupted"])),
      }),
    ),
    retryEvents: Schema.optional(Schema.Array(Schema.String)),
    accounted: Schema.optional(Schema.Struct({ userID: MessageID, messages: Schema.Array(MessageID) })),
    criteria: Schema.optional(Criteria),
    startMessageID: Schema.optional(MessageID), // raya_change - restore the pre-goal checkpoint on discard
    startSnapshot: Schema.optional(Schema.String), // raya_change - restore edits made by child sessions and missing patch parts
    selfHealAttempt: Schema.optional(Schema.String), // server-derived durable repair owner
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
    history: Schema.optional(Schema.Array(HistoryItem)),
  })
  export type State = typeof State.Type

  export const Create = Schema.Struct({
    objective: Schema.String,
    messageID: Schema.optional(MessageID), // raya_change - bind review/discard to the goal's first turn
    selfHealID: Schema.optional(Schema.String), // raya_change - autonomous feedback work linkage
  })

  export const Control = Schema.Struct({
    accept: Schema.optional(Schema.Literal(true)),
    criteria: Schema.optional(Criteria),
    status: Schema.optional(Schema.Literals(["active", "paused"])),
    objective: Schema.optional(Schema.String), // raya_change - steer the next goal turn without cancelling this one
    expectedIntent: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  })

  // raya_change - model providers require tool parameters to be a top-level JSON object
  export const ModelUpdate = Schema.Struct({
    status: Schema.Literals(["blocked", "complete", "active", "paused"]),
    reason: Schema.optional(Schema.String),
    summary: Schema.optional(Schema.String), // raya_change - top-level summary fills a missing nested audit.summary
    // raya_change - models overwhelmingly flatten the audit, emitting `requirements` at the top
    // level as a sibling of `status` instead of under `audit`. Effect's Struct silently drops
    // unknown keys, so those valid completions used to decode with audit=undefined and get
    // rejected as "requires an audit", exhausting the step budget. Accept both shapes.
    requirements: Schema.optional(Schema.Array(Requirement)),
    audit: Schema.optional(
      Schema.Struct({
        requirements: Schema.Array(Requirement),
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
    conflict: Schema.optional(Schema.Literal(true)),
  }) {}

  type Store = Pick<Storage.Interface, "read" | "write" | "remove" | "list" | "create" | "replace">
  export const openKey = "raya.goal.open"
  export const idleLimit = 3
  export const retryLimit = 3

  type Sessions = Pick<Session.Interface, "messages" | "children"> &
    Partial<Pick<Session.Interface, "get" | "setMetadata">>
  type Deps = {
    storage: Store
    sessions: Sessions
  }

  const controls = new Set(["create_goal", "get_goal", "update_goal", "update_goal_plan"])
  const supports = (part: SessionV1.ToolPart) => !controls.has(part.tool) && part.tool !== "task"
  const decode = Schema.decodeUnknownEffect(State)
  const key = (sessionID: SessionID) => ["raya", "goal", sessionID]
  const clean = (value: string) => value.trim()
  const progress = (state: State, item: Progress): Progress[] => [...state.progress, item].slice(-30)
  const retention = 30 * 24 * 60 * 60 * 1000 // Unreferenced completed goals expire after one month.
  const elapsed = (state: State, now: number) =>
    (state.activeMs ?? 0) + (state.status === "active" ? Math.max(0, now - (state.activeAt ?? state.updatedAt)) : 0)

  const revisions = (state: State, at: number, source: typeof Revision.Type.source) => [
    ...(state.revisions ?? []),
    {
      id: crypto.randomUUID(),
      at,
      source,
      intent: state.intent,
      objective: state.objective,
      review: state.review,
      criteria: state.criteria,
      plan: state.plan,
      audit: state.audit,
      auditAttempt: state.auditAttempt,
    },
  ]

  export function make(deps: Deps) {
    const source = verification(deps.storage)
    const healing = RayaSelfHeal.make(deps.storage) // raya_change - linked repairs close or block their global item
    const ownership = Effect.fn(function* (sessionID: SessionID, id: string, attempt?: string) {
      const owned = yield* healing
        .link(id, sessionID, attempt)
        .pipe(Effect.mapError((err) => new AuditError({ message: err.message })))
      const session = deps.sessions.get
        ? yield* deps.sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : undefined
      const normalize = (value: string) =>
        process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
      if (
        !session ||
        normalize(session.directory) !== normalize(owned.worktree!.directory) ||
        session.metadata?.rayaSelfHealAttempt !== owned.id ||
        !isDeepStrictEqual(session.metadata?.rayaSelfHealSource, owned.source) ||
        !isDeepStrictEqual(session.metadata?.rayaSelfHealWorktree, owned.worktree)
      )
        return yield* new AuditError({
          message: "The persisted repair session does not match its owned checkout and attempt provenance.",
        })
      return owned
    })
    const repair = Effect.fn(function* (sessionID: SessionID) {
      const state = yield* requireGoal(sessionID)
      if (!state.selfHealID || !state.selfHealAttempt)
        return yield* new AuditError({ message: "Legacy or missing repair linkage requires reconciliation." })
      return yield* ownership(sessionID, state.selfHealID, state.selfHealAttempt)
    })

    const prune = Effect.fn("RayaGoal.prune")(function* () {
      const keys = yield* deps.storage.list(["raya", "goal"]).pipe(Effect.orDie)
      const rows = yield* Effect.forEach(keys, (path) =>
        deps.storage.read<unknown>(path).pipe(
          Effect.flatMap(decode),
          Effect.map((state) => ({ path, state })),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.sync(() => {
                  log.warn("Goal cleanup skipped an unreadable record.", { sessionID: path.at(-1) })
                  return undefined
                }),
          ),
          Effect.orDie,
        ),
      )
      const expired = rows
        .filter((row) => row !== undefined)
        .filter((row) => row.state.status === "complete" && row.state.updatedAt < Date.now() - retention)
      if (!expired.length) return
      const retained = yield* references(deps.storage)
      if (!retained) return
      yield* Effect.forEach(
        expired.filter((row) => !retained.has(row.path.at(-1)!)),
        (row) =>
          mutation(
            deps.storage,
            row.path.at(-1)!,
            Effect.gen(function* () {
              const current = yield* deps.storage.read(row.path).pipe(
                Effect.catchIf(
                  (err) => Storage.NotFoundError.isInstance(err),
                  () => Effect.succeed(undefined),
                ),
                Effect.orDie,
              )
              if (isDeepStrictEqual(current, row.state)) yield* deps.storage.remove(row.path).pipe(Effect.orDie)
            }),
          ),
        { discard: true },
      )
    }) // raya_change - sweep orphaned completed goals whenever goal state is read

    const get = Effect.fn("RayaGoal.get")(function* (sessionID: SessionID) {
      yield* prune().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.sync(() => log.warn("Goal cleanup deferred; reading the requested goal directly.")),
        ),
      )
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

    const save = (
      sessionID: SessionID,
      state: State,
      expected: State | null = state,
      before?: (next: State) => Effect.Effect<string, AuditError>,
    ) =>
      mutation(
        deps.storage,
        sessionID,
        Effect.gen(function* () {
          const current = yield* deps.storage.read<unknown>(key(sessionID)).pipe(
            Effect.catchIf(
              (err) => Storage.NotFoundError.isInstance(err),
              () => Effect.succeed(undefined),
            ),
            Effect.orDie,
          )
          const previous = current === undefined ? undefined : yield* decode(current).pipe(Effect.orDie)
          if (
            expected === null
              ? previous !== undefined
              : !previous || previous.revision !== expected.revision || previous.createdAt !== expected.createdAt
          )
            return yield* new AuditError({
              conflict: true,
              message:
                "This goal changed while the operation was running. Read get_goal and review the current objective before retrying.",
            })
          const candidate = { ...state, revision: crypto.randomUUID() }
          const next = { ...candidate, revision: before ? yield* before(candidate) : candidate.revision }
          yield* deps.storage.replace(key(sessionID), next).pipe(Effect.orDie)
          if (deps.sessions.get && deps.sessions.setMetadata) {
            const session = yield* deps.sessions.get(sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (session) {
              yield* deps.sessions
                .setMetadata({
                  sessionID,
                  metadata: { ...session.metadata, [openKey]: state.status === "active" },
                })
                .pipe(Effect.catch(() => Effect.void))
            }
          }
          return next
        }),
      )

    const create = Effect.fn("RayaGoal.create")(function* (
      sessionID: SessionID,
      objective: string,
      startMessageID?: MessageID,
      startSnapshot?: string,
      selfHealID?: string,
      criteria?: Criteria,
    ) {
      const linked = selfHealID ? yield* ownership(sessionID, selfHealID) : undefined
      const text = clean(objective)
      if (!text) return yield* new AuditError({ message: "A goal objective is required." })
      const required =
        criteria === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(Criteria)(criteria).pipe(
              Effect.mapError(
                () =>
                  new AuditError({
                    message: "Goal criteria require valid IDs, descriptions and verification instructions.",
                  }),
              ),
            )
      if (required && new Set(required.map((item) => item.id)).size !== required.length)
        return yield* new AuditError({ message: "Goal criterion IDs must be unique." })
      const existing = yield* get(sessionID)
      if (existing && existing.status !== "complete" && existing.selfHealID !== selfHealID)
        return yield* new AuditError({ message: "An existing goal cannot be linked to a different self-heal item." })
      if (
        existing?.objective === text &&
        existing.status === "active" &&
        isDeepStrictEqual(existing.criteria, required)
      )
        return existing // raya_change - retry failed first request without changing requirements
      // A completed goal must not block the next /goal. Archive it so the banner
      // can page through past work, then arm the new one. An active/paused/blocked
      // goal still rejects so the HTTP layer can steer it instead of 400-ing the prompt.
      if (existing && existing.status !== "complete") return yield* new ExistsError({ sessionID })
      const prior =
        existing?.status === "complete"
          ? [
              ...(existing.history ?? []),
              {
                objective: existing.objective,
                revisions: existing.revisions,
                review: existing.review,
                plan: existing.plan,
                usage: existing.usage,
                activeMs: existing.activeMs,
                criteria: existing.criteria,
                status: existing.status,
                createdAt: existing.createdAt,
                updatedAt: existing.updatedAt,
                blockedReason: existing.blockedReason,
                audit: existing.audit,
                auditAttempt: existing.auditAttempt,
              },
            ].slice(-20)
          : existing?.history
      const now = Date.now()
      return yield* save(
        sessionID,
        {
          objective: text,
          intent: crypto.randomUUID(),
          criteria: required,
          startMessageID,
          startSnapshot,
          selfHealID,
          selfHealAttempt: linked?.id,
          status: "active",
          createdAt: now,
          updatedAt: now,
          activeMs: 0,
          activeAt: now,
          usage: { turns: 0, continuations: 0, toolCalls: 0, retries: 0 },
          progress: [{ at: now, kind: "status", message: "Goal armed." }],
          history: prior,
        },
        existing ?? null,
      )
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
        review: status === "active" ? undefined : state.review,
        intent: crypto.randomUUID(),
        blockedReason: status === "active" ? undefined : state.blockedReason,
        usage: status === "active" && state.status !== "active" ? { ...state.usage, retries: 0 } : state.usage,
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
        intent: crypto.randomUUID(),
        usage: { ...state.usage, retries: 0 },
        revisions: revisions(state, now, "steering"),
        review: undefined,
        blockedReason: undefined,
        status: state.status === "blocked" ? "active" : state.status,
        updatedAt: now,
        activeAt: state.status === "blocked" ? now : state.activeAt,
        audit: undefined,
        auditAttempt: undefined,
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

    const edit = Effect.fn("RayaGoal.edit")(function* (sessionID: SessionID, input: typeof Control.Type) {
      const prior = yield* requireGoal(sessionID)
      if (input.expectedIntent !== undefined && input.expectedIntent !== (prior.intent ?? "unset")) {
        return yield* new AuditError({
          conflict: true,
          message: "This goal changed since you reviewed it. Reload it before saving.",
        })
      }
      if (input.accept === true) {
        if (!input.expectedIntent || prior.status !== "paused" || prior.review?.status !== "pending" || !prior.audit)
          return yield* new AuditError({ message: "Review the current pending goal before accepting it." })
        if (
          input.criteria !== undefined ||
          input.status !== undefined ||
          (input.objective !== undefined && clean(input.objective) !== prior.objective)
        )
          return yield* new AuditError({
            message: "Accept the reviewed goal separately from changing its requirements.",
          })
        const state = yield* complete(sessionID, prior, { status: "complete", audit: prior.audit }, true)
        return { prior, state }
      }
      if (input.status === undefined && input.objective === undefined && input.criteria === undefined) {
        return yield* new AuditError({ message: "A goal edit requires an objective, criteria or status." })
      }
      if (prior.status === "complete") {
        return yield* new AuditError({ message: "A completed goal cannot be edited." })
      }
      const objective = input.objective === undefined ? prior.objective : clean(input.objective)
      if (!objective) return yield* new AuditError({ message: "A goal objective is required." })
      if (input.criteria !== undefined && input.expectedIntent === undefined)
        return yield* new AuditError({
          message: "Review the current goal revision before editing acceptance criteria.",
        })
      const criteria =
        input.criteria === undefined
          ? prior.criteria
          : yield* Schema.decodeUnknownEffect(Criteria)(input.criteria).pipe(
              Effect.mapError(
                () =>
                  new AuditError({
                    message: "Acceptance criteria require valid IDs, descriptions and verification instructions.",
                  }),
              ),
            )
      if (criteria && new Set(criteria.map((item) => item.id)).size !== criteria.length)
        return yield* new AuditError({ message: "Acceptance criterion IDs must be unique." })
      const revised = !isDeepStrictEqual(criteria, prior.criteria)
      const changed = objective !== prior.objective || revised
      const status = input.status ?? (changed && prior.status === "blocked" ? "active" : prior.status)
      if (status === "paused" && prior.status === "blocked" && !changed) {
        return yield* new AuditError({ message: "A blocked goal cannot be paused." })
      }
      if (!changed && input.status === undefined) return { prior, state: prior }
      const now = Date.now()
      const next = yield* save(sessionID, {
        ...prior,
        objective,
        criteria,
        plan: revised && prior.plan ? { ...prior.plan, review: true } : prior.plan,
        revisions: changed ? revisions(prior, now, "control") : prior.revisions,
        review: changed || status === "active" ? undefined : prior.review,
        status,
        intent: crypto.randomUUID(),
        updatedAt: now,
        blockedReason: changed || (status === "active" && prior.status !== "active") ? undefined : prior.blockedReason,
        usage:
          changed || (status === "active" && prior.status !== "active") ? { ...prior.usage, retries: 0 } : prior.usage,
        audit: changed ? undefined : prior.audit,
        auditAttempt: changed ? undefined : prior.auditAttempt,
        activeMs: input.status !== undefined ? elapsed(prior, now) : prior.activeMs,
        activeAt:
          status !== "active"
            ? undefined
            : input.status !== undefined || prior.status !== "active"
              ? now
              : prior.activeAt,
        progress: progress(prior, {
          at: now,
          kind: "status",
          message: changed
            ? status === "paused"
              ? "Goal updated and paused."
              : "Goal updated. The next step will use the new direction."
            : status === "paused"
              ? "Goal paused."
              : "Goal resumed.",
        }),
      })
      return { prior, state: next }
    })

    const plan = Effect.fn("RayaGoal.plan")(function* (sessionID: SessionID, input: typeof Planning.Update.Type) {
      const prior = yield* requireGoal(sessionID)
      if (prior.status === "complete")
        return yield* new AuditError({ message: "A completed goal's plan cannot be edited." })
      if (
        input.expectedIntent !== (prior.intent ?? "unset") ||
        input.expectedRevision !== (prior.plan?.revision ?? null)
      )
        return yield* new AuditError({
          conflict: true,
          message: "The goal or plan changed. Read get_goal before updating the plan.",
        })
      const tasks = yield* Schema.decodeUnknownEffect(Planning.Tasks)(input.tasks).pipe(
        Effect.mapError(
          () =>
            new AuditError({
              message: "Plan tasks require valid IDs, descriptions, outputs, owners, verification and status.",
            }),
        ),
      )
      const error = Planning.validate(tasks)
      if (error) return yield* new AuditError({ message: error })
      if (prior.plan?.objective === prior.objective && !prior.plan.review && isDeepStrictEqual(prior.plan.tasks, tasks))
        return prior
      const now = Date.now()
      return yield* save(
        sessionID,
        {
          ...prior,
          plan: { objective: prior.objective, revision: crypto.randomUUID(), at: now, tasks },
          updatedAt: now,
          progress: progress(prior, { at: now, kind: "status", message: "Goal work plan updated." }),
        },
        prior,
      )
    })

    const remove = Effect.fn("RayaGoal.remove")(function* (sessionID: SessionID, expectedIntent?: string) {
      yield* mutation(
        deps.storage,
        sessionID,
        Effect.gen(function* () {
          if (expectedIntent !== undefined) {
            const raw = yield* deps.storage.read<unknown>(key(sessionID)).pipe(
              Effect.catchIf(
                (err) => Storage.NotFoundError.isInstance(err),
                () => Effect.succeed(undefined),
              ),
              Effect.orDie,
            )
            const current = raw === undefined ? undefined : yield* decode(raw).pipe(Effect.orDie)
            if (!current || expectedIntent !== (current.intent ?? "unset"))
              return yield* new AuditError({
                conflict: true,
                message: "The goal changed since you reviewed it. Review the current goal before stopping it.",
              })
          }
          return yield* deps.storage.remove(key(sessionID)).pipe(Effect.orDie)
        }),
      )
    })

    function clear(sessionID: SessionID): Effect.Effect<void>
    function clear(sessionID: SessionID, expectedIntent: string): Effect.Effect<void, AuditError>
    function clear(sessionID: SessionID, expectedIntent?: string) {
      return remove(sessionID, expectedIntent)
    }

    const stop = Effect.fn("RayaGoal.stop")(function* (
      sessionID: SessionID,
      intent: string,
      runs: Pick<SessionRunState.Interface, "requestCancel">,
      background?: Pick<BackgroundJob.Interface, "list" | "cancel"> &
        Partial<Pick<BackgroundJob.Interface, "cancelInput">>,
      workers?: Pick<TaskWorker.Interface, "stop">,
    ) {
      const records = receipts(deps.storage)
      const amend = (update: (receipt: Receipt) => Receipt) =>
        mutation(
          deps.storage,
          sessionID,
          Effect.gen(function* () {
            const receipt = yield* records.read(sessionID, intent)
            if (!receipt || receipt.phase !== "cleared")
              return yield* Effect.die(new Error("Goal stop receipt is not awaiting cancellation results"))
            return yield* records.save(update(receipt))
          }),
        )
      const work = mutation(
        deps.storage,
        sessionID,
        Effect.gen(function* () {
          const prior = yield* records.read(sessionID, intent)
          // Never reissue cancellation once the removal boundary was recorded.
          if (prior && prior.phase !== "requested") return Effect.succeed(prior)
          const raw = yield* deps.storage.read<unknown>(key(sessionID)).pipe(
            Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
            Effect.orDie,
          )
          const state = raw === undefined ? undefined : yield* decode(raw).pipe(Effect.orDie)
          if (!state && prior) {
            const receipt = yield* records.save({ ...prior, phase: "cleared" })
            return Effect.succeed(receipt)
          }
          if (!state || intent !== (state.intent ?? "unset"))
            return yield* new AuditError({
              conflict: true,
              message: "The goal changed since you reviewed it. Review the current goal before stopping it.",
            })
          const dispatch = state.dispatch
          const rows = yield* deps.sessions.messages({ sessionID }).pipe(Effect.orDie)
          const users = rows.filter((row) => row.info.role === "user")
          const latest = users.toSorted((a, b) => b.info.id.localeCompare(a.info.id))[0]
          const owned =
            dispatch?.phase === "started" &&
            dispatch.worker &&
            dispatch.messageID &&
            latest?.info.id === dispatch.messageID &&
            !users.some((row) => row.info.id !== dispatch.messageID && row.info.time.created > dispatch.queuedAt)
          // Commit tracking removal and select cancellation under the control/input locks.
          // Worker cleanup may write goal state, so only await it after releasing both locks.
          const receipt = prior ?? { sessionID, intent, phase: "requested" as const, at: Date.now() }
          if (!prior) yield* records.save(receipt)
          yield* deps.storage.remove(key(sessionID)).pipe(Effect.orDie)
          yield* records.save({ ...receipt, phase: "cleared" })
          const wait = owned ? yield* runs.requestCancel(sessionID, dispatch.worker!) : Effect.succeed(false)
          return wait.pipe(
            Effect.flatMap((interrupted) =>
              Effect.gen(function* () {
                const source = dispatch?.phase !== "queued" ? dispatch?.messageID : undefined
                const inputs = [...new Set([...(state.inputs ?? []), ...(source ? [source] : [])])]
                const stopped = workers ? yield* workers.stop(sessionID, inputs) : false
                const observation = background
                  ? yield* inputs.length
                      ? settle(sessionID, inputs, deps.sessions, background, (operation) =>
                          amend((receipt) => ({
                            ...receipt,
                            operations: [
                              ...(receipt.operations ?? []).filter((item) => item.id !== operation.id),
                              operation,
                            ],
                          })).pipe(Effect.asVoid),
                        )
                      : outstanding(sessionID, background)
                  : undefined
                return yield* amend((receipt) => ({
                  ...receipt,
                  phase: "finished",
                  interrupted: interrupted || stopped,
                  finishedAt: Date.now(),
                  ...(observation ? { background: observation } : {}),
                }))
              }),
            ),
          )
        }),
      ).pipe(
        // Commit the publisher before an interrupted caller can leave the input gate.
        Effect.flatMap((wait) =>
          wait.pipe(
            Effect.tapCause((cause) =>
              Effect.sync(() =>
                log.warn("Goal stop result could not be recorded.", { sessionID, cause: String(cause) }),
              ),
            ),
            Effect.forkDetach,
          ),
        ),
        Effect.uninterruptible,
        gate.withLock(sessionID),
      )
      const fiber = yield* work
      return yield* Fiber.join(fiber)
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

    // raya_change - the real, eligible completion-evidence callIDs, listed so a rejected audit
    // (missing or mis-cited evidence) can be corrected in a single retry instead of many guesses.
    const eligibleMenu = (messages: SessionV1.WithParts[], createdAt: number) =>
      tools(messages)
        .filter((part) => part.state.status === "completed" && started(part) >= createdAt && supports(part))
        .map((part) => `${part.callID} (${part.tool}; messageID=${part.messageID}; partID=${part.id})`)
        .slice(0, 20)
        .join(", ") || "none yet — perform and verify concrete work before completing"

    const evidence = Effect.fn("RayaGoal.evidence")(function* (sessionID: SessionID) {
      const state = yield* requireGoal(sessionID)
      const messages = yield* collect(deps.sessions, sessionID, state.createdAt, state.inputs)
      return tools(messages)
        .filter(
          (part) => part.state.status === "completed" && part.state.time.start >= state.createdAt && supports(part),
        )
        .map((part) => ({
          messageID: part.messageID,
          partID: part.id,
          sessionID: part.sessionID,
          callID: part.callID,
          tool: part.tool,
          title: part.state.status === "completed" ? part.state.title : "",
          output: part.state.status === "completed" ? part.state.output.slice(0, 500) : "",
          exit: part.state.status === "completed" ? part.state.metadata["exit"] : undefined,
          artifact: part.state.status === "completed" ? part.state.metadata["rayaRevision"] : undefined,
          inspection:
            part.state.status === "completed" && part.tool === "read" ? inspection(part.state.metadata) : undefined,
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

    const update = Effect.fn("RayaGoal.update")(function* (
      sessionID: SessionID,
      input: ModelUpdate,
      expected?: string,
    ) {
      const state = yield* requireGoal(sessionID)
      if (expected !== undefined && state.revision !== expected)
        return yield* new AuditError({
          message: "This goal changed since the operation started. Its result was not applied.",
        })
      const now = Date.now()
      if (input.status === "active") {
        if (state.status !== "blocked" && state.status !== "paused") {
          return yield* new AuditError({ message: `Only a blocked or paused goal can be marked active.` })
        }
        return yield* save(sessionID, {
          ...state,
          status: "active",
          review: undefined,
          intent: crypto.randomUUID(),
          usage: { ...state.usage, retries: 0 },
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
          yield* repair(sessionID)
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
          intent: crypto.randomUUID(),
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
      return yield* complete(sessionID, state, input)
    })

    const complete = Effect.fn("RayaGoal.complete")(function* (
      sessionID: SessionID,
      state: State,
      input: ModelUpdate,
      accepted = false,
    ) {
      const now = Date.now()
      if (state.status !== "active" && state.status !== "blocked" && !(accepted && state.status === "paused")) {
        return yield* new AuditError({ message: `Only an active or blocked goal can be marked complete.` })
      }
      const messages = yield* collect(deps.sessions, sessionID, state.createdAt, state.inputs)
      // raya_change start - accept the flattened audit (top-level `requirements`) that models emit
      // far more often than the nested `audit` object, and make the rejection actionable so a model
      // that still gets it wrong can copy the exact shape and the real evidence IDs in one retry.
      const auditInput =
        input.audit ??
        (input.requirements && input.requirements.length > 0
          ? { requirements: input.requirements, summary: input.summary }
          : undefined)
      if (!auditInput) {
        return yield* new AuditError({
          message:
            `Completion requires a requirement-by-requirement audit. Call update_goal with ` +
            `{ "status": "complete", "audit": { "summary": "<one line>", "requirements": [ { "requirement": ` +
            `"<what was done>", "passed": true, "evidence": [ { "callID": "<a completed work/verification call>", ` +
            `"summary": "<what it proved>" } ] } ] } }. Eligible evidence callIDs: ${eligibleMenu(messages, state.createdAt)}.`,
        })
      }
      const submitted = {
        ...auditInput,
        requirements: auditInput.requirements.map((requirement) => ({
          ...requirement,
          evidence: requirement.evidence.map((item) => ({
            callID: item.callID,
            summary: item.summary,
            messageID: item.messageID,
            partID: item.partID,
            sessionID: item.sessionID,
          })),
        })),
        summary: auditInput.summary ?? input.summary ?? auditInput.requirements[0]?.requirement ?? "",
      }
      // raya_change end
      // raya_change start - persist the attempt whether it passes or fails, so a goal that
      // stays blocked/active after a rejected completion still carries the requirement-by-
      // requirement detail and rejection reason for the audit-log view.
      const audit = yield* validateForSession(
        submitted,
        messages,
        state.createdAt,
        state.objective,
        state.criteria,
      ).pipe(
        Effect.flatMap((audit) => {
          if (!accepted) return Effect.succeed(audit)
          const prior = state.audit?.requirements.flatMap((item) => item.evidence) ?? []
          const changed = audit.requirements
            .flatMap((item) => item.evidence)
            .some((item) => {
              const saved = prior.find(
                (entry) =>
                  entry.callID === item.callID &&
                  entry.partID === item.partID &&
                  entry.messageID === item.messageID &&
                  entry.sessionID === item.sessionID,
              )
              return !saved?.record || saved.record.digest !== item.record?.digest
            })
          return changed
            ? Effect.fail(
                new AuditError({
                  message:
                    "Evidence changed since review was requested. Resume the goal to prepare fresh evidence before accepting it.",
                }),
              )
            : Effect.succeed(audit)
        }),
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
      const criteria =
        state.criteria
          ?.filter((item) => item.review && audit.requirements.some((req) => req.criterionID === item.id && req.passed))
          .map((item) => item.id) ?? []
      const pending = criteria.length > 0 && !accepted
      const review = pending
        ? { status: "pending" as const, at: now, criteria }
        : accepted
          ? { ...state.review!, status: "accepted" as const, acceptedAt: now }
          : undefined
      const next = yield* save(
        sessionID,
        {
          ...state,
          status: pending ? "paused" : "complete",
          intent: pending || accepted ? crypto.randomUUID() : state.intent,
          review,
          audit,
          auditAttempt: { at: now, accepted: true, requirements: audit.requirements },
          updatedAt: now,
          activeMs: elapsed(state, now),
          activeAt: undefined,
          progress: progress(state, {
            at: now,
            kind: "status",
            message: pending
              ? "Evidence is ready for your review. Goal completion awaits your acceptance."
              : accepted
                ? "Reviewed goal accepted."
                : "Completion audit passed.",
          }),
        },
        state,
        !pending && state.selfHealID
          ? (completed) => {
              const id = state.selfHealID
              const attempt = state.selfHealAttempt
              const r = state.revision
              const i = state.intent
              if (completed === undefined || !id || !attempt || !i || !r) {
                return Effect.fail(
                  new AuditError({
                    message: "Legacy self-heal linkage requires reconciliation before tested completion.",
                  }),
                )
              }
              return ownership(sessionID, id, attempt).pipe(
                Effect.flatMap((owned) =>
                  Effect.gen(function* () {
                    const assessment = yield* source
                      .certify(owned, sourceIdentity(state), audit.requirements, tools(messages))
                      .pipe(Effect.catchCause((cause) => Effect.fail(new AuditError({ message: Cause.pretty(cause) }))))
                    return yield* healing.complete(
                      id,
                      sessionID,
                      attempt,
                      {
                        intent: i,
                        revision: r,
                        completedRevision: completed.revision,
                        createdAt: state.createdAt,
                        objective: state.objective,
                        audit,
                        review,
                      },
                      assessment,
                    )
                  }),
                ),
                Effect.map((receipt) => receipt.goal.completedRevision),
                Effect.mapError((err) => new AuditError({ message: err.message })),
              )
            }
          : undefined,
      )
      // Receipt publication happens under the same goal mutation lock after its revision check.
      // A failed goal write leaves the immutable tested evidence readable without claiming save acknowledgement.
      return next
    })

    const validateForSession = Effect.fn("RayaGoal.validateAuditForSession")(function* (
      audit: NonNullable<ModelUpdate["audit"]>,
      messages: SessionV1.WithParts[],
      createdAt: number,
      objective: string,
      criteria?: Criteria,
    ) {
      if (audit.requirements.length === 0) {
        return yield* new AuditError({ message: "Completion requires at least one concrete requirement." })
      }
      if (criteria) {
        const ids = new Set(criteria.map((item) => item.id))
        for (const requirement of audit.requirements) {
          if (requirement.criterionID !== undefined && !ids.has(requirement.criterionID))
            return yield* new AuditError({
              message: `Unknown criterion ID: ${requirement.criterionID}. Read get_goal for the saved requirements.`,
            })
        }
        for (const criterion of criteria) {
          const matches = audit.requirements.filter((item) => item.criterionID === criterion.id)
          if (matches.length !== 1)
            return yield* new AuditError({
              message: `Include exactly one audited requirement with criterionID "${criterion.id}": ${criterion.description}. Verification: ${criterion.verification}`,
            })
          if (clean(matches[0].requirement) !== clean(criterion.description))
            return yield* new AuditError({
              message: `Preserve the saved requirement for criterionID "${criterion.id}": ${criterion.description}`,
            })
        }
      }
      const parts = tools(messages)
      // raya_change - list the real, eligible evidence callIDs in every rejection. Providers that
      // expose tool calls as text markup emit unstable/colliding callIDs (e.g. dsml-0), so the model
      // otherwise cites the wrong one and exhausts its step budget guessing.
      const menu = eligibleMenu(messages, createdAt)
      const needsSmoke = (value: string) =>
        /smoke(?:\s|-)*test.{0,40}(?:pass|green)|(?:pass|green).{0,40}smoke(?:\s|-)*test/i.test(value)
      const verified: Requirement[] = []
      for (const requirement of audit.requirements) {
        if (!clean(requirement.requirement)) {
          return yield* new AuditError({ message: "Every audited requirement needs a concrete description." })
        }
        if (!requirement.passed) {
          const criterion = criteria?.find((item) => item.id === requirement.criterionID)
          if (criterion?.required === false) {
            if (requirement.evidence.length)
              return yield* new AuditError({
                message: `Unverified optional criteria must not include evidence claims: ${requirement.requirement}`,
              })
            verified.push({ ...requirement, evidence: [] })
            continue
          }
          return yield* new AuditError({ message: `Requirement is not satisfied: ${requirement.requirement}` })
        }
        if (requirement.evidence.length === 0) {
          return yield* new AuditError({ message: `Requirement has no real evidence: ${requirement.requirement}` })
        }
        const cited: SessionV1.ToolPart[] = []
        const proof: Evidence[] = []
        for (const evidence of requirement.evidence) {
          const matches = parts.filter(
            (item) =>
              item.callID === evidence.callID &&
              (evidence.messageID === undefined || item.messageID === evidence.messageID) &&
              (evidence.partID === undefined || item.id === evidence.partID) &&
              (evidence.sessionID === undefined || item.sessionID === evidence.sessionID),
          )
          const ref = evidence.messageID ? `${evidence.messageID}/${evidence.callID}` : evidence.callID
          if (matches.length > 1)
            return yield* new AuditError({
              message: `Evidence ${ref} is ambiguous. Include the messageID and partID from get_goal for the intended result. Eligible evidence: ${menu}.`,
            })
          const part = matches[0]
          if (part?.tool === "task")
            return yield* new AuditError({
              message: `Delegation result ${ref} reports child activity, not verified completion. Cite the child's actual work or verification results from get_goal. Eligible evidence: ${menu}.`,
            })
          if (!part || part.state.status !== "completed" || part.state.time.start < createdAt || !supports(part)) {
            return yield* new AuditError({
              // raya_change - name the real eligible callIDs so the model retries correctly once
              message: `Evidence ${ref} is not a completed post-goal work or verification tool call. Eligible evidence callIDs: ${menu}.`,
            })
          }
          cited.push(part)
          if (part.tool === "self_heal_verify")
            yield* source
              .inspect(part)
              .pipe(Effect.catchCause((cause) => Effect.fail(new AuditError({ message: Cause.pretty(cause) }))))
          if (
            (part.tool === "write" || part.tool === "edit" || part.tool === "apply_patch" || part.tool === "read") &&
            "rayaRevision" in part.state.metadata &&
            !(yield* Artifact.current(part.state.metadata["rayaRevision"]))
          )
            return yield* new AuditError({
              message: `Artifact evidence ${ref} is stale or its current revision could not be verified. Inspect and verify the current file, then cite that fresh result.`,
            })
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
          proof.push({
            ...evidence,
            messageID: part.messageID,
            partID: part.id,
            sessionID: part.sessionID,
            record: { version: 1, digest: digest(part), at: Date.now() },
          })
        }
        // raya_change start - Milestone G smoke-gated goals require genuine host smoke evidence
        if (
          (needsSmoke(objective) ||
            needsSmoke(requirement.requirement) ||
            needsSmoke(criteria?.find((item) => item.id === requirement.criterionID)?.verification ?? "")) &&
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
        const check = criteria?.find((item) => item.id === requirement.criterionID)?.check
        if (
          check &&
          !cited.some((part) => {
            if (part.tool !== "bash" || part.state.status !== "completed" || part.state.metadata["exit"] !== 0)
              return false
            const command = part.state.input["command"]
            const directory = part.state.input["workdir"]
            if (typeof command !== "string" || typeof directory !== "string" || !path.isAbsolute(directory))
              return false
            const normalize = (value: string) =>
              process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)
              return command === check.command && normalize(directory) === normalize(check.directory)
          })
        )
          return yield* new AuditError({
            message: `Criterion ${requirement.criterionID} requires successful evidence for the saved command in its explicit working directory. Run ${check.command} with workdir ${check.directory}, then cite that result.`,
          })
        verified.push({ ...requirement, evidence: proof })
      }
      if (!verified.some((item) => item.passed))
        return yield* new AuditError({
          message: "Completion requires at least one requirement supported by verified work.",
        })
      const summary = clean(audit.summary ?? "")
      if (!summary) return yield* new AuditError({ message: "Completion requires an audit summary." })
      return { requirements: verified, summary, verifiedAt: Date.now() } satisfies Audit
    })

    const recordTurn = Effect.fn("RayaGoal.recordTurn")(function* (
      sessionID: SessionID,
      messageID?: MessageID,
      intent?: string,
    ) {
      const state = yield* get(sessionID)
      if (!state) return
      if (intent !== undefined && (state.intent !== intent || state.status !== "active")) return
      const messages = yield* deps.sessions.messages({ sessionID })
      const users = messages.filter((message) => message.info.role === "user")
      const user = users.toSorted((a, b) => a.info.time.created - b.info.time.created).at(-1)
      if (!user) return
      const candidates = messages.filter(
        (message) => message.info.role === "assistant" && message.info.parentID === user.info.id,
      )
      const latest = candidates.toSorted((a, b) => a.info.id.localeCompare(b.info.id)).at(-1)
      if (!latest || (messageID !== undefined && latest.info.id !== messageID)) return
      const recorded = state.accounted?.userID === user.info.id ? state.accounted.messages : []
      if (recorded.includes(latest.info.id)) return
      const assistants = candidates.filter((message) => !recorded.includes(message.info.id))
      const parts = assistants.flatMap((message) => message.parts)
      const calls = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool" && !controls.has(part.tool))
      if (
        parts.some(
          (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
        )
      ) {
        return { state, productive: false, retry: false }
      }
      const abort = assistants.some((message) => {
        if (message.info.role !== "assistant") return false
        const err = message.info.error
        if (!err) return false
        const name = "name" in err ? String(err.name) : ""
        const body = JSON.stringify(err)
        return name === "AbortError" || /aborted/i.test(body)
      })
      if (abort && state.status === "active") {
        return { state, productive: false, retry: false }
      }
      const reply = parts
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      const claimed =
        /\b(?:task|goal|objective|work)\s+(?:is|was|has been)\s+(?:now\s+)?(?:complete|completed|done|satisfied)\b|\bnothing further\b|\bno further (?:work|action)\b|\bobjective is satisfied\b/i.test(
          reply,
        )
      const invalid = state.status === "active" && claimed
      const current = new Set(calls)
      const prior = tools(messages).filter((part) => !current.has(part) && started(part) >= state.createdAt)
      const repeated =
        calls.length > 0 && calls.every((call) => prior.some((part) => fingerprint(part) === fingerprint(call)))
      const succeeded = calls.filter(
        (part) => part.state.status === "completed" && (part.tool !== "bash" || part.state.metadata.exit === 0),
      )
      const idle = state.status === "active" && calls.length === 0
      const failed = state.status === "active" && calls.length > 0 && succeeded.length === 0
      const retries = idle || failed ? (state.usage.retries ?? 0) + 1 : 0
      const stalled = (idle || failed) && retries >= idleLimit
      const now = Date.now()
      const reason = invalid
        ? "The model reported completion without successfully calling update_goal. Review the result, then steer or stop it."
        : repeated
          ? "Automatic continuation repeated the same tool work without new evidence."
          : failed
            ? `Automatic continuation stopped after ${idleLimit} turns without a successful tool result. Review the failures and choose a different approach.`
            : "The turn ended without work, verification, or a goal status update. Steer the goal or stop it."
      const stopped = invalid || repeated || stalled
      const retry = !stopped && state.status === "active" && (idle || failed)
      const next = yield* save(sessionID, {
        ...state,
        accounted: { userID: user.info.id, messages: [...recorded, ...assistants.map((message) => message.info.id)] },
        status: stopped ? "blocked" : state.status,
        blockedReason: stopped ? reason : state.blockedReason,
        updatedAt: now,
        activeMs: stopped ? elapsed(state, now) : state.activeMs,
        activeAt: stopped ? undefined : state.activeAt,
        usage: {
          ...state.usage,
          turns: state.usage.turns + 1,
          toolCalls: state.usage.toolCalls + calls.length,
          retries: stopped ? retries : retry ? retries : 0,
        },
        progress: progress(state, {
          at: now,
          kind: stopped ? "status" : "turn",
          message: stopped
            ? `Blocked: ${reason}`
            : failed
              ? `No successful tool result; recovery ${retries}/${idleLimit}. Review the failure before retrying work.`
              : calls.length > 0
                ? `Turn finished with ${calls.length} work or verification tool call${calls.length === 1 ? "" : "s"}.`
                : retry
                  ? `Idle turn ${retries}/${idleLimit}; continuing the goal.`
                  : "Automatic continuation suppressed because the turn made no work or verification tool calls.",
        }),
      })
      return { state: next, productive: succeeded.length > 0 && !stopped, retry }
    })

    const finished = Effect.fn("RayaGoal.finished")(function* (
      sessionID: SessionID,
      messageID: MessageID,
      outcome: "completed" | "error" | "interrupted" = "completed",
      recheck = false,
    ) {
      const state = yield* get(sessionID)
      const dispatch = state?.dispatch
      if (!state || !dispatch?.messageID || dispatch.phase !== (recheck ? "finished" : "started")) return undefined
      if (recheck && (dispatch.assistantID !== messageID || (dispatch.outcome ?? "completed") !== outcome))
        return undefined
      const messages = yield* deps.sessions.messages({ sessionID })
      if (!messages.some((row) => row.info.role === "user" && row.info.id === dispatch.messageID)) return undefined
      if (
        recheck &&
        messages.some(
          (row) =>
            row.info.role === "user" &&
            row.info.id !== dispatch.messageID &&
            (row.info.id > dispatch.messageID! || row.info.time.created > dispatch.queuedAt),
        )
      )
        return undefined
      const replies = messages.filter(
        (row) => row.info.role === "assistant" && row.info.parentID === dispatch.messageID,
      )
      const latest = replies.toSorted((a, b) => a.info.id.localeCompare(b.info.id)).at(-1)
      if (!latest || latest.info.role !== "assistant" || latest.info.id !== messageID) return undefined
      if (outcome === "completed" && latest.info.error) return undefined
      if (outcome === "error" && !latest.info.error) return undefined
      const at = latest.info.time.completed
      if (at === undefined || !Number.isFinite(at) || at < (dispatch.startedAt ?? dispatch.queuedAt)) return undefined
      if (recheck && dispatch.finishedAt !== at) return undefined
      if (
        replies.some((row) =>
          row.parts.some(
            (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
          ),
        )
      )
        return undefined
      // Recovery validation is read-only; duplicate live acknowledgements remain inert.
      if (recheck) return state
      return yield* save(sessionID, {
        ...state,
        dispatch: { ...dispatch, phase: "finished", finishedAt: at, assistantID: messageID, outcome },
      })
    })

    const initial = Effect.fn("RayaGoal.initial")(function* (sessionID: SessionID, intent: string, worker: string) {
      const state = yield* get(sessionID)
      if (
        !state ||
        state.status !== "active" ||
        state.dispatch ||
        !state.startMessageID ||
        (state.intent ?? "unset") !== intent ||
        !worker.trim()
      )
        return
      const rows = yield* deps.sessions.messages({ sessionID })
      const anchor = rows.find((row) => row.info.id === state.startMessageID)
      if (!anchor) return
      if (anchor.info.role === "assistant" && anchor.info.time.completed !== undefined) return
      const messageID = anchor.info.role === "user" ? anchor.info.id : anchor.info.parentID
      const users = rows.filter((row) => row.info.role === "user")
      const user = users.toSorted((a, b) => a.info.id.localeCompare(b.info.id)).at(-1)
      if (!user || user.info.id !== messageID) return
      if (users.some((row) => row.info.id !== messageID && row.info.time.created > user.info.time.created)) return
      const now = Date.now()
      return yield* save(sessionID, {
        ...state,
        inputs: [...new Set([...(state.inputs ?? []), messageID])],
        dispatch: {
          id: crypto.randomUUID(),
          messageID,
          intent,
          phase: "started",
          queuedAt: user.info.time.created,
          startedAt: now,
          worker,
        },
      })
    })

    const bound = Effect.fn("RayaGoal.bound")(function* (sessionID: SessionID, id: string, worker: string) {
      const state = yield* get(sessionID)
      const dispatch = state?.dispatch
      if (!state || !dispatch?.messageID || dispatch.id !== id || dispatch.phase !== "started" || !worker.trim()) return
      if (dispatch.worker && dispatch.worker !== worker) return
      if (dispatch.worker === worker && state.inputs?.includes(dispatch.messageID)) return state
      const rows = yield* deps.sessions.messages({ sessionID })
      const users = rows.filter((row) => row.info.role === "user")
      const latest = users.toSorted((a, b) => a.info.id.localeCompare(b.info.id)).at(-1)
      if (latest?.info.id !== dispatch.messageID) return
      if (users.some((row) => row.info.id !== dispatch.messageID && row.info.time.created > dispatch.queuedAt)) return
      return yield* save(sessionID, {
        ...state,
        inputs: [...new Set([...(state.inputs ?? []), dispatch.messageID])],
        dispatch: { ...dispatch, worker },
      })
    })

    const dispatched = Effect.fn("RayaGoal.dispatched")(function* (sessionID: SessionID, id: string) {
      const state = yield* get(sessionID)
      if (!state) return
      const dispatch = state.dispatch
      if (
        state.status !== "active" ||
        !dispatch ||
        dispatch.id !== id ||
        dispatch.phase !== "queued" ||
        dispatch.intent !== (state.intent ?? "unset")
      )
        return
      const messageID = dispatch.messageID ?? MessageID.ascending()
      const messages = yield* deps.sessions.messages({ sessionID })
      // A reserved prompt must not overwrite a saved message or precede newer user input.
      if (
        messages.some(
          (row) =>
            row.info.id === messageID ||
            (row.info.role === "user" && (row.info.id > messageID || row.info.time.created > dispatch.queuedAt)),
        )
      )
        return
      return yield* save(sessionID, {
        ...state,
        dispatch: {
          ...dispatch,
          messageID,
          phase: "started",
          startedAt: Date.now(),
        },
      })
    })

    const continued = Effect.fn("RayaGoal.continued")(function* (sessionID: SessionID, intent?: string) {
      const state = yield* requireGoal(sessionID)
      if (intent !== undefined && state.intent !== intent) return
      if (state.status !== "active") {
        return yield* new AuditError({ message: `A ${state.status} goal cannot continue automatically.` })
      }
      if (state.dispatch?.intent === (state.intent ?? "unset")) {
        if (state.dispatch.phase === "queued") return state
        if (state.dispatch.phase === "started") return
      }
      const now = Date.now()
      return yield* save(sessionID, {
        ...state,
        updatedAt: now,
        usage: { ...state.usage, continuations: state.usage.continuations + 1 },
        dispatch: {
          id: crypto.randomUUID(),
          messageID: MessageID.ascending(),
          intent: state.intent ?? "unset",
          phase: "queued",
          queuedAt: now,
        },
        progress: progress(state, {
          at: now,
          kind: "continuation",
          message: `Continuation ${state.usage.continuations + 1} queued.`,
        }),
      })
    })

    const retried = Effect.fn("RayaGoal.retried")(function* (
      sessionID: SessionID,
      detail: string,
      eventID?: string,
      intent?: string,
    ) {
      const state = yield* requireGoal(sessionID)
      if (intent !== undefined && state.intent !== intent) return
      if (eventID !== undefined && state.retryEvents?.includes(eventID)) return
      if (state.status !== "active") {
        return yield* new AuditError({ message: `A ${state.status} goal cannot continue automatically.` })
      }
      const count = (state.usage.retries ?? 0) + 1
      const now = Date.now()
      const stopped = count > retryLimit
      const reason = `Automatic continuation stopped after ${retryLimit} provider errors. Resume the goal or send a message to continue.`
      const next = yield* save(sessionID, {
        ...state,
        retryEvents: eventID === undefined ? state.retryEvents : [...(state.retryEvents ?? []), eventID],
        dispatch: stopped
          ? state.dispatch
          : {
              id: crypto.randomUUID(),
              messageID: MessageID.ascending(),
              intent: state.intent ?? "unset",
              phase: "queued",
              queuedAt: now,
            },
        status: stopped ? "blocked" : state.status,
        blockedReason: stopped ? reason : state.blockedReason,
        activeMs: stopped ? elapsed(state, now) : state.activeMs,
        activeAt: stopped ? undefined : state.activeAt,
        updatedAt: now,
        usage: {
          ...state.usage,
          continuations: state.usage.continuations + (stopped ? 0 : 1),
          retries: stopped ? state.usage.retries : count,
        },
        progress: progress(state, {
          at: now,
          kind: stopped ? "status" : "continuation",
          message: stopped ? `Blocked: ${reason}` : `Retry ${count} after ${detail}.`,
        }),
      })
      if (stopped && state.selfHealID) {
        yield* repair(sessionID)
        yield* healing
          .update(state.selfHealID, { status: "blocked", blockedReason: reason, reloadRequired: false })
          .pipe(Effect.orDie)
      }
      return next
    })

    return {
      get,
      repair,
      create,
      control,
      revise,
      edit,
      plan,
      clear,
      stop,
      stopResult: receipts(deps.storage).latest,
      update,
      evidence,
      recordTurn,
      continued,
      retried,
      dispatched,
      finished,
      bound,
      initial,
    }
  }
}
