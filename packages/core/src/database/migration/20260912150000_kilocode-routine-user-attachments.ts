// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912150000_kilocode-routine-user-attachments",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`raya_routine_conversation\` ADD COLUMN \`draft_attachments\` text;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_message\` ADD COLUMN \`attachments\` text;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_message\` ADD COLUMN \`delivery_id\` text;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_message\` ADD COLUMN \`delivered_at\` integer;`)
      yield* tx.run(
        `UPDATE \`raya_routine_message\` SET \`delivered_at\` = \`time_created\` WHERE \`kind\` = 'user' AND \`session_id\` IS NOT NULL;`,
      )
      yield* tx.run(`
        CREATE TABLE \`raya_routine_attachment\` (
          \`id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`message_id\` text,
          \`name\` text NOT NULL,
          \`mime\` text NOT NULL,
          \`size\` integer NOT NULL,
          \`data\` text NOT NULL,
          \`sha256\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_attachment_agent_id_raya_routine_conversation_agent_id_fk\` FOREIGN KEY (\`agent_id\`) REFERENCES \`raya_routine_conversation\`(\`agent_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_raya_routine_attachment_message_id_raya_routine_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`raya_routine_message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`raya_routine_attachment_owner\` ON \`raya_routine_attachment\` (\`agent_id\`,\`message_id\`,\`time_created\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
