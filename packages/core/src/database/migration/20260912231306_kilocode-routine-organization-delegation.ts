// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912231306_kilocode-routine-organization-delegation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_delegation\` (
          \`organization_id\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`recipient_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`raya_routine_organization_delegation_pk\` PRIMARY KEY(\`organization_id\`, \`sender_id\`, \`recipient_id\`),
          CONSTRAINT \`fk_raya_routine_organization_delegation_organization_id_raya_routine_organization_id_fk\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`organization_id\` text;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`organization_name\` text;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`organization_revision\` integer;`)
      yield* tx.run(
        `CREATE INDEX \`raya_routine_delegation_organization\` ON \`raya_routine_delegation\` (\`organization_id\`,\`organization_revision\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_organization_delegation_position\` ON \`raya_routine_organization_delegation\` (\`organization_id\`,\`position\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_delegation_recipient\` ON \`raya_routine_organization_delegation\` (\`organization_id\`,\`recipient_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
