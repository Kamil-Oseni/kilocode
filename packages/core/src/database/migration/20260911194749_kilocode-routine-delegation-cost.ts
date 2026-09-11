// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911194749_kilocode-routine-delegation-cost",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_raya_routine_delegation\` (
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
          \`cost\` real,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_raya_routine_delegation\`(\`id\`, \`source\`, \`sender_id\`, \`recipient_id\`, \`parent_id\`, \`parent_run_id\`, \`workspace\`, \`objective\`, \`expected\`, \`context\`, \`deadline\`, \`budget\`, \`depth\`, \`state\`, \`child_run_id\`, \`session_id\`, \`response\`, \`cost\`, \`reason\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`source\`, \`sender_id\`, \`recipient_id\`, \`parent_id\`, \`parent_run_id\`, \`workspace\`, \`objective\`, \`expected\`, \`context\`, \`deadline\`, \`budget\`, \`depth\`, \`state\`, \`child_run_id\`, \`session_id\`, \`response\`, \`cost\`, \`reason\`, \`time_created\`, \`time_updated\` FROM \`raya_routine_delegation\`;`,
      )
      yield* tx.run(`DROP TABLE \`raya_routine_delegation\`;`)
      yield* tx.run(`ALTER TABLE \`__new_raya_routine_delegation\` RENAME TO \`raya_routine_delegation\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`raya_routine_delegation_source\` ON \`raya_routine_delegation\` (\`source\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`raya_routine_delegation_recipient\` ON \`raya_routine_delegation\` (\`recipient_id\`,\`state\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`raya_routine_delegation_parent\` ON \`raya_routine_delegation\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`raya_routine_delegation_run\` ON \`raya_routine_delegation\` (\`parent_run_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
