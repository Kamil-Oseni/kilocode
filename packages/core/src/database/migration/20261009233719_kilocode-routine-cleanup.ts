import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261009233719_kilocode-routine-cleanup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`raya_routine_occurrence_cleanup\` ON \`raya_routine_occurrence\` (\`agent_id\`,\`state\`,\`schedule_version\`,\`scheduled_at\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
