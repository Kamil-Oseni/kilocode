import { writeFile } from "node:fs/promises"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { dump, list } from "@opencode-ai/core/kilocode/migration-backup"
import { CliError, effectCmd } from "../../../cli/effect-cmd"

export const BackupsCommand = effectCmd({
  command: "backups [id]",
  describe: "list pre-migration recovery snapshots or export one to a new SQL file",
  instance: false,
  builder: (args) =>
    args.positional("id", { type: "string", describe: "Migration snapshot identifier" }).option("output", {
      type: "string",
      describe: "New SQL file for the selected snapshot (never overwritten)",
    }),
  handler: Effect.fn("Cli.db.backups")(
    function* (args: { id?: string; output?: string }) {
      if (!!args.id !== !!args.output)
        yield* Effect.fail(new Error("Provide both a snapshot id and --output, or neither to list snapshots."))
      const { db } = yield* Database.Service
      if (!args.id || !args.output) {
        console.log(JSON.stringify(yield* list(db), null, 2))
        return
      }
      const content = yield* dump(db, args.id)
      const output = args.output
      yield* Effect.tryPromise(() => writeFile(output, content, { flag: "wx", mode: 0o600 }))
      console.log(`Saved recovery snapshot to ${args.output}. Restore only into an empty database.`)
    },
    Effect.mapError((error) => new CliError({ message: error.message })),
  ),
})
