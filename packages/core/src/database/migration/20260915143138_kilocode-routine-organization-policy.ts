// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260915143138_kilocode-routine-organization-policy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`raya_routine_organization\` ADD \`policy\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
