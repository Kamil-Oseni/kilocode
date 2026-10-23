import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261023034737_kilocode-routine-delegation-criteria",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`criteria\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
