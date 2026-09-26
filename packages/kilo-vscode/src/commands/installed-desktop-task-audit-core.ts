/** A bounded delta from two durable, redacted desktop journal snapshots. */
export type TaskAuditEntry = {
  hash: string
  effect: "manage" | "interact"
  outcome: "confirmed" | "unknown"
  startedAt: number
  finishedAt: number
}

export type TaskAuditSnapshot = {
  epoch: string
  revision: number
  entries: TaskAuditEntry[]
}

export type TaskActionEvent = {
  hash: string
  sessionHash: string
  effect: "manage" | "interact"
  phase: "pre_dispatch" | "post_dispatch"
  outcome: "refused" | "cancelled" | "confirmed" | "unknown"
  startedAt: number
  finishedAt: number
}

/** One settled journal revision; the session hash is an opaque local correlation token. */
export type TaskEvidenceSnapshot = {
  epoch: string
  revision: number
  audit: TaskAuditEntry[]
  events: TaskActionEvent[]
  sessionHash: string
}

const sha = /^[a-f\d]{64}$/i
const lower = /^[a-f\d]{64}$/
const capacity = 256

function validEntry(item: TaskAuditEntry) {
  if (!item || typeof item !== "object" || typeof item.hash !== "string" || !sha.test(item.hash)) return false
  if (Object.keys(item).some((key) => !["hash", "effect", "outcome", "startedAt", "finishedAt"].includes(key)))
    return false
  if (item.effect !== "manage" && item.effect !== "interact") return false
  if (item.outcome !== "confirmed" && item.outcome !== "unknown") return false
  if (!Number.isSafeInteger(item.startedAt) || !Number.isSafeInteger(item.finishedAt)) return false
  return item.startedAt > 0 && item.finishedAt >= item.startedAt
}

function valid(value: TaskAuditSnapshot) {
  if (!value || typeof value !== "object") return false
  if (typeof value.epoch !== "string" || !value.epoch || !Number.isSafeInteger(value.revision) || value.revision < 0)
    return false
  if (!Array.isArray(value.entries) || value.entries.length >= capacity) return false
  const seen = new Set<string>()
  for (const item of value.entries) {
    if (!validEntry(item)) return false
    if (seen.has(item.hash)) return false
    seen.add(item.hash)
  }
  return true
}

function event(item: unknown): item is TaskActionEvent {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false
  const row = item as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "effect,finishedAt,hash,outcome,phase,sessionHash,startedAt") return false
  if (typeof row.hash !== "string" || !lower.test(row.hash)) return false
  if (typeof row.sessionHash !== "string" || !lower.test(row.sessionHash)) return false
  if (row.effect !== "manage" && row.effect !== "interact") return false
  if (!phase(row.phase, row.outcome)) return false
  if (!Number.isSafeInteger(row.startedAt) || !Number.isSafeInteger(row.finishedAt)) return false
  return (row.startedAt as number) > 0 && (row.finishedAt as number) >= (row.startedAt as number)
}

function phase(kind: unknown, outcome: unknown) {
  if (kind === "pre_dispatch") return outcome === "refused" || outcome === "cancelled"
  if (kind === "post_dispatch") return outcome === "confirmed" || outcome === "unknown"
  return false
}

function rows<T extends { hash: string }>(value: unknown, check: (item: unknown) => item is T) {
  if (!Array.isArray(value) || value.length >= capacity) return false
  const seen = new Set<string>()
  for (const item of value) {
    if (!check(item) || seen.has(item.hash)) return false
    seen.add(item.hash)
  }
  return true
}

function auditEntry(value: unknown): value is TaskAuditEntry {
  if (!validEntry(value as TaskAuditEntry)) return false
  const row = value as TaskAuditEntry
  return Object.keys(row).length === 5 && lower.test(row.hash)
}

/** Reject private fields and full rings before a task boundary is persisted. */
export function validTaskEvidence(value: unknown): value is TaskEvidenceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "audit,epoch,events,revision,sessionHash") return false
  if (typeof row.epoch !== "string" || !row.epoch) return false
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) return false
  if (typeof row.sessionHash !== "string" || !lower.test(row.sessionHash)) return false
  return rows(row.audit, auditEntry) && rows(row.events, event)
}

function unchanged<T extends { hash: string }>(before: T[], after: T[]) {
  const current = new Map(after.map((item) => [item.hash, item]))
  return before.every((item) => {
    const next = current.get(item.hash)
    return next && JSON.stringify(item) === JSON.stringify(next)
  })
}

function correlated(audit: TaskAuditEntry[], events: TaskActionEvent[], sessionHash: string) {
  const native = new Map(audit.map((item) => [item.hash, item]))
  const actions = new Map(events.map((item) => [item.hash, item]))
  for (const item of events) {
    if (item.sessionHash !== sessionHash) return "An action event belongs to a foreign desktop session"
    const receipt = native.get(item.hash)
    if (item.phase === "pre_dispatch") {
      if (receipt) return "A pre-dispatch decision unexpectedly has a native receipt"
      continue
    }
    if (
      !receipt ||
      receipt.effect !== item.effect ||
      receipt.outcome !== item.outcome ||
      receipt.startedAt !== item.startedAt ||
      receipt.finishedAt !== item.finishedAt
    )
      return "A post-dispatch event has no matching native receipt"
  }
  for (const item of audit) {
    if (actions.get(item.hash)?.phase !== "post_dispatch")
      return "A new native receipt has no matching post-dispatch event"
  }
  return null
}

/**
 * Preparatory host evidence. A post-dispatch event needs an identical native
 * receipt; a pre-dispatch refusal/cancellation legitimately has none.
 * This cannot attest native broker identity or the independent final state.
 */
export function taskEventDelta(before: TaskEvidenceSnapshot, after: TaskEvidenceSnapshot) {
  const unavailable = (reason: string) => ({
    status: "unavailable" as const,
    reason,
    releaseGateEligible: false as const,
  })
  if (!validTaskEvidence(before) || !validTaskEvidence(after))
    return unavailable("A task event snapshot is invalid or reached the journal capacity")
  if (before.epoch !== after.epoch) return unavailable("The desktop journal epoch changed during the task")
  if (before.sessionHash !== after.sessionHash) return unavailable("The desktop session changed during the task")
  if (after.revision <= before.revision) return unavailable("The desktop journal did not advance during the task")
  const prior = new Map(before.audit.map((item) => [item.hash, item]))
  const priorEvents = new Map(before.events.map((item) => [item.hash, item]))
  if (!unchanged(before.audit, after.audit))
    return unavailable("A prior native audit entry disappeared or changed during the task")
  if (!unchanged(before.events, after.events))
    return unavailable("A prior action event disappeared or changed during the task")
  const audit = after.audit.filter((item) => !prior.has(item.hash))
  const events = after.events.filter((item) => !priorEvents.has(item.hash))
  if (!events.length) return unavailable("No new action event was durably recorded")
  const issue = correlated(audit, events, after.sessionHash)
  if (issue) return unavailable(issue)
  return {
    status: "available" as const,
    format: "raya.installed-desktop-task-events" as const,
    version: 2 as const,
    epoch: after.epoch,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    audit,
    events,
    releaseGateEligible: false as const,
  }
}

/**
 * This only proves a durable journal delta. The caller must attest the loaded host,
 * lease, run boundary, independent final state, and that no other actor used Raya.
 * Full journals fail closed because a 256-entry ring can hide dropped actions.
 */
export function taskAuditDelta(before: TaskAuditSnapshot, after: TaskAuditSnapshot) {
  const unavailable = (reason: string) => ({
    status: "unavailable" as const,
    reason,
    releaseGateEligible: false as const,
  })
  if (!valid(before) || !valid(after)) return unavailable("A journal snapshot is invalid or reached the audit capacity")
  if (before.epoch !== after.epoch) return unavailable("The desktop journal epoch changed during the task")
  if (after.revision <= before.revision) return unavailable("The desktop journal did not advance during the task")
  const prior = new Map(before.entries.map((item) => [item.hash, item]))
  const current = new Map(after.entries.map((item) => [item.hash, item]))
  for (const item of before.entries) {
    const next = current.get(item.hash)
    if (!next || JSON.stringify(item) !== JSON.stringify(next))
      return unavailable("A prior native audit entry disappeared or changed during the task")
  }
  const entries = after.entries.filter((item) => !prior.has(item.hash))
  if (!entries.length) return unavailable("No new native action receipt was durably recorded")
  return {
    status: "available" as const,
    format: "raya.installed-desktop-task-audit" as const,
    version: 1 as const,
    epoch: after.epoch,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    entries,
    releaseGateEligible: false as const,
  }
}
