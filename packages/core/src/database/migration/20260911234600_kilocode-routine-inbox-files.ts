// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911234600_kilocode-routine-inbox-files",
  up(tx) {
    return tx.run(`ALTER TABLE \`raya_routine_message\` ADD COLUMN \`files\` text;`)
  },
} satisfies DatabaseMigration.Migration
