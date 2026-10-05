import type { Database } from "bun:sqlite"

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** Native preflight bounds allocation before materializing selected SQL rows. */
export function measure(db: Database, table: string, columns: readonly string[]) {
  if (!columns.length || columns.length > 256) throw new Error("Portable SQL column count exceeds its bound")
  const values = columns.map((column) => `COALESCE(length(CAST(${quote(column)} AS BLOB)),0)`)
  const cell = values.length === 1 ? values[0] : `max(${values.join(",")})`
  const size = db
    .query<
      { rows: number; cell: number },
      []
    >(`SELECT count(*) AS rows, COALESCE(max(${cell}),0) AS cell FROM ${quote(table)}`)
    .get()!
  if (
    !Number.isSafeInteger(size.rows) ||
    size.rows > 1_000_000 ||
    !Number.isSafeInteger(size.cell) ||
    size.cell > 16_777_216
  )
    throw new Error("Portable SQL row or cell size exceeds its bound")
  const bytes = db
    .query<
      { bytes: number },
      []
    >(`SELECT COALESCE(sum(length(CAST(json_array(${columns.map(quote).join(",")}) AS BLOB))),0) AS bytes FROM ${quote(table)}`)
    .get()!.bytes
  const result = bytes + size.rows + Buffer.byteLength(JSON.stringify({ table, columns, rows: [] }))
  if (!Number.isSafeInteger(result) || result > 128 * 1024 * 1024)
    throw new Error("Portable SQL exceeds the supported bundle size")
  return result
}
