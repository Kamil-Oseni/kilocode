import { Schema } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { GoalCriteria as Criteria } from "./criteria"
import * as Planning from "./plan"
import * as Artifact from "./artifact"

export namespace Codec {
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

  export const FileTool = Schema.Literals([
    "write",
    "edit",
    "apply_patch",
    "create_document",
    "create_spreadsheet",
    "create_presentation",
    "create_pdf",
    "generate_image",
  ])
  export type FileTool = typeof FileTool.Type
  export const fileTool = (tool: string): tool is FileTool => Schema.is(FileTool)(tool)

  const FileDeliverable = Schema.Struct({
    kind: Schema.optional(Schema.Literal("file")),
    path: Schema.String,
    revision: Artifact.Entry,
    tool: FileTool,
    evidence: Evidence,
  })
  const CanvasDeliverable = Schema.Struct({
    kind: Schema.Literal("canvas"),
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    tool: Schema.Literals(["create_canvas", "update_canvas"]),
    evidence: Evidence,
  })
  export const DownloadReceipt = Schema.Struct({
    version: Schema.Literal(1),
    transferID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    artifact: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    filename: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  })
  const DownloadDeliverable = Schema.Struct({
    kind: Schema.Literal("browser-download"),
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    transferID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    filename: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
    url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    tool: Schema.Literal("browser_download"),
    evidence: Evidence,
  })
  export const Deliverable = Schema.Union([FileDeliverable, CanvasDeliverable, DownloadDeliverable]).annotate({
    identifier: "RayaGoalDeliverable",
  })
  export type Deliverable = typeof Deliverable.Type

  export const Requirement = Schema.Struct({
    criterionID: Schema.optional(Schema.String).annotate({
      description:
        "Required when the goal has saved criteria: copy the exact id from get_goal.goal.criteria into criterionID and copy its description into requirement. Include every saved criterion exactly once. Omit criterionID only when no saved criteria exist.",
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

  export const Reply = Schema.Struct({
    messageID: MessageID,
    body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
    at: Schema.Number,
  })
  export type Reply = typeof Reply.Type

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

  export const ChargeLimit = Schema.Struct({
    currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3,8}$/)),
    limit: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
    reservation: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
  })
  export type ChargeLimit = typeof ChargeLimit.Type

  export const Budget = Schema.Struct({
    activeMs: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000), Schema.isLessThanOrEqualTo(31_536_000_000)),
    ),
    modelCost: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000))),
    recoveryAttempts: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
    ),
    concurrentChildren: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32)),
    ),
    chargeCosts: Schema.optional(Schema.Array(ChargeLimit).check(Schema.isMinLength(1), Schema.isMaxLength(8))),
  })
  export type Budget = typeof Budget.Type

  export const BudgetOverride = Schema.Struct({
    at: Schema.Number,
    authority: Schema.Literal("user-control"),
    reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
    previous: Schema.optional(Budget),
    next: Schema.optional(Budget),
  })
  export type BudgetOverride = typeof BudgetOverride.Type

  export const BudgetHit = Schema.Struct({
    kind: Schema.Literals(["active-time", "model-cost", "charge-cost", "recovery-attempts"]),
    limit: Schema.Finite,
    observed: Schema.Finite,
    currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3,8}$/))),
    uncertain: Schema.optional(Schema.Boolean),
    at: Schema.Number,
  })
  export type BudgetHit = typeof BudgetHit.Type

  export const Usage = Schema.Struct({
    turns: Schema.Number,
    continuations: Schema.Number,
    toolCalls: Schema.Number,
    retries: Schema.optional(Schema.Number), // consecutive recoveries; reset after success, steering, or resume
    cost: Schema.optional(Schema.Finite), // parent total already includes recursively propagated child cost
    descendantCost: Schema.optional(Schema.Finite), // first-hop child totals already included recursively in cost
    delegatedCost: Schema.optional(Schema.Finite), // organization-worker branches reserved or billed outside the session tree
    tokens: Schema.optional(
      Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
      }),
    ),
    descendantTokens: Schema.optional(
      Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
      }),
    ),
  }).annotate({ identifier: "RayaGoalUsage" })
  export type Usage = typeof Usage.Type

  const chargeFields = {
    id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    kind: Schema.Literals(["tool", "gpt-live", "external"]),
    provider: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
    service: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
    source: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
    origin: Schema.Struct({
      sessionID: SessionID,
      messageID: Schema.optional(MessageID),
      callID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
    }),
    at: Schema.Finite,
    quantity: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
    unit: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
  }
  export const Charge = Schema.Union([
    Schema.Struct({
      ...chargeFields,
      coverage: Schema.Literal("recorded"),
      amount: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
      currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3,8}$/)),
    }),
    Schema.Struct({
      ...chargeFields,
      coverage: Schema.Literal("unknown"),
      currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3,8}$/))),
      reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
    }),
  ]).annotate({ identifier: "RayaGoalCharge" })
  export type Charge = typeof Charge.Type

  export const Revision = Schema.Struct({
    review: Schema.optional(Review),
    id: Schema.String,
    at: Schema.Number,
    source: Schema.Literals(["steering", "control"]),
    intent: Schema.optional(Schema.String),
    objective: Schema.String,
    completion: Schema.optional(Schema.Literal("reply")),
    reply: Schema.optional(Reply),
    criteria: Schema.optional(Criteria),
    plan: Schema.optional(Planning.Plan),
    budget: Schema.optional(Budget),
    budgetOverrides: Schema.optional(Schema.Array(BudgetOverride).check(Schema.isMaxLength(100))),
    budgetHit: Schema.optional(BudgetHit),
    usage: Schema.optional(Usage),
    charges: Schema.optional(Schema.Array(Charge).check(Schema.isMaxLength(512))),
    deliverables: Schema.optional(Schema.Array(Deliverable)),
    audit: Schema.optional(Audit),
    auditAttempt: Schema.optional(AuditAttempt),
  })

  export const Progress = Schema.Struct({
    at: Schema.Number,
    kind: Schema.Literals(["status", "turn", "continuation"]),
    message: Schema.String,
  })
  export type Progress = typeof Progress.Type

  export const ReplyRecovery = Schema.Struct({
    version: Schema.Literal(1),
    dispatchID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    messageID: MessageID,
    oldIntent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    intent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    outcome: Schema.Literals(["error", "interrupted", "unknown"]),
    execution: Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64), Schema.isPattern(/^[a-f0-9]{64}$/)),
    at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    reviewedAt: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
    reviewIntent: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  }).check(
    Schema.makeFilter((value) =>
      (value.reviewedAt === undefined) === (value.reviewIntent === undefined)
        ? undefined
        : "Reply recovery acknowledgement is incomplete.",
    ),
  )

  // Completed goals stay visible in the session carousel after a new one is armed.
  export const HistoryItem = Schema.Struct({
    replyRecovery: Schema.optional(ReplyRecovery),
    replyRecoveries: Schema.optional(Schema.Array(ReplyRecovery).check(Schema.isMaxLength(20))),
    review: Schema.optional(Review),
    revisions: Schema.optional(Schema.Array(Revision)),
    plan: Schema.optional(Planning.Plan),
    budget: Schema.optional(Budget),
    budgetOverrides: Schema.optional(Schema.Array(BudgetOverride).check(Schema.isMaxLength(100))),
    budgetHit: Schema.optional(BudgetHit),
    usage: Schema.optional(Usage),
    charges: Schema.optional(Schema.Array(Charge).check(Schema.isMaxLength(512))),
    activeMs: Schema.optional(Schema.Number),
    objective: Schema.String,
    completion: Schema.optional(Schema.Literal("reply")),
    reply: Schema.optional(Reply),
    criteria: Schema.optional(Criteria),
    status: Status,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    blockedReason: Schema.optional(Schema.String),
    deliverables: Schema.optional(Schema.Array(Deliverable)),
    audit: Schema.optional(Audit),
    auditAttempt: Schema.optional(AuditAttempt),
  })
  export type HistoryItem = typeof HistoryItem.Type

  export const State = Schema.Struct({
    replyRecovery: Schema.optional(ReplyRecovery),
    replyRecoveries: Schema.optional(Schema.Array(ReplyRecovery).check(Schema.isMaxLength(20))),
    review: Schema.optional(Review),
    revisions: Schema.optional(Schema.Array(Revision)),
    plan: Schema.optional(Planning.Plan),
    objective: Schema.String,
    completion: Schema.optional(Schema.Literal("reply")),
    reply: Schema.optional(Reply),
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
        attention: Schema.optional(
          Schema.Struct({
            batchID: Schema.String,
            goalCreatedAt: Schema.Number,
            requestID: Schema.String,
            revision: Schema.String,
            ids: Schema.Array(Schema.String),
          }),
        ),
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
    charges: Schema.optional(Schema.Array(Charge).check(Schema.isMaxLength(512))),
    budget: Schema.optional(Budget),
    budgetOverrides: Schema.optional(Schema.Array(BudgetOverride).check(Schema.isMaxLength(100))),
    budgetHit: Schema.optional(BudgetHit),
    blockedReason: Schema.optional(Schema.String),
    deliverables: Schema.optional(Schema.Array(Deliverable)),
    audit: Schema.optional(Audit),
    auditAttempt: Schema.optional(AuditAttempt), // raya_change - last completion attempt for the audit-log view
    progress: Schema.Array(Progress),
    history: Schema.optional(Schema.Array(HistoryItem)),
  })
  export type State = typeof State.Type
}
