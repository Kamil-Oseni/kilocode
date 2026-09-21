import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260921093000_kilocode-routine-organization-coordinator",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_coordinator\` (
          \`message_id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`organization_id\` text,
          \`organization_revision\` integer,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_organization_coordinator_organization_id\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_coordinator_ledger\` ON \`raya_routine_organization_coordinator\` (\`organization_id\`,\`state\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
