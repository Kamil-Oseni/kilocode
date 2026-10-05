import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { Effect, ManagedRuntime } from "effect"
import z from "zod"
import { tables } from "./profile-bundle"
import { identity, references } from "./profile-workspaces"
import { measure } from "./profile-sql"
import { evidence } from "./profile-exports"
import { Storage } from "../session-export/worker/storage"
import { assertWorking, type Working } from "./profile-image"
import { restoreOutputs } from "./profile-outputs"
import { restoreNotes } from "./profile-notes"
import { projectStores } from "./profile-store-projection"
import path from "node:path"

import { schema } from "./profile-store-schema"
const { stores, sql } = schema(tables)
export { stores }
type Shape = { type: string; name: string; tbl_name: string; sql: string | null }
const query = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const normalize = (rows: readonly Shape[]) => rows.map((row) => ({ ...row, sql: row.sql?.trim() ?? null }))
let expected: Promise<{ main: readonly Shape[]; exports: readonly Shape[] }> | undefined
async function shipped() {
  return (expected ??= (async () => {
    const { Database: Core } = await import("@opencode-ai/core/database/database")
    const runtime = ManagedRuntime.make(Core.layerFromPath(":memory:"))
    const main = await runtime
      .runPromise(
        Effect.gen(function* () {
          const db = (yield* Core.Service).db
          return yield* db.all<Shape>(query)
        }),
      )
      .finally(() => runtime.dispose())
    const worker = new Storage(":memory:")
    try {
      worker.migrate()
      const descriptor = z.instanceof(Database).parse(Reflect.get(worker, "sqlite"))
      return { main: normalize(main), exports: normalize(descriptor.query<Shape, []>(query).all()) }
    } finally {
      worker.close()
    }
  })())
}

/** Full shipped sqlite_master comparison, never a filename or partial-column fingerprint. */
export async function classify(file: string) {
  const reference = await shipped()
  const db = new Database(file, { readonly: true, strict: true })
  try {
    const size = db
      .query<
        { rows: number; bytes: number },
        []
      >("SELECT count(*) AS rows, COALESCE(sum(length(sql)),0) AS bytes FROM sqlite_master")
      .get()
    if (!size || size.rows > 256 || size.bytes > 1_048_576)
      throw new Error("Acknowledged SQLite schema exceeds supported bounds")
    const shape = normalize(db.query<Shape, []>(query).all())
    if (!shape.length) return { kind: "empty" as const, schema: digest(shape) }
    if (JSON.stringify(shape) === JSON.stringify(reference.main))
      return { kind: "raya" as const, schema: digest(shape) }
    if (JSON.stringify(shape) === JSON.stringify(reference.exports))
      return { kind: "session-export" as const, schema: digest(shape) }
    throw new Error("Acknowledged SQLite store has an unsupported full schema")
  } finally {
    db.close()
  }
}

/** Reads only recovered stores bound to the live held image. All native sizes are preflighted before row materialization. */
export async function collectStores(token: Working, primary: string, auxiliary?: string) {
  const image = assertWorking(token)
  const inventory = image.stores
  const plans = []
  let bytes = 0
  for (const item of inventory) {
    assertWorking(token)
    if (!item.present) {
      plans.push({ item, kind: "absent" as const })
      continue
    }
    if (!item.staged) throw new Error("Present SQLite store has no recovered image")
    const category = await classify(item.staged)
    if (identity(item.original) === identity(primary) && category.kind !== "raya")
      throw new Error("Primary SQLite store does not have the shipped Raya schema")
    if (auxiliary && identity(item.original) === identity(auxiliary) && category.kind !== "session-export")
      throw new Error("Selected export store does not have the shipped export schema")
    if (category.kind === "raya") {
      const db = new Database(item.staged, { readonly: true, strict: true })
      try {
        for (const table of tables) {
          const columns = db
            .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
            .all()
            .map((column) => column.name)
          bytes += measure(db, table, columns)
        }
      } finally {
        db.close()
      }
    }
    if (category.kind === "session-export") {
      const db = new Database(item.staged, { readonly: true, strict: true })
      try {
        const size = db
          .query<
            { bytes: number },
            []
          >("SELECT COALESCE((SELECT SUM(length(data_json)) FROM event),0) + COALESCE((SELECT SUM(length(bytes)) FROM chunk),0) AS bytes")
          .get()
        if (!size || !Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.bytes > 50_331_648)
          throw new Error("Export store native bytes exceed bounds")
        bytes += Math.ceil((size.bytes * 4) / 3)
      } finally {
        db.close()
      }
    }
    if (bytes > 128 * 1024 * 1024) throw new Error("Combined SQLite stores exceed bundle bounds")
    plans.push({ item, ...category })
  }
  const result = []
  for (const plan of plans) {
    const source = plan.item.original
    if (identity(source) === identity(primary) || (auxiliary && identity(source) === identity(auxiliary))) continue
    const id = digest({ source: identity(source), schema: plan.kind === "absent" ? "absent" : plan.schema })
    if (plan.kind === "absent") {
      result.push({ kind: plan.kind, id, source })
      continue
    }
    if (plan.kind === "empty") {
      result.push({ kind: plan.kind, id, source, schema: plan.schema })
      continue
    }
    const file = plan.item.staged
    if (!file) throw new Error("SQLite store lost recovered image")
    if (plan.kind === "session-export") {
      const value = await evidence(file)
      if (!value) throw new Error("Recovered store disappeared")
      result.push({ kind: plan.kind, id, source, schema: plan.schema, evidence: value })
      continue
    }
    const db = new Database(file, { readonly: true, strict: true })
    try {
      const rows = sql.parse(
        tables.map((table) => ({
          table,
          columns: db
            .query<{ name: string }, []>(`PRAGMA table_info('${table}')`)
            .all()
            .map((column) => column.name),
          rows: db.query(`SELECT * FROM "${table}"`).values(),
        })),
      )
      result.push({ kind: plan.kind, id, source, schema: plan.schema, sql: rows, workspaces: references(rows).sort() })
    } finally {
      db.close()
    }
  }
  assertWorking(token)
  return stores.parse(result)
}

/** Inactive independent graph evidence only; no additional SQLite file or execution owner is created. */
export async function restoreStores(
  source: import("zod").z.output<typeof import("./profile-bundle").payload>,
  mapping: ReadonlyMap<string, string>,
  now: number,
  stage?: string,
  destination?: string,
) {
  if (!source.stores) return undefined
  for (const store of source.stores) {
    if (store.kind !== "raya" || !store.content) continue
    if (!stage || !destination) throw new Error("Independent content requires inactive destination staging")
    const directory = path.join(stage, "restore-store-content", store.id)
    const target = path.join(destination, "restore-store-content", store.id)
    // Files stay inactive; no independent database or execution owner is created.
    await restoreOutputs(store.content.outputs, directory, target, store.sql)
    await restoreNotes(store.content.notes, directory, target, mapping, store.sql)
  }
  return stores.parse(projectStores(source, mapping, now))
}
