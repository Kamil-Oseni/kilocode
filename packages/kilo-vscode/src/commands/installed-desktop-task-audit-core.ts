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

export type TaskNativeRow = {
  hash: string
  sessionHash: string
  requestHash: string
  sequence: number
  phase: "settled"
  startedAt: number
  finishedAt: number
  outcome: "confirmed" | "refused" | "cancelled" | "unknown"
  code?: string
  accepted?: number
  attempted?: number
}

export type TaskNativeSnapshot = TaskEvidenceSnapshot & {
  native: TaskNativeRow[]
  legacy: boolean
  nativeGeneration: number
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

function rows<T extends { hash: string }>(value: unknown, check: (item: unknown) => item is T, full = false) {
  if (!Array.isArray(value) || (full ? value.length > capacity : value.length >= capacity)) return false
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
  return evidence(value, false)
}

function evidence(value: unknown, full: boolean): value is TaskEvidenceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "audit,epoch,events,revision,sessionHash") return false
  if (typeof row.epoch !== "string" || !row.epoch) return false
  if (!Number.isSafeInteger(row.revision) || (row.revision as number) < 0) return false
  if (typeof row.sessionHash !== "string" || !lower.test(row.sessionHash)) return false
  return rows(row.audit, auditEntry, full) && rows(row.events, event, full)
}

function nativeValues(row: Record<string, unknown>) {
  if (row.phase !== "settled") return false
  if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0) return false
  if (!Number.isSafeInteger(row.startedAt) || !Number.isSafeInteger(row.finishedAt)) return false
  if ((row.startedAt as number) <= 0 || (row.finishedAt as number) < (row.startedAt as number)) return false
  if (!["confirmed", "refused", "cancelled", "unknown"].includes(row.outcome as string)) return false
  if (row.code !== undefined && (typeof row.code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(row.code))) return false
  if ((row.accepted === undefined) !== (row.attempted === undefined)) return false
  if (row.outcome === "confirmed" && row.code !== "ok") return false
  if (row.accepted === undefined) return row.outcome !== "confirmed"
  if (!nativeCounts(row)) return false
  if (row.outcome === "confirmed") return (row.accepted as number) > 0 && row.accepted === row.attempted
  return true
}

function nativeCounts(row: Record<string, unknown>) {
  return (
    Number.isSafeInteger(row.accepted) &&
    Number.isSafeInteger(row.attempted) &&
    (row.accepted as number) >= 0 &&
    (row.accepted as number) <= (row.attempted as number)
  )
}

function nativeRow(value: unknown): value is TaskNativeRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort().join(",")
  if (
    ![
      "finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
      "code,finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
      "accepted,attempted,finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
      "accepted,attempted,code,finishedAt,hash,outcome,phase,requestHash,sequence,sessionHash,startedAt",
    ].includes(keys)
  )
    return false
  if (typeof row.hash !== "string" || !lower.test(row.hash)) return false
  if (typeof row.sessionHash !== "string" || !lower.test(row.sessionHash)) return false
  if (typeof row.requestHash !== "string" || !lower.test(row.requestHash)) return false
  return nativeValues(row)
}

/** Version 3 accepts only the exact settled, redacted v5 bridge shape. */
export function validTaskNative(value: unknown): value is TaskNativeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "audit,epoch,events,legacy,native,nativeGeneration,revision,sessionHash")
    return false
  if (
    typeof row.legacy !== "boolean" ||
    !Number.isSafeInteger(row.nativeGeneration) ||
    (row.nativeGeneration as number) < 0
  )
    return false
  if (
    !evidence(
      {
        epoch: row.epoch,
        revision: row.revision,
        audit: row.audit,
        events: row.events,
        sessionHash: row.sessionHash,
      },
      true,
    )
  )
    return false
  // Older action and audit rows may have been pruned before this task began.
  // The delta below requires every newly added native row to join new action evidence.
  return rows(row.native, nativeRow, true)
}

/** Bind each new native broker dispatch to a new action event and exact session. */
export function taskNativeDelta(before: TaskNativeSnapshot, after: TaskNativeSnapshot) {
  const unavailable = (reason: string) => ({
    status: "unavailable" as const,
    reason,
    releaseGateEligible: false as const,
  })
  if (!validTaskNative(before) || !validTaskNative(after))
    return unavailable("Native task evidence is invalid, truncated or unsettled")
  if (before.legacy !== after.legacy) return unavailable("The desktop journal migration state changed during the task")
  if (before.nativeGeneration !== after.nativeGeneration)
    return unavailable("Desktop evidence was evicted during the task")
  // v2 validation intentionally rejects v3 fields; project only its exact legacy shape.
  const old = {
    epoch: before.epoch,
    revision: before.revision,
    audit: before.audit,
    events: before.events,
    sessionHash: before.sessionHash,
  }
  const current = {
    epoch: after.epoch,
    revision: after.revision,
    audit: after.audit,
    events: after.events,
    sessionHash: after.sessionHash,
  }
  const events = eventDelta(old, current, true)
  if (events.status !== "available") return events
  if (!unchanged(before.native, after.native))
    return unavailable("A prior native broker receipt disappeared or changed during the task")
  const prior = new Set(before.native.map((item) => item.hash))
  const native = after.native.filter((item) => !prior.has(item.hash))
  const actions = new Map(events.events.map((item) => [item.hash, item]))
  for (const item of native) {
    const action = actions.get(item.requestHash)
    if (!action || action.phase !== "post_dispatch" || item.sessionHash !== after.sessionHash)
      return unavailable("A native broker receipt lacks a matching task action or desktop session")
    if (item.outcome !== "confirmed" || (item.accepted !== undefined && item.accepted !== item.attempted))
      return unavailable("A native broker dispatch has an uncertain, refused or incomplete outcome")
  }
  for (const item of events.events) {
    if (item.phase !== "post_dispatch") continue
    if (item.outcome !== "confirmed") return unavailable("A post-dispatch action has an unknown outcome")
    if (!native.some((row) => row.requestHash === item.hash))
      return unavailable("A post-dispatch action lacks native broker evidence")
  }
  return {
    status: "available" as const,
    format: "raya.installed-desktop-task-native" as const,
    version: 3 as const,
    epoch: after.epoch,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    audit: events.audit,
    events: events.events,
    native,
    releaseGateEligible: false as const,
  }
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
  return eventDelta(before, after, false)
}

function eventDelta(before: TaskEvidenceSnapshot, after: TaskEvidenceSnapshot, full: boolean) {
  const unavailable = (reason: string) => ({
    status: "unavailable" as const,
    reason,
    releaseGateEligible: false as const,
  })
  if (!evidence(before, full) || !evidence(after, full))
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
