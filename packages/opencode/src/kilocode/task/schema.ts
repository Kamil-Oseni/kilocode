import { Schema } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Criteria } from "@/kilocode/goal/criteria"
import { Trigger as TriggerSchema } from "./trigger"
import path from "node:path"
import { Reference } from "./job-contract"

export namespace Codec {
  export const Stop = Schema.Struct({
    version: Schema.Literal(1),
    intent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  })
  export const Role = Schema.Literals(["generalist", "coder", "designer", "accountant", "reviewer", "inbox", "briefer"])
  export type Role = typeof Role.Type

  export const Schedule = Schema.Union([
    Schema.Struct({ kind: Schema.Literal("once"), at: Schema.Number }),
    Schema.Struct({ kind: Schema.Literal("cron"), expr: Schema.String, tz: Schema.optional(Schema.String) }),
    Schema.Struct({
      kind: Schema.Literal("event"),
      source: Schema.String,
      filter: Schema.optional(Schema.String),
    }),
    Schema.Struct({ kind: Schema.Literal("manual") }),
  ])
  export type Schedule = typeof Schedule.Type

  export const Proposal = Schema.Union([
    Schedule,
    Schema.Struct({
      kind: Schema.Literal("local"),
      local: Schema.String,
      tz: Schema.String,
      fold: Schema.optional(Schema.Literals(["reject", "earlier", "later"])),
    }),
  ])
  export type Proposal = typeof Proposal.Type

  export const Forecast = Schema.Struct({
    schedule: Schedule,
    from: Schema.Number,
    occurrences: Schema.Array(Schema.Number),
    timezone: Schema.optional(Schema.String),
  })

  export const Version = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  )

  const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))
  export const Final = Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4096),
      Schema.makeFilter((value) =>
        path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)
          ? undefined
          : "Final output requires an absolute file path without control characters.",
      ),
    ),
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8192)),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  })
  export const Output = Schema.Struct({
    destination: Schema.Literal("conversation"),
    description: Text,
    criteria: Criteria,
    final: Schema.optional(Final),
  })
  export type Output = typeof Output.Type

  export const Timestamp = Schema.Number.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
  export const Provisioning = Schema.Struct({
    enabled: Schema.Boolean,
    source: Schema.Literals(["user", "chat", "worker"]),
    actorID: Schema.optional(Schema.String),
    changedAt: Timestamp,
  })
  export const Authority = Schema.Struct({ enabled: Schema.Boolean, expected: Schema.Boolean })
  export const PathGrant = Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    access: Schema.Literals(["read", "write"]),
  })
  export type PathGrant = typeof PathGrant.Type
  export const PathAccess = Schema.Struct({
    version: Schema.Literal(1),
    grants: Schema.Array(PathGrant).check(Schema.isMaxLength(16)),
  })
  export type PathAccess = typeof PathAccess.Type
  export const RunBudget = Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(1_000_000),
  )

  export const Agent = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    avatar: Schema.optional(Schema.String),
    role: Schema.String,
    objective: Schema.String,
    output: Schema.optional(Output),
    sourceSessionID: Schema.optional(SessionID),
    reportSessionID: Schema.optional(SessionID),
    overlap: Schema.optional(Schema.Literals(["skip", "queue"])),
    missed: Schema.optional(Schema.Literals(["skip", "latest"])),
    capabilities: Schema.Array(Schema.String),
    provisioning: Schema.optional(Provisioning),
    memoryScope: Schema.Literals(["role", "project", "session"]),
    schedule: Schedule,
    scheduleVersion: Schema.optional(Version),
    scheduleUpdatedAt: Schema.optional(Schema.Finite),
    budget: Schema.optional(RunBudget),
    enabled: Schema.Boolean,
    blockReset: Schema.optional(Schema.Array(Schema.String)),
    plan: Schema.optional(Schema.String),
    model: Schema.optional(Schema.Struct({ providerID: Schema.String, id: Schema.String })),
    mode: Schema.optional(Schema.String),
    dir: Schema.optional(Schema.String),
    paths: Schema.optional(PathAccess),
    access: Schema.optional(Schema.Literals(["full", "brief"])),
    tools: Schema.optional(Schema.Array(Schema.String)),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    note: Schema.optional(Schema.String),
    nextRun: Schema.optional(Schema.Number),
    execution: Schema.optional(
      Schema.Struct({
        state: Schema.Literals(["starting", "active", "recovery"]),
        runID: Schema.optional(Schema.String),
        sessionID: Schema.optional(SessionID),
        recovery: Schema.optional(Schema.Literal("followup")),
      }),
    ),
  })
  export type Agent = typeof Agent.Type

  export const Archived = Schema.Struct({
    version: Schema.Literal(1),
    archivedAt: Schema.Finite,
    definition: Agent,
  })
  export const ArchivePage = Schema.Struct({ items: Schema.Array(Archived), next: Schema.optional(Schema.String) })

  export const Outcome = Schema.Struct({
    kind: Schema.Literals(["code", "notify"]),
    reply: Schema.optional(Schema.Literal(true)),
    summary: Schema.String,
    report: Schema.optional(
      Schema.Struct({
        version: Schema.Literal(1),
        sessionID: SessionID,
        messageID: MessageID,
        parentID: MessageID,
        at: Schema.Finite,
        partIDs: Schema.Array(PartID),
        dispatchID: Schema.String.check(Schema.isMinLength(1)),
        goalCreatedAt: Schema.Finite,
        goalIntent: Schema.String.check(Schema.isMinLength(1)),
        acceptedIntent: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
        sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
      }),
    ),
    evidence: Schema.optional(Schema.Array(Schema.String)),
    delivery: Schema.optional(
      Schema.Struct({
        version: Schema.Literal(1),
        status: Schema.Literals(["passed", "mismatch", "unavailable"]),
        reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        at: Schema.Finite,
        contract: Final,
        source: Schema.optional(
          Schema.Struct({
            messageID: MessageID,
            partID: PartID,
            callID: Schema.String,
            path: Schema.String,
            canonical: Schema.String,
            bytes: Schema.Int,
            sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          }),
        ),
        final: Schema.Struct({
          messageID: MessageID,
          sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      }),
    ),
    verification: Schema.optional(
      Schema.Struct({
        at: Schema.Number,
        requirements: Schema.Array(
          Schema.Struct({
            criterionID: Schema.optional(Schema.String),
            requirement: Schema.String,
            verification: Schema.optional(Schema.String),
            required: Schema.Boolean,
            passed: Schema.Boolean,
            basis: Schema.optional(Schema.Literals(["model-audit", "command", "byte-equality", "file-content"])),
            evidence: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    cost: Schema.Number,
  })
  export type Outcome = typeof Outcome.Type

  export const Trigger = TriggerSchema
  export type Trigger = typeof Trigger.Type

  export const Trace = Schema.Struct({
    version: Schema.Literal(1),
    goalCreatedAt: Schema.Finite,
    turns: Schema.Array(
      Schema.Struct({
        turnID: MessageID,
        messages: Schema.Array(
          Schema.Struct({
            messageID: MessageID,
            actions: Schema.Array(
              Schema.Struct({
                actionID: PartID,
                status: Schema.Literals(["pending", "running", "completed", "error"]),
              }),
            ).check(Schema.isMaxLength(256)),
          }),
        ).check(Schema.isMaxLength(128)),
      }),
    ).check(Schema.isMaxLength(128)),
  }).check(
    Schema.makeFilter((value) => {
      const turns = new Set<string>()
      const messages = new Set<string>()
      const actions = new Set<string>()
      for (const turn of value.turns) {
        if (turns.has(turn.turnID)) return "Duplicate Routine turn identity."
        turns.add(turn.turnID)
        for (const message of turn.messages) {
          if (messages.has(message.messageID)) return "Duplicate Routine message identity."
          messages.add(message.messageID)
          for (const action of message.actions) {
            if (actions.has(action.actionID)) return "Duplicate Routine action identity."
            actions.add(action.actionID)
          }
        }
      }
      return messages.size > 128 || actions.size > 256 || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024
        ? "Routine identity snapshot exceeds its bounds."
        : undefined
    }),
  )
  export type Trace = typeof Trace.Type

  export const Run = Schema.Struct({
    id: Schema.String,
    agentID: Schema.String,
    contract: Schema.optional(Reference),
    at: Schema.Number,
    sessionID: SessionID,
    status: Schema.Literals(["running", "complete", "blocked", "error", "stopped"]),
    stop: Schema.optional(Stop),
    scheduleVersion: Schema.optional(Version),
    trigger: Schema.optional(Trigger),
    goalCreatedAt: Schema.optional(Schema.Finite),
    trace: Schema.optional(Trace),
    revision: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    ),
    outcome: Schema.optional(Outcome),
    blockedReason: Schema.optional(Schema.String),
  }).check(
    Schema.makeFilter((value) =>
      (value.status === "stopped") !== (value.stop !== undefined)
        ? "Stopped runs require their original Stop provenance."
        : undefined,
    ),
    Schema.makeFilter((value) =>
      value.trace && value.trace.goalCreatedAt !== value.goalCreatedAt
        ? "Routine identity snapshot belongs to a different goal."
        : undefined,
    ),
    Schema.makeFilter((value) =>
      value.outcome?.report &&
      ((value.status !== "complete" &&
        !(value.status === "blocked" && value.outcome.delivery?.status !== "passed" && value.outcome.delivery)) ||
        value.outcome.report.sessionID !== value.sessionID ||
        value.outcome.report.goalCreatedAt !== value.goalCreatedAt)
        ? "Routine final report belongs to a different completed run."
        : undefined,
    ),
    Schema.makeFilter((value) => {
      const delivery = value.outcome?.delivery
      if (
        value.outcome?.report?.partIDs.length === 0 &&
        !(
          value.status === "blocked" &&
          delivery?.status === "unavailable" &&
          delivery.reason === "final-missing" &&
          delivery.final.bytes === 0 &&
          value.outcome.summary === ""
        )
      )
        return "A missing final answer requires its explicit unavailable delivery record."
      if (!delivery) return undefined
      const report = value.outcome?.report
      if (
        !report ||
        report.messageID !== delivery.final.messageID ||
        report.sha256 !== delivery.final.sha256 ||
        (delivery.status === "passed" ? value.status !== "complete" || !delivery.source : value.status !== "blocked")
      )
        return "Routine final delivery does not match its original report and result."
      return undefined
    }),
  )
  export type Run = typeof Run.Type

  // The run and its public event are published in one atomic storage replacement.
  // Event payloads are an allowlist: outcomes, prompts, and tool data stay in Run only.
  export const Event = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    stream: Schema.String,
    sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    kind: Schema.Literal("run.changed"),
    visibility: Schema.Literal("workspace"),
    runID: Schema.String,
    agentID: Schema.String,
    sessionID: SessionID,
    stateRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    status: Schema.Literals(["running", "complete", "blocked", "error", "stopped"]),
    at: Schema.Number,
    trace: Schema.optional(Trace),
  })
  export type Event = typeof Event.Type
  export const History = Schema.Struct({
    version: Schema.Literal(1),
    cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    runs: Schema.Array(Run),
    events: Schema.Array(Event),
  })
  export type History = typeof History.Type
  export const EventPage = Schema.Struct({
    version: Schema.Literal(1),
    cursor: History.fields.cursor,
    runs: History.fields.runs,
    events: History.fields.events,
  })
}
