import { writeFile } from "node:fs/promises"
import { Effect, ManagedRuntime, Schema } from "effect"
import { Database } from "bun:sqlite"
import { layer } from "../../src/database/sqlite.bun"
import { Sqlite } from "../../src/database/sqlite"
import { init } from "../../../opencode/src/storage/db.bun"
import { createSequencer } from "../../../opencode/src/kilocode/session-export/sequence"
import { Storage } from "../../../opencode/src/kilocode/session-export/worker/storage"
import { closeProfileSqlite, profileSqlite } from "../../src/kilocode/profile-sqlite"

const input = Schema.decodeUnknownSync(
  Schema.Struct({ file: Schema.String, ready: Schema.String, release: Schema.String, mode: Schema.String }),
)(JSON.parse(process.argv[2]))
const wait = async () => {
  await writeFile(input.ready, String(process.pid))
  const deadline = performance.now() + 10_000
  while (!(await Bun.file(input.release).exists())) {
    if (performance.now() >= deadline) throw new Error("Native fixture release deadline elapsed")
    await Bun.sleep(10)
  }
}
async function run() {
  if (input.mode === "graphs") {
    const first = ManagedRuntime.make(layer({ filename: input.file }))
    const second = ManagedRuntime.make(layer({ filename: input.file }))
    const unused = ManagedRuntime.make(layer({ filename: input.file + ".unused" }))
    await first.runPromise(Sqlite.Native)
    await second.runPromise(Sqlite.Native)
    await wait()
    await Promise.all([first.dispose(), second.dispose(), unused.dispose()])
    return
  }
  if (input.mode === "core")
    return Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Sqlite.Native
          yield* Effect.promise(wait)
        }).pipe(Effect.provide(layer({ filename: input.file }))),
      ),
    )
  const db =
    input.mode === "legacy"
      ? init(input.file).$client
      : input.mode === "sequence"
        ? createSequencer(input.file)
        : input.mode === "export"
          ? new Storage(input.file)
          : profileSqlite(input.file, () => new Database(input.file, { create: true }))
  if (input.mode === "transaction") {
    if (!(db instanceof Database)) throw new Error("Transaction fixture requires the native database")
    db.run("CREATE TABLE fixture(value TEXT); BEGIN; INSERT INTO fixture VALUES ('settled')")
    await wait()
    db.run("COMMIT")
    await closeProfileSqlite(db)
    return
  }
  await wait()
  db.close()
}
await run()
