import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917021944_kilocode-routine-organization-budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`raya_routine_organization\` ADD \`budget\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
