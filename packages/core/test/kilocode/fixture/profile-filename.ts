import { existsSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { Database } from "../../../src/database/database"
import { databaseSnapshot, openDatabase, closeDatabase } from "../../../src/kilocode/profile-database"
import { profileSqlite, closeProfileSqlite } from "../../../src/kilocode/profile-sqlite"

const input = Schema.decodeUnknownSync(
  Schema.Struct({ alias: Schema.String, ready: Schema.String, release: Schema.String, mode: Schema.String }),
)(JSON.parse(process.argv[2]))
type Native = { exec(sql: string): unknown; prepare(sql: string): { get(): unknown }; close(): void }
function wait(file: string) {
  writeFileSync(input.ready, JSON.stringify({ file }))
  const deadline = performance.now() + 10_000
  while (!existsSync(input.release)) {
    if (performance.now() >= deadline) throw new Error("Canonical constructor release deadline elapsed")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

export async function run(open: (file: string) => Native) {
  if (input.mode === "layer") {
    const layer = Database.layerFromPath(input.alias)
    const file = databaseSnapshot(input.alias).root
    wait(file)
    const result = await Effect.runPromise(
      Effect.scoped(
        Database.Service.use((service) =>
          Effect.gen(function* () {
            yield* service.db.run("CREATE TABLE canonical_fixture(value TEXT)")
            yield* service.db.run("INSERT INTO canonical_fixture VALUES ('selected')")
            const row = yield* service.db.get("SELECT value FROM canonical_fixture")
            return { row, active: databaseSnapshot(file).instances.length }
          }),
        ).pipe(Effect.provide(layer)),
      ),
    )
    console.log(
      JSON.stringify({ file, result: result.row, active: result.active, owners: databaseSnapshot(file).instances }),
    )
    return
  }
  const create = (file: string) =>
    profileSqlite(file, (selected) => {
      wait(selected)
      return open(selected)
    })
  const db = input.mode === "core" ? openDatabase(input.alias, create) : create(input.alias)
  db.exec("CREATE TABLE canonical_fixture(value TEXT); INSERT INTO canonical_fixture VALUES ('selected')")
  const result = db.prepare("SELECT value FROM canonical_fixture").get()
  const file = Schema.decodeUnknownSync(Schema.Struct({ file: Schema.String }))(
    JSON.parse(await readFile(input.ready, "utf8")),
  ).file
  const active = databaseSnapshot(file).instances.length
  if (input.mode === "core") await closeDatabase(db)
  if (input.mode !== "core") await closeProfileSqlite(db)
  console.log(JSON.stringify({ file, result, active, owners: databaseSnapshot(file).instances }))
}
