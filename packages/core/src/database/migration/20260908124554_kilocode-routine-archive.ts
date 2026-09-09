import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908124554_kilocode-routine-archive",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`raya_routine_archive_import\` (
          \`id\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`raya_routine_archive\` (
          \`id\` text PRIMARY KEY,
          \`archived_at\` integer NOT NULL,
          \`definition\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`raya_routine_archive_order\` ON \`raya_routine_archive\` ("archived_at" desc,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
