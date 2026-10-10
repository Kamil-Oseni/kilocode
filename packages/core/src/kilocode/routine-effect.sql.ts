import { sql } from "drizzle-orm"
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Empty migrated tables and inactive defaults grant no execution authority.
export const RoutineEffectScope = sqliteTable(
  "raya_routine_effect_scope",
  {
    id: text().primaryKey(),
    kind: text({
      enum: ["principal", "organization", "goal", "run", "session", "delegation", "workspace", "config"],
    }).notNull(),
    principal: text().notNull(),
    birth: text().notNull(),
    generation: text().notNull(),
    projection: text().notNull(),
    state: text({ enum: ["inactive", "active", "revoking", "retired"] })
      .default("inactive")
      .notNull(),
  },
  (row) => [
    uniqueIndex("raya_routine_effect_scope_identity").on(row.kind, row.principal, row.birth),
    check(
      "raya_routine_effect_scope_bounds",
      sql`length(${row.id}) = 64 AND length(${row.generation}) = 32 AND length(${row.projection}) = 64 AND length(CAST(${row.principal} AS BLOB)) BETWEEN 1 AND 256 AND length(${row.birth}) BETWEEN 1 AND 20 AND ${row.state} IN ('inactive', 'active', 'revoking', 'retired') AND ${row.kind} IN ('principal', 'organization', 'goal', 'run', 'session', 'delegation', 'workspace', 'config')`,
    ),
  ],
)

export const RoutineEffectParticipant = sqliteTable(
  "raya_routine_effect_participant",
  {
    id: text().primaryKey(),
    profile: text().notNull(),
    protocol: text().notNull(),
    cohort: text().notNull(),
    pid: integer().notNull(),
    birth: text().notNull(),
    state: text({ enum: ["inactive", "qualified", "revoked", "retired"] })
      .default("inactive")
      .notNull(),
  },
  (row) => [
    index("raya_routine_effect_participant_profile").on(row.profile, row.state),
    check(
      "raya_routine_effect_participant_bounds",
      sql`length(${row.id}) = 32 AND length(${row.profile}) = 64 AND length(${row.cohort}) = 64 AND length(${row.birth}) BETWEEN 1 AND 20 AND ${row.pid} BETWEEN 1 AND 4294967295 AND ${row.protocol} = 'raya.routine.effect.v1' AND ${row.state} IN ('inactive', 'qualified', 'revoked', 'retired')`,
    ),
  ],
)

export const RoutineEffectCapsule = sqliteTable(
  "raya_routine_effect_capsule",
  {
    id: text().primaryKey(),
    participant: text()
      .notNull()
      .references(() => RoutineEffectParticipant.id),
    generation: text().notNull(),
    run: text().notNull(),
    session: text().notNull(),
    step: text().notNull(),
    owner: text().notNull(),
    projection: text().notNull(),
    state: text({ enum: ["inactive", "active", "revoked", "retired"] })
      .default("inactive")
      .notNull(),
  },
  (row) => [
    uniqueIndex("raya_routine_effect_capsule_step").on(row.run, row.session, row.step),
    index("raya_routine_effect_capsule_run").on(row.run, row.state),
    check(
      "raya_routine_effect_capsule_bounds",
      sql`length(${row.id}) = 32 AND length(${row.participant}) = 32 AND length(${row.generation}) = 32 AND length(${row.owner}) = 64 AND length(${row.projection}) = 64 AND length(CAST(${row.run} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.session} AS BLOB)) BETWEEN 1 AND 256 AND length(CAST(${row.step} AS BLOB)) BETWEEN 1 AND 256 AND ${row.state} IN ('inactive', 'active', 'revoked', 'retired')`,
    ),
  ],
)

export const RoutineEffectMembership = sqliteTable(
  "raya_routine_effect_membership",
  {
    capsule: text()
      .notNull()
      .references(() => RoutineEffectCapsule.id),
    scope: text()
      .notNull()
      .references(() => RoutineEffectScope.id),
    generation: text().notNull(),
  },
  (row) => [
    primaryKey({ columns: [row.capsule, row.scope] }),
    index("raya_routine_effect_membership_scope").on(row.scope, row.generation, row.capsule),
    check(
      "raya_routine_effect_membership_bounds",
      sql`length(${row.capsule}) = 32 AND length(${row.scope}) = 64 AND length(${row.generation}) = 32`,
    ),
  ],
)

export const RoutineEffectRevocation = sqliteTable(
  "raya_routine_effect_revocation",
  {
    id: text().primaryKey(),
    scope: text()
      .notNull()
      .references(() => RoutineEffectScope.id),
    generation: text().notNull(),
    projection: text().notNull(),
    request: text().notNull(),
    reason: text().notNull(),
    state: text({ enum: ["requested", "published", "uncertain"] })
      .default("requested")
      .notNull(),
  },
  (row) => [
    uniqueIndex("raya_routine_effect_revocation_identity").on(row.scope, row.generation),
    index("raya_routine_effect_revocation_pending").on(row.scope, row.state),
    check(
      "raya_routine_effect_revocation_bounds",
      sql`length(${row.id}) = 32 AND length(${row.scope}) = 64 AND length(${row.generation}) = 32 AND length(${row.projection}) = 64 AND length(${row.request}) = 64 AND length(CAST(${row.reason} AS BLOB)) BETWEEN 1 AND 256 AND ${row.state} IN ('requested', 'published', 'uncertain')`,
    ),
  ],
)

export const RoutineEffectAttempt = sqliteTable(
  "raya_routine_effect_attempt",
  {
    id: text().primaryKey(),
    capsule: text()
      .notNull()
      .references(() => RoutineEffectCapsule.id),
    generation: text().notNull(),
    kind: text({ enum: ["model", "tool", "mcp", "browser", "native"] }).notNull(),
    purpose: text().notNull(),
    digest: text().notNull(),
    owner: text().notNull(),
    state: text({ enum: ["reserved", "started", "settled", "refused", "uncertain"] }).notNull(),
    receipt: text(),
  },
  (row) => [
    uniqueIndex("raya_routine_effect_attempt_identity").on(row.capsule, row.purpose),
    index("raya_routine_effect_attempt_debt").on(row.capsule, row.state),
    check(
      "raya_routine_effect_attempt_bounds",
      sql`length(${row.id}) = 32 AND length(${row.capsule}) = 32 AND length(${row.generation}) = 32 AND length(${row.digest}) = 64 AND length(${row.owner}) = 64 AND ${row.kind} IN ('model', 'tool', 'mcp', 'browser', 'native') AND length(CAST(${row.purpose} AS BLOB)) BETWEEN 1 AND 256 AND ${row.state} IN ('reserved', 'started', 'settled', 'refused', 'uncertain') AND ((${row.state} = 'settled' AND ${row.receipt} IS NOT NULL AND length(${row.receipt}) = 64) OR (${row.state} <> 'settled' AND ${row.receipt} IS NULL))`,
    ),
  ],
)
