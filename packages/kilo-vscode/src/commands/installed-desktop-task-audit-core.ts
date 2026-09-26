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

const sha = /^[a-f\d]{64}$/i
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
