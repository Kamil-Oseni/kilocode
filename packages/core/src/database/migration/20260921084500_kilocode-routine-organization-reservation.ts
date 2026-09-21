import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260921084500_kilocode-routine-organization-reservation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_reservation\` (
          \`run_id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`organization_id\` text NOT NULL,
          \`organization_revision\` integer NOT NULL,
          \`session_id\` text,
          \`budget\` real NOT NULL,
          \`cost\` real,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_organization_reservation_organization_id\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_reservation_ledger\` ON \`raya_routine_organization_reservation\` (\`organization_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_organization_reservation_session\` ON \`raya_routine_organization_reservation\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
