import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260921060802_kilocode-routine-delegation-artifacts",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`raya_routine_delegation\` ADD \`artifacts\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
