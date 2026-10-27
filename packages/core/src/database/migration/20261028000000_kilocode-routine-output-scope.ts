import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028000000_kilocode-routine-output-scope",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `raya_routine_delegation` ADD `outputs` text;")
    })
  },
} satisfies DatabaseMigration.Migration
