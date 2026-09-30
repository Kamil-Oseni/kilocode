import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { setTimeout } from "node:timers/promises"
import { Effect } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { layer } from "../../src/database/sqlite.node"
import { Sqlite } from "../../src/database/sqlite"
import { init } from "../../../opencode/src/storage/db.node"
import { closeProfileSqlite } from "../../src/kilocode/profile-sqlite"

const input = JSON.parse(process.argv[2]!) as { file: string; ready: string; release: string; mode: string }
const work = async (db: import("node:sqlite").DatabaseSync, managed = false) => {
  if (!managed) db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000")
  db.exec("CREATE TABLE IF NOT EXISTS fixture(value TEXT)")
  db.exec("INSERT INTO fixture VALUES ('existing')")
  const iterator = input.mode.endsWith("iterator") ? db.prepare("SELECT * FROM fixture").iterate() : undefined
  if (iterator) iterator.next()
  if (!iterator) {
    if (!managed) db.exec("BEGIN")
    db.exec("SAVEPOINT nested")
    db.exec("INSERT INTO fixture VALUES ('pending')")
    db.exec("RELEASE nested")
  }
  await writeFile(input.ready, String(process.pid))
  const stop = performance.now() + 5_000
  while (!existsSync(input.release)) {
    if (performance.now() >= stop) throw new Error("Fixture release deadline elapsed")
    await setTimeout(10)
  }
  if (iterator) iterator.return?.()
  if (!iterator && !managed) db.exec("COMMIT")
}
if (input.mode.startsWith("legacy")) {
  const db = init(input.file).$client
  try {
    await work(db)
  } finally {
    await closeProfileSqlite(db)
  }
}
if (input.mode.startsWith("effect"))
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = (yield* Sqlite.Native) as import("node:sqlite").DatabaseSync
        if (input.mode === "effect-managed") {
          db.exec("CREATE TABLE IF NOT EXISTS fixture(value TEXT)")
          const client = yield* Client.SqlClient
          yield* client.withTransaction(Effect.promise(() => work(db, true)))
          return
        }
        yield* Effect.promise(() => work(db))
      }).pipe(Effect.provide(layer({ filename: input.file }))),
    ),
  )
