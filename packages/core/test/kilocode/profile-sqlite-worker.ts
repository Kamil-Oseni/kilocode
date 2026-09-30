import { writeFile } from "node:fs/promises"
import { Effect } from "effect"
import * as Client from "effect/unstable/sql/SqlClient"
import { layer } from "../../src/database/sqlite.bun"
import { Sqlite } from "../../src/database/sqlite"
import { init } from "../../../opencode/src/storage/db.bun"
import { closeProfileSqlite } from "../../src/kilocode/profile-sqlite"

const input = JSON.parse(process.argv[2]!) as { file: string; ready: string; release: string; mode: string }
const work = async (db: import("bun:sqlite").Database, managed = false) => {
  if (!managed) db.run("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000")
  db.run("CREATE TABLE IF NOT EXISTS fixture(value TEXT)")
  if (input.mode === "legacy-stress") {
    await writeFile(input.ready, String(process.pid))
    const stop = performance.now() + 5_000
    while (!(await Bun.file(input.release).exists())) {
      if (performance.now() >= stop) throw new Error("Fixture release deadline elapsed")
      try {
        db.run("INSERT INTO fixture VALUES ('racing')")
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("maintenance excludes")) throw error
      }
      await Bun.sleep(1)
    }
    return
  }
  db.run("INSERT INTO fixture VALUES ('existing')")
  const iterator = input.mode.endsWith("iterator") ? db.query("SELECT * FROM fixture").iterate() : undefined
  if (iterator) iterator.next()
  if (!iterator) {
    if (!managed) db.run("BEGIN")
    db.run("SAVEPOINT nested")
    db.run("INSERT INTO fixture VALUES ('pending')")
    db.run("RELEASE nested")
  }
  await writeFile(input.ready, String(process.pid))
  const stop = performance.now() + 5_000
  while (!(await Bun.file(input.release).exists())) {
    if (performance.now() >= stop) throw new Error("Fixture release deadline elapsed")
    await Bun.sleep(10)
  }
  if (iterator) iterator.return?.()
  if (!iterator && !managed) db.run("COMMIT")
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
        const db = (yield* Sqlite.Native) as import("bun:sqlite").Database
        if (input.mode === "effect-managed") {
          db.run("CREATE TABLE IF NOT EXISTS fixture(value TEXT)")
          const client = yield* Client.SqlClient
          yield* client.withTransaction(Effect.promise(() => work(db, true)))
          return
        }
        yield* Effect.promise(() => work(db))
      }).pipe(Effect.provide(layer({ filename: input.file }))),
    ),
  )
