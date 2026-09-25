import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260925201938_kilocode-routine-organization-stop",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`raya_routine_organization\` ADD \`stopping_at\` integer;`)
      yield* tx.run(`ALTER TABLE \`raya_routine_organization\` ADD \`stopped_at\` integer;`)
      yield* tx.run(
        `UPDATE \`raya_routine_organization\` SET \`stopped_at\` = \`archived_at\` WHERE \`archived_at\` IS NOT NULL;`,
      )
      yield* tx.run(
        `UPDATE \`raya_routine_organization\` SET \`stopping_at\` = \`archived_at\` WHERE \`archived_at\` IS NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
