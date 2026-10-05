import assert from "node:assert/strict"
import { allocator } from "../../../src/kilocode/migration/profile-sql-allocator-schema"
import { semantic } from "../../../src/kilocode/migration/profile-sql-correspondence"

export function assertAllocatorSource(value: { disposition?: { files: readonly { disposition: unknown }[] } }) {
  const groups =
    value.disposition?.files.flatMap((file) => {
      const parsed = semantic.safeParse(file.disposition)
      return parsed.success && parsed.data.component === "sql" ? [parsed.data] : []
    }) ?? []
  assert(groups.length > 0)
  assert.equal(new Set(groups.map((group) => JSON.stringify(group))).size, 1)
  const group = groups[0]
  const metadata = allocator.parse(group.allocator)
  const table = group.tables.find((table) => table.table === "sqlite_sequence")
  assert.equal(table?.disposition, "inactive-allocator-counters")
  assert.equal(table.rows, metadata.rows.length)
  assert.equal(metadata.schema, group.schema)
  assert.equal(metadata.installation, false)
  return { rows: metadata.rows, schema: metadata.schema, generation: metadata.generation, digest: metadata.digest }
}
