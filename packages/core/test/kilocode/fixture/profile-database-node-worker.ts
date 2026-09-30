import { Effect, Layer, ManagedRuntime } from "effect"
import { layer } from "../../../src/database/sqlite.node"
import { Sqlite } from "../../../src/database/sqlite"
import { databaseSnapshot, drainDatabase, resumeDatabase } from "../../../src/kilocode/profile-database"
import type { DatabaseSync } from "node:sqlite"

const file = process.argv[2]!
const first = ManagedRuntime.make(layer({ filename: file }).pipe(Layer.fresh))
const second = ManagedRuntime.make(layer({ filename: file }).pipe(Layer.fresh))
const execute = (sql: string) => Sqlite.Native.use((native) => Effect.sync(() => (native as DatabaseSync).exec(sql)))
try {
  await first.runPromise(execute("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('preserved')"))
  await second.runPromise(execute("INSERT INTO fixture VALUES ('peer')"))
  if (databaseSnapshot(file).instances.length !== 2) throw new Error("Missing independently compiled Node instance")
  const receipt = await drainDatabase(file, () =>
    Promise.all([first.dispose(), second.dispose()]).then(() => undefined),
  )
  if (databaseSnapshot(file).instances.length) throw new Error("Node instances were not closed")
  resumeDatabase(file)
  const fresh = ManagedRuntime.make(layer({ filename: file }).pipe(Layer.fresh))
  try {
    const rows = await fresh.runPromise(
      Sqlite.Native.use((native) =>
        Effect.sync(() => (native as DatabaseSync).prepare("SELECT value FROM fixture ORDER BY rowid").all()),
      ),
    )
    console.log(JSON.stringify({ receipt, rows }))
  } finally {
    await fresh.dispose()
  }
} finally {
  await Promise.all([first.dispose(), second.dispose()])
}
