import type { DatabaseMigration } from "../database/migration"

export const action = "atomic-recovery-snapshot-before-reset" as const

export type Rule = {
  id: string
  nearestPriorRelease: string
  firstRelease: string
  lineage: "sqlite-upgrade"
  action: typeof action
  recovery: "export-and-open-with-compatible-pre-reset-runtime"
}

// Release tags are evidence, not guesses from session.version. A database may
// contain sessions created by several application versions, while its migration
// journal is the authority for whether one of these transitions is still due.
export const rules = [
  {
    id: "20260303231226_add_workspace_fields",
    nearestPriorRelease: "7.0.47",
    firstRelease: "7.0.48",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260309230000_move_org_to_state",
    nearestPriorRelease: "7.2.3",
    firstRelease: "7.2.4",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260427172553_slow_nightmare",
    nearestPriorRelease: "7.3.1",
    firstRelease: "7.3.2",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260601202201_amazing_prowler",
    nearestPriorRelease: "7.4.7",
    firstRelease: "7.4.8",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260603040000_session_message_projection_order",
    nearestPriorRelease: "7.4.7",
    firstRelease: "7.4.8",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260604172448_event_sourced_session_input",
    nearestPriorRelease: "7.4.7",
    firstRelease: "7.4.8",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260611192811_lush_chimera",
    nearestPriorRelease: "7.4.15",
    firstRelease: "7.4.16",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260622142730_simplify_session_context_epoch",
    nearestPriorRelease: "7.4.20",
    firstRelease: "7.4.21",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260622170816_reset_v2_session_state",
    nearestPriorRelease: "7.4.20",
    firstRelease: "7.4.21",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
  {
    id: "20260622202450_simplify_session_input",
    nearestPriorRelease: "7.4.20",
    firstRelease: "7.4.21",
    lineage: "sqlite-upgrade",
    action,
    recovery: "export-and-open-with-compatible-pre-reset-runtime",
  },
] as const satisfies readonly Rule[]

const indexed = new Map<string, Rule>(rules.map((rule) => [rule.id, rule]))

export function find(id: string) {
  return indexed.get(id)
}

export function validate(migrations: readonly DatabaseMigration.Migration[]) {
  const ids = new Set(migrations.map((migration) => migration.id))
  if (ids.size !== migrations.length) throw new Error("Database migration identifiers must be unique.")
  if (indexed.size !== rules.length)
    throw new Error("Destructive database migration policy identifiers must be unique.")
  for (const rule of rules) {
    if (!ids.has(rule.id)) throw new Error(`Destructive database migration policy has no migration: ${rule.id}`)
    if (!/^\d+\.\d+\.\d+$/.test(rule.nearestPriorRelease) || !/^\d+\.\d+\.\d+$/.test(rule.firstRelease))
      throw new Error(`Destructive database migration policy has an invalid release boundary: ${rule.id}`)
  }
}
