import { Schema } from "effect"
import { SessionID } from "@opencode-ai/schema/session-id"
import { MessageID, PartID } from "@opencode-ai/schema/v1/session"

// Pure persisted contracts shared by production writers and inactive migration readers.
export namespace Snapshots {
  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  export const File = Schema.Struct({
    path: Schema.String,
    digest: Hash,
    mode: Schema.Literals([420, 493]),
    size: Schema.Int,
  })
  export const Snapshot = Schema.Struct({
    version: Schema.Literal(1),
    digest: Hash,
    head: Schema.String,
    files: Schema.Array(File),
  }).annotate({ identifier: "Raya.SelfHealSnapshot" })
  export type Snapshot = typeof Snapshot.Type
}

export namespace Checkouts {
  export const Worktree = Schema.Struct({
    root: Schema.String,
    directory: Schema.String,
    branch: Schema.String,
    common: Schema.String,
    commit: Schema.String,
  })
}

export namespace Repairs {
  const Checkout = Checkouts

  export const Source = Schema.Struct({ root: Schema.String, commit: Schema.String })
  export const Phase = Schema.Literals([
    "reserved",
    "worktree_creating",
    "worktree_ready",
    "worktree_unknown",
    "session_creating",
    "session_created",
    "goal_creating",
    "goal_created",
    "dispatching",
    "submitted",
    "blocked",
    "dispatch_unknown",
    "legacy_conflict",
  ])
  export const Outcome = Schema.Struct({
    id: Schema.String,
    itemID: Schema.String,
    source: Source,
    worktree: Schema.optional(Checkout.Worktree),
    phase: Phase,
    revision: Schema.Number,
    sessionID: Schema.optional(SessionID),
    reason: Schema.optional(Schema.String),
    at: Schema.Number,
  })
  export const Admission = Schema.Struct({ source: Source })
  export const Granted = Schema.Struct({
    owned: Schema.Boolean,
    outcome: Outcome,
    token: Schema.optional(Schema.String),
  })
  export const Prepare = Schema.Struct({ token: Schema.String, revision: Schema.Number })
  export const Advance = Schema.Struct({
    token: Schema.String,
    revision: Schema.Number,
    phase: Phase,
    sessionID: Schema.optional(SessionID),
  })
  export const Claim = Schema.Struct({ outcome: Outcome, owner: Schema.String })
}

export namespace Verifications {
  const Source = Snapshots

  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  export const Assessment = Schema.Union([
    Schema.Struct({ status: Schema.Literal("unknown"), reason: Schema.String }),
    Schema.Struct({
      status: Schema.Literal("snapshot-input"),
      digest: Hash,
      head: Schema.String,
      checks: Schema.Array(Schema.String),
      contract: Schema.Literal(
        "Captured source input; execution checkout is writable and dependencies are not sealed.",
      ),
    }),
  ]).annotate({ identifier: "Raya.SelfHealSourceAssessment" })
  export const Identity = Schema.Struct({ createdAt: Time, objective: Schema.String, criteria: Schema.String })
  export const Input = Schema.Struct({
    action: Schema.optional(Schema.Literal("run")),
    command: Schema.String,
    setup: Schema.optional(Schema.String),
    workdir: Schema.optional(Schema.String),
    timeout: Schema.optional(Schema.Number),
  })
  export const Receipt = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    itemID: Schema.String,
    attemptID: Schema.String,
    sessionID: SessionID,
    messageID: MessageID,
    callID: Schema.String,
    goal: Identity,
    input: Input,
    snapshot: Source.Snapshot,
    directory: Schema.String,
    startedAt: Time,
    finishedAt: Time,
    exit: Schema.Number,
  })
}

export namespace BuildInputs {
  const Snapshot = Snapshots.Snapshot

  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  export const Build = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
    itemID: Schema.String,
    attemptID: Schema.String,
    completion: Hash,
    checks: Schema.Array(Schema.String),
    snapshot: Snapshot,
    directory: Schema.String,
    output: Schema.String,
    target: Schema.Literals(["win32-x64", "win32-arm64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]),
    extension: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-repair\+[a-f0-9.]+$/)),
    cli: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+-repair\+[a-f0-9.]+$/)),
    at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }).annotate({ identifier: "Raya.SelfHealBuildInput" })
  export type Build = typeof Build.Type
}

export namespace Artifacts {
  const Build = BuildInputs.Build

  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  const Bytes = Schema.Struct({ digest: Hash, size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
  export const Receipt = Schema.Struct({
    version: Schema.Literal(1),
    id: Schema.String,
    itemID: Schema.String,
    attemptID: Schema.String,
    sessionID: SessionID,
    messageID: MessageID,
    callID: Schema.String,
    completion: Hash,
    checks: Schema.Array(Schema.String),
    source: Hash,
    head: Schema.String,
    target: Build.fields.target,
    extension: Build.fields.extension,
    cli: Build.fields.cli,
    contract: Schema.String,
    status: Schema.Literal("ready-for-review"),
    output: Schema.String,
    artifact: Bytes,
    binary: Bytes,
    at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }).annotate({ identifier: "Raya.SelfHealArtifact" })

  export const Pointer = Schema.Struct({
    version: Schema.Literal(1),
    itemID: Schema.String,
    attemptID: Schema.String,
    sessionID: SessionID,
    messageID: MessageID,
    callID: Schema.String,
    completion: Hash,
    at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  })

  export const Review = Schema.Struct({
    artifactID: Schema.String,
    digest: Hash,
    extension: Build.fields.extension,
  })

  export const Approval = Schema.Struct({
    ...Pointer.fields,
    id: Schema.String,
    artifactID: Schema.String,
    source: Hash,
    head: Schema.String,
    extension: Build.fields.extension,
    artifact: Bytes,
    binary: Bytes,
    status: Schema.Literal("install-ready"),
    at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }).annotate({ identifier: "Raya.SelfHealArtifactApproval" })
  export const Terminal = Schema.Struct({
    status: Schema.Literals(["failed", "interrupted"]),
    reason: Schema.String,
    at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  })

  export const Delivery = Schema.Struct({
    ...Pointer.fields,
    status: Schema.Literals([
      "preparing",
      "building",
      "ready-for-review",
      "install-ready",
      "artifact-unavailable",
      "failed",
      "interrupted",
    ]),
    artifact: Schema.optional(Receipt),
    approval: Schema.optional(Approval),
    reason: Schema.optional(Schema.String),
  }).annotate({ identifier: "Raya.SelfHealDelivery" })
}

export namespace Completions {
  const Source = Repairs.Source
  const Worktree = Checkouts.Worktree
  const Assessment = Verifications.Assessment

  const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  const Evidence = Schema.Struct({
    sessionID: SessionID,
    messageID: MessageID,
    partID: PartID,
    callID: Schema.String,
    summary: Schema.String,
    record: Schema.Struct({ version: Schema.Literal(1), digest: Schema.String, at: Time }),
  })
  const Audit = Schema.Struct({
    summary: Schema.String,
    verifiedAt: Time,
    requirements: Schema.Array(
      Schema.Struct({
        criterionID: Schema.optional(Schema.String),
        requirement: Schema.String,
        passed: Schema.Boolean,
        evidence: Schema.Array(Evidence),
      }),
    ),
  })
  export const Goal = Schema.Struct({
    intent: Schema.String,
    revision: Schema.String,
    completedRevision: Schema.String,
    createdAt: Time,
    objective: Schema.String,
    audit: Audit,
    review: Schema.optional(
      Schema.Struct({
        status: Schema.Literal("accepted"),
        at: Time,
        criteria: Schema.Array(Schema.String),
        acceptedAt: Time,
      }),
    ),
  })
  export const Completion = Schema.Struct({
    version: Schema.Literal(1),
    itemID: Schema.String,
    attemptID: Schema.String,
    sessionID: SessionID,
    source: Source,
    worktree: Worktree,
    goal: Goal,
    verification: Schema.optional(Assessment),
    at: Time,
  }).annotate({ identifier: "Raya.SelfHealCompletion" })
}

export namespace Publications {
  const Text = Schema.String.check(Schema.isMinLength(1))
  const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
  const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
  const Source = Schema.Struct({
    sessionID: Text,
    messageID: Text,
    partID: Text,
    callID: Text,
    summary: Text,
    record: Schema.Struct({ version: Schema.Literal(1), digest: Hash, at: Time }),
  })
  const Requirement = Schema.Struct({
    requirement: Text,
    passed: Schema.Literal(true),
    evidence: Schema.Array(Source).check(Schema.isMinLength(1)),
  })
  const Verification = Schema.Struct({
    sessionID: Text,
    goalRevision: Text,
    summary: Text,
    verifiedAt: Time,
    reviewedAt: Time,
    requirements: Schema.Array(Requirement).check(Schema.isMinLength(1)),
  })
  export const Publish = Schema.Struct({
    installationID: Schema.String.check(Schema.isUUID()),
    verification: Verification,
  })
  export const Receipt = Schema.Struct({
    version: Schema.Literal(1),
    itemID: Text,
    installationID: Schema.String.check(Schema.isUUID()),
    goalRevision: Text,
    evidence: Schema.Struct({ summary: Text, artifact: Text, at: Time }),
    verification: Verification,
    createdAt: Time,
  })
}

export namespace Backlogs {
  const Outcome = Repairs.Outcome
  const Completion = Completions.Completion
  const Delivery = Artifacts.Delivery
  export const Category = Schema.Literals([
    "ui",
    "chat",
    "routing",
    "goal",
    "browser",
    "settings",
    "build",
    "test",
    "docs",
    "other",
  ])
  export type Category = typeof Category.Type

  export const Status = Schema.Literals([
    "triaged",
    "queued",
    "in_progress",
    "verified",
    "blocked",
    "duplicate",
    "cancelled",
  ])
  export type Status = typeof Status.Type

  export const Severity = Schema.Literals(["low", "medium", "high"])
  export type Severity = typeof Severity.Type

  export const Evidence = Schema.Struct({
    summary: Schema.String,
    command: Schema.optional(Schema.String),
    artifact: Schema.optional(Schema.String),
    at: Schema.Number,
  })

  export const Item = Schema.Struct({
    repair: Schema.optional(Outcome),
    completion: Schema.optional(Completion),
    artifact: Schema.optional(Delivery),
    legacyVerification: Schema.optional(Schema.Boolean),
    id: Schema.String,
    fingerprint: Schema.String,
    title: Schema.String,
    description: Schema.String,
    category: Category,
    severity: Severity,
    explanation: Schema.String,
    approach: Schema.String,
    status: Status,
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
    reports: Schema.Number,
    reporterSessionID: Schema.optional(SessionID),
    workSessionID: Schema.optional(SessionID),
    blockedReason: Schema.optional(Schema.String),
    evidence: Schema.Array(Evidence),
    reloadRequired: Schema.Boolean,
    notifiedAt: Schema.optional(Schema.Number),
    duplicateOf: Schema.optional(Schema.String), // raya_change - canonical item this report duplicates
    classifiedBy: Schema.optional(Schema.Literals(["keyword", "model"])), // raya_change - who set the current category/severity
  })
  export type Item = typeof Item.Type
}
