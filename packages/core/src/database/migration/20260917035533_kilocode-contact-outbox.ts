import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917035533_kilocode-contact-outbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_contact_destination\` (
          \`id\` text PRIMARY KEY,
          \`source\` text NOT NULL,
          \`channel\` text NOT NULL,
          \`address\` text NOT NULL,
          \`label\` text,
          \`scope\` text NOT NULL,
          \`scope_id\` text NOT NULL,
          \`quiet_start\` integer,
          \`quiet_end\` integer,
          \`timezone\` text,
          \`revision\` integer NOT NULL,
          \`enabled\` integer NOT NULL,
          \`revoked_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_contact_message\` (
          \`id\` text PRIMARY KEY,
          \`source\` text NOT NULL,
          \`destination_id\` text NOT NULL,
          \`destination_revision\` integer NOT NULL,
          \`agent_id\` text,
          \`organization_id\` text,
          \`session_id\` text,
          \`body\` text NOT NULL,
          \`state\` text NOT NULL,
          \`attempts\` integer NOT NULL,
          \`available_at\` integer NOT NULL,
          \`lease_id\` text,
          \`lease_owner\` text,
          \`lease_until\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_raya_contact_message_destination_id_raya_contact_destination_id_fk\` FOREIGN KEY (\`destination_id\`) REFERENCES \`raya_contact_destination\`(\`id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_contact_receipt\` (
          \`message_id\` text PRIMARY KEY,
          \`status\` text NOT NULL,
          \`code\` text NOT NULL,
          \`provider_ref\` text,
          \`attempts\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_raya_contact_receipt_message_id_raya_contact_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`raya_contact_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_contact_destination_source\` ON \`raya_contact_destination\` (\`source\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_contact_destination_identity\` ON \`raya_contact_destination\` (\`channel\`,\`address\`,\`scope\`,\`scope_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_contact_destination_scope\` ON \`raya_contact_destination\` (\`scope\`,\`scope_id\`,\`enabled\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`raya_contact_message_source\` ON \`raya_contact_message\` (\`source\`);`)
      yield* tx.run(
        `CREATE INDEX \`raya_contact_message_pending\` ON \`raya_contact_message\` (\`state\`,\`available_at\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_contact_message_destination\` ON \`raya_contact_message\` (\`destination_id\`,\`state\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
