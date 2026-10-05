import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { payload, seal, snapshot, tables } from "@/kilocode/migration/profile-bundle"
import { restore, signature, type Column } from "@/kilocode/migration/profile-restore"
import { finish } from "@/kilocode/cli/finish"
import { seedAllocator } from "./source-sql-allocator-seed"

async function main() {
  const root = process.argv[2]
  assert(root && path.isAbsolute(root))
  const file = process.argv[3] === "--seed" ? process.argv[4] : path.join(root, "shipped.db")
  assert(file && path.isAbsolute(file))
  if (process.argv[3] === "--seed")
    await Effect.runPromise(seedAllocator.pipe(Effect.provide(Database.layerFromPath(file))))
  const sql = await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const schema = yield* signature((query) => database.db.all<Column>(query))
      const values = yield* Effect.forEach(tables, (table) =>
        Effect.gen(function* () {
          const columns = yield* database.db.all<Column>(`PRAGMA table_info('${table}')`)
          return { table, columns: columns.map((column) => column.name), rows: [] }
        }),
      )
      return { schema, sql: payload.shape.sql.parse(values) }
    }).pipe(Effect.provide(Database.layerFromPath(file))),
  )
  if (process.argv[3] === "--seed") {
    await writeFile(path.join(root, "seed-sql.json"), JSON.stringify(sql))
    return finish([])
  }
  const input = payload.parse(JSON.parse(await readFile(path.join(root, "input.json"), "utf8")))
  const original = payload.parse({ ...input, ...sql })
  const password = "private synthetic restored component codec fixture"
  const first = await restore(await seal(original, password), password, path.join(root, "first"), {})
  const { archives, ...current } = original
  const next = payload.parse({ ...original, id: crypto.randomUUID(), archives: [...archives, snapshot.parse(current)] })
  const second = await restore(await seal(next, password), password, path.join(root, "second"), {})
  await writeFile(path.join(root, "restored.json"), JSON.stringify({ first: first.path, second: second.path }))
  await finish([])
}
await main()
