import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911183445_kilocode-routine-delegation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_delegation\` (
          \`id\` text PRIMARY KEY,
          \`source\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`recipient_id\` text NOT NULL,
          \`parent_id\` text,
          \`parent_run_id\` text,
          \`workspace\` text,
          \`objective\` text NOT NULL,
          \`expected\` text,
          \`context\` text,
          \`deadline\` integer,
          \`budget\` integer,
          \`depth\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`child_run_id\` text,
          \`session_id\` text,
          \`response\` text,
          \`cost\` integer,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_delegation_source\` ON \`raya_routine_delegation\` (\`source\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_delegation_recipient\` ON \`raya_routine_delegation\` (\`recipient_id\`,\`state\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`raya_routine_delegation_parent\` ON \`raya_routine_delegation\` (\`parent_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
