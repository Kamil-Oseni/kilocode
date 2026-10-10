import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010030507_kilocode-routine-effect",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_attempt\` (
          \`id\` text PRIMARY KEY,
          \`capsule\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`purpose\` text NOT NULL,
          \`digest\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`state\` text NOT NULL,
          \`receipt\` text,
          CONSTRAINT \`fk_raya_routine_effect_attempt_capsule_raya_routine_effect_capsule_id_fk\` FOREIGN KEY (\`capsule\`) REFERENCES \`raya_routine_effect_capsule\`(\`id\`),
          CONSTRAINT "raya_routine_effect_attempt_bounds" CHECK(length("id") = 32 AND length("capsule") = 32 AND length("generation") = 32 AND length("digest") = 64 AND length("owner") = 64 AND "kind" IN ('model', 'tool', 'mcp', 'browser', 'native') AND length(CAST("purpose" AS BLOB)) BETWEEN 1 AND 256 AND "state" IN ('reserved', 'started', 'settled', 'refused', 'uncertain') AND (("state" = 'settled' AND "receipt" IS NOT NULL AND length("receipt") = 64) OR ("state" <> 'settled' AND "receipt" IS NULL)))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_capsule\` (
          \`id\` text PRIMARY KEY,
          \`participant\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`run\` text NOT NULL,
          \`session\` text NOT NULL,
          \`step\` text NOT NULL,
          \`owner\` text NOT NULL,
          \`projection\` text NOT NULL,
          \`state\` text DEFAULT 'inactive' NOT NULL,
          CONSTRAINT \`fk_raya_routine_effect_capsule_participant_raya_routine_effect_participant_id_fk\` FOREIGN KEY (\`participant\`) REFERENCES \`raya_routine_effect_participant\`(\`id\`),
          CONSTRAINT "raya_routine_effect_capsule_bounds" CHECK(length("id") = 32 AND length("participant") = 32 AND length("generation") = 32 AND length("owner") = 64 AND length("projection") = 64 AND length(CAST("run" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("session" AS BLOB)) BETWEEN 1 AND 256 AND length(CAST("step" AS BLOB)) BETWEEN 1 AND 256 AND "state" IN ('inactive', 'active', 'revoked', 'retired'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_membership\` (
          \`capsule\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`generation\` text NOT NULL,
          CONSTRAINT \`raya_routine_effect_membership_pk\` PRIMARY KEY(\`capsule\`, \`scope\`),
          CONSTRAINT \`fk_raya_routine_effect_membership_capsule_raya_routine_effect_capsule_id_fk\` FOREIGN KEY (\`capsule\`) REFERENCES \`raya_routine_effect_capsule\`(\`id\`),
          CONSTRAINT \`fk_raya_routine_effect_membership_scope_raya_routine_effect_scope_id_fk\` FOREIGN KEY (\`scope\`) REFERENCES \`raya_routine_effect_scope\`(\`id\`),
          CONSTRAINT "raya_routine_effect_membership_bounds" CHECK(length("capsule") = 32 AND length("scope") = 64 AND length("generation") = 32)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_participant\` (
          \`id\` text PRIMARY KEY,
          \`profile\` text NOT NULL,
          \`protocol\` text NOT NULL,
          \`cohort\` text NOT NULL,
          \`pid\` integer NOT NULL,
          \`birth\` text NOT NULL,
          \`state\` text DEFAULT 'inactive' NOT NULL,
          CONSTRAINT "raya_routine_effect_participant_bounds" CHECK(length("id") = 32 AND length("profile") = 64 AND length("cohort") = 64 AND length("birth") BETWEEN 1 AND 20 AND "pid" BETWEEN 1 AND 4294967295 AND "protocol" = 'raya.routine.effect.v1' AND "state" IN ('inactive', 'qualified', 'revoked', 'retired'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_revocation\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`projection\` text NOT NULL,
          \`request\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`state\` text DEFAULT 'requested' NOT NULL,
          CONSTRAINT \`fk_raya_routine_effect_revocation_scope_raya_routine_effect_scope_id_fk\` FOREIGN KEY (\`scope\`) REFERENCES \`raya_routine_effect_scope\`(\`id\`),
          CONSTRAINT "raya_routine_effect_revocation_bounds" CHECK(length("id") = 32 AND length("scope") = 64 AND length("generation") = 32 AND length("projection") = 64 AND length("request") = 64 AND length(CAST("reason" AS BLOB)) BETWEEN 1 AND 256 AND "state" IN ('requested', 'published', 'uncertain'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_effect_scope\` (
          \`id\` text PRIMARY KEY,
          \`kind\` text NOT NULL,
          \`principal\` text NOT NULL,
          \`birth\` text NOT NULL,
          \`generation\` text NOT NULL,
          \`projection\` text NOT NULL,
          \`state\` text DEFAULT 'inactive' NOT NULL,
          CONSTRAINT "raya_routine_effect_scope_bounds" CHECK(length("id") = 64 AND length("generation") = 32 AND length("projection") = 64 AND length(CAST("principal" AS BLOB)) BETWEEN 1 AND 256 AND length("birth") BETWEEN 1 AND 20 AND "state" IN ('inactive', 'active', 'revoking', 'retired') AND "kind" IN ('principal', 'organization', 'goal', 'run', 'session', 'delegation', 'workspace', 'config'))
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_attempt_identity\` ON \`raya_routine_effect_attempt\` (\`capsule\`,\`purpose\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_attempt_debt\` ON \`raya_routine_effect_attempt\` (\`capsule\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_capsule_step\` ON \`raya_routine_effect_capsule\` (\`run\`,\`session\`,\`step\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_capsule_run\` ON \`raya_routine_effect_capsule\` (\`run\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_membership_scope\` ON \`raya_routine_effect_membership\` (\`scope\`,\`generation\`,\`capsule\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_participant_profile\` ON \`raya_routine_effect_participant\` (\`profile\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_revocation_identity\` ON \`raya_routine_effect_revocation\` (\`scope\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_effect_revocation_pending\` ON \`raya_routine_effect_revocation\` (\`scope\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_effect_scope_identity\` ON \`raya_routine_effect_scope\` (\`kind\`,\`principal\`,\`birth\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
