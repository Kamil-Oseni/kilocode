import {
  taskAuditDelta,
  taskEventDelta,
  taskNativeDelta,
  validTaskEvidence,
  validTaskNative,
  type TaskAuditSnapshot,
  type TaskEvidenceSnapshot,
  type TaskNativeSnapshot,
} from "./installed-desktop-task-audit-core"

export type TaskAuditIdentity = {
  version: string
  digest: string
  captureSha256: string
  backend: { pid: number; startedAt: number; port: number; generation: number }
  lease: { grantHash: string; level: "observe" | "assisted" | "autonomous"; state: "active" }
  desktop: { host: string; input: string }
}

export type TaskAuditRun = {
  format: "raya.installed-desktop-task-boundary"
  version: 1
  runId: string
  scenario: string
  startedAt: number
  identity: TaskAuditIdentity
  audit: TaskAuditSnapshot
}

export type TaskEvidenceRun = {
  format: "raya.installed-desktop-task-boundary"
  version: 2
  runId: string
  scenario: string
  startedAt: number
  identity: TaskAuditIdentity
  evidence: TaskEvidenceSnapshot
}

export type TaskNativeRun = {
  format: "raya.installed-desktop-task-boundary"
  version: 3
  runId: string
  scenario: string
  startedAt: number
  identity: TaskAuditIdentity
  evidence: TaskNativeSnapshot
}

const sha = /^[a-f\d]{64}$/i

function valid(input: TaskAuditIdentity) {
  return (
    !!input &&
    !!input.backend &&
    !!input.lease &&
    !!input.desktop &&
    /^\d+\.\d+\.\d+-snapshot\+[^/\\]+$/.test(input.version) &&
    sha.test(input.digest) &&
    sha.test(input.captureSha256) &&
    Number.isSafeInteger(input.backend.pid) &&
    input.backend.pid > 0 &&
    Number.isSafeInteger(input.backend.startedAt) &&
    input.backend.startedAt > 0 &&
    Number.isSafeInteger(input.backend.port) &&
    input.backend.port > 0 &&
    Number.isSafeInteger(input.backend.generation) &&
    input.backend.generation >= 0 &&
    sha.test(input.lease.grantHash) &&
    ["observe", "assisted", "autonomous"].includes(input.lease.level) &&
    input.lease.state === "active" &&
    !!input.desktop.host &&
    input.desktop.host === input.desktop.input
  )
}

function unavailable(reason: string) {
  return { status: "unavailable" as const, reason, releaseGateEligible: false as const }
}

/** This marker is durable across extension reloads, but cannot attribute actions to Raya by itself. */
export function beginTaskAudit(runId: string, scenario: string, identity: TaskAuditIdentity, audit: TaskAuditSnapshot) {
  if (!/^[\w-]{8,96}$/.test(runId) || !/^[\w-]{3,96}$/.test(scenario))
    return unavailable("The task identity is invalid")
  if (!valid(identity)) return unavailable("The loaded installed host, lease or input desktop is unavailable")
  if (!audit || typeof audit.epoch !== "string" || !audit.epoch || !Number.isSafeInteger(audit.revision))
    return unavailable("No settled durable native journal is available")
  return {
    status: "ready" as const,
    boundary: {
      format: "raya.installed-desktop-task-boundary" as const,
      version: 1 as const,
      runId,
      scenario,
      startedAt: Date.now(),
      identity,
      audit,
    },
    releaseGateEligible: false as const,
  }
}

/** The returned delta is preparatory evidence, never a release-gate verdict. */
export function endTaskAudit(run: TaskAuditRun, runId: string, identity: TaskAuditIdentity, audit: TaskAuditSnapshot) {
  if (!run || run.format !== "raya.installed-desktop-task-boundary" || run.version !== 1 || run.runId !== runId)
    return unavailable("The saved task boundary does not match this run")
  if (!valid(run.identity) || !valid(identity)) return unavailable("The installed host identity is unavailable")
  if (JSON.stringify(run.identity) !== JSON.stringify(identity))
    return unavailable("The installed host, backend, lease or input desktop changed during the task")
  const delta = taskAuditDelta(run.audit, audit)
  if (delta.status !== "available") return delta
  return {
    status: "available" as const,
    format: "raya.installed-desktop-task-boundary-result" as const,
    version: 1 as const,
    runId,
    scenario: run.scenario,
    startedAt: run.startedAt,
    finishedAt: Date.now(),
    identity,
    audit: delta,
    releaseGateEligible: false as const,
  }
}

/** Version 2 binds a durable decision/effect delta to one hashed session claim. */
export function beginTaskEvidence(
  runId: string,
  scenario: string,
  identity: TaskAuditIdentity,
  evidence: TaskEvidenceSnapshot | TaskNativeSnapshot,
) {
  if (!/^[\w-]{8,96}$/.test(runId) || !/^[\w-]{3,96}$/.test(scenario))
    return unavailable("The task identity is invalid")
  if (!valid(identity)) return unavailable("The loaded installed host, lease or input desktop is unavailable")
  const native = validTaskNative(evidence)
  if (!native && !validTaskEvidence(evidence)) return unavailable("No settled versioned action evidence is available")
  return {
    status: "ready" as const,
    boundary: {
      format: "raya.installed-desktop-task-boundary" as const,
      version: native ? (3 as const) : (2 as const),
      runId,
      scenario,
      startedAt: Date.now(),
      identity,
      evidence,
    },
    releaseGateEligible: false as const,
  }
}

/** Legacy v1 markers remain readable but cannot masquerade as version 2 evidence. */
export function endTaskEvidence(
  run: TaskAuditRun | TaskEvidenceRun | TaskNativeRun,
  runId: string,
  identity: TaskAuditIdentity,
  evidence: TaskEvidenceSnapshot | TaskNativeSnapshot,
) {
  if (!run || run.format !== "raya.installed-desktop-task-boundary" || (run.version !== 2 && run.version !== 3))
    return unavailable("The saved task boundary predates versioned action evidence")
  if (run.runId !== runId || !/^[\w-]{3,96}$/.test(run.scenario) || !Number.isSafeInteger(run.startedAt))
    return unavailable("The saved task boundary does not match this run")
  if (!valid(run.identity) || !valid(identity)) return unavailable("The installed host identity is unavailable")
  if (JSON.stringify(run.identity) !== JSON.stringify(identity))
    return unavailable("The installed host, backend, lease or input desktop changed during the task")
  const delta =
    run.version === 3
      ? taskNativeDelta(run.evidence, evidence as TaskNativeSnapshot)
      : taskEventDelta(run.evidence, evidence as TaskEvidenceSnapshot)
  if (delta.status !== "available") return delta
  return {
    status: "available" as const,
    format: "raya.installed-desktop-task-boundary-result" as const,
    version: run.version,
    runId,
    scenario: run.scenario,
    startedAt: run.startedAt,
    finishedAt: Date.now(),
    identity,
    evidence: delta,
    releaseGateEligible: false as const,
  }
}
