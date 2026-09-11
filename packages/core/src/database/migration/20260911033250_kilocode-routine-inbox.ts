import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911033250_kilocode-routine-inbox",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_conversation\` (
          \`agent_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`read_at\` integer NOT NULL,
          \`draft\` text,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_message\` (
          \`id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`body\` text NOT NULL,
          \`occurrence_id\` text,
          \`session_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_raya_routine_message_agent_id_raya_routine_conversation_agent_id_fk\` FOREIGN KEY (\`agent_id\`) REFERENCES \`raya_routine_conversation\`(\`agent_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_message_source\` ON \`raya_routine_message\` (\`agent_id\`,\`source\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_message_order\` ON \`raya_routine_message\` (\`agent_id\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
