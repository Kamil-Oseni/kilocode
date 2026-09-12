// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912210000_kilocode-routine-organization",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`purpose\` text,
          \`revision\` integer NOT NULL,
          \`archived_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_lifecycle\` ON \`raya_routine_organization\` (\`archived_at\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_member\` (
          \`organization_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`supervisor_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          PRIMARY KEY (\`organization_id\`, \`agent_id\`),
          CONSTRAINT \`fk_raya_routine_organization_member_organization_id\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_organization_member_position\` ON \`raya_routine_organization_member\` (\`organization_id\`,\`position\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_member_agent\` ON \`raya_routine_organization_member\` (\`agent_id\`,\`organization_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_organization_member_supervisor\` ON \`raya_routine_organization_member\` (\`organization_id\`,\`supervisor_id\`);`,
      )
      yield* tx.run(`
        CREATE TABLE \`raya_routine_organization_revision\` (
          \`organization_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`definition\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          PRIMARY KEY (\`organization_id\`, \`revision\`),
          CONSTRAINT \`fk_raya_routine_organization_revision_organization_id\` FOREIGN KEY (\`organization_id\`) REFERENCES \`raya_routine_organization\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
