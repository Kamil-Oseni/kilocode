import type { Database } from "bun:sqlite"
import { allocator, declaration, hash, normalize } from "./profile-sql-allocator-schema"

/** Called only after full shipped graph classification; source counters never become destination authority. */
export function captureAllocator(db: Database, schema: string) {
  const targets = db
    .query<
      { name: string; sql: string },
      []
    >("SELECT name,sql FROM sqlite_master WHERE type='table' AND upper(sql) LIKE '%AUTOINCREMENT%' ORDER BY name")
    .all()
  if (
    targets.length !== 1 ||
    targets[0].name !== "raya_composer_draft" ||
    normalize(targets[0].sql) !== normalize(declaration)
  )
    return undefined
  const count = db.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_sequence").get()?.count
  if (count === undefined || count > 1) return undefined
  const highwater = db
    .query<{ value: number }, []>("SELECT COALESCE(MAX(sequence),0) AS value FROM raya_composer_draft")
    .get()?.value
  const rows = db
    .query<{ name: unknown; seq: unknown }, []>("SELECT name,seq FROM sqlite_sequence ORDER BY name")
    .all()
    .map((row) => ({ ...row, highwater }))
  const parsed = allocator.safeParse({
    format: "raya.inactive-sqlite-allocator",
    version: 1,
    schema,
    generation: hash(normalize(declaration)),
    rows,
    digest: hash(rows),
    activation: "inert",
    installation: false,
  })
  if (!parsed.success || (rows.length === 0 && highwater !== 0)) return undefined
  return parsed.data
}
