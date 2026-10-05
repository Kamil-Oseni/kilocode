import { unlink } from "node:fs/promises"
import path from "node:path"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ProfileRoots } from "@opencode-ai/core/kilocode/profile-roots"
import { sql } from "drizzle-orm"

const file = process.env.RAYA_TEST_HISTORICAL_SQLITE
if (!file) throw new Error("Historical SQLite fixture requires an explicit private path")
const runtime = ManagedRuntime.make(Database.layerFromPath(file))
try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.all("SELECT name FROM sqlite_master ORDER BY name")
    }),
  )
} finally {
  await runtime.dispose()
}
for (const suffix of ["", "-wal", "-shm"])
  await unlink(file + suffix).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return
    throw err
  })
const evidence = process.env.RAYA_TEST_EVIDENCE
if (!evidence || !path.isAbsolute(evidence))
  throw new Error("Historical SQLite fixture requires private witness directory")
await Bun.write(
  path.join(evidence, "historical-sqlite.json"),
  JSON.stringify({ file, roots: ProfileRoots.snapshot(), closed: true }),
)
const primary = process.env.RAYA_DB
if (!primary) throw new Error("Synthetic SQL correspondence seed requires private database")
const seeded = ManagedRuntime.make(Database.layerFromPath(primary))
try {
  await seeded.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db.run(
        sql`INSERT INTO credential (id,label,value,time_created,time_updated) VALUES ('correspondence-fixture','Private synthetic seed','{"apiKey":"SYNTHETIC_SQL_CREDENTIAL_SENTINEL"}',1,1)`,
      )
      yield* db.run(
        sql`INSERT INTO raya_contact_destination (id,source,channel,address,scope,scope_id,revision,enabled,time_created,time_updated) VALUES ('private-correspondence-contact','private-correspondence-source','raya','private-fixture-inbox','global','',1,1,1,1)`,
      )
    }),
  )
} finally {
  await seeded.dispose()
}
