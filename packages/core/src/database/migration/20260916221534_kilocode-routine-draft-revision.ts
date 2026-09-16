// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260916221534_kilocode-routine-draft-revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`raya_routine_conversation\` ADD \`draft_revision\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
