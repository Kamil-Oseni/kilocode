import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908092112_kilocode-routine-occurrence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_cursor\` (
          \`agent_id\` text NOT NULL,
          \`schedule_version\` integer NOT NULL,
          \`through\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`raya_routine_cursor_pk\` PRIMARY KEY(\`agent_id\`, \`schedule_version\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_occurrence\` (
          \`id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`schedule_version\` integer NOT NULL,
          \`scheduled_at\` integer NOT NULL,
          \`observed_at\` integer NOT NULL,
          \`timezone\` text,
          \`state\` text NOT NULL,
          \`claim_id\` text,
          \`owner\` text,
          \`lease_until\` integer,
          \`session_id\` text,
          \`reason\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_occurrence_identity\` ON \`raya_routine_occurrence\` (\`agent_id\`,\`schedule_version\`,\`scheduled_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_occurrence_pending\` ON \`raya_routine_occurrence\` (\`agent_id\`,\`schedule_version\`,\`state\`,\`scheduled_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_occurrence_lease\` ON \`raya_routine_occurrence\` (\`state\`,\`lease_until\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
