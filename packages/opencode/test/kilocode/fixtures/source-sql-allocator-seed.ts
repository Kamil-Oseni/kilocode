import { Effect } from "effect"
import { Database as Core } from "@opencode-ai/core/database/database"

/** Actual shipped writer rows exercise a deleted high-water ID without retained draft content. */
export const seedAllocator = Effect.gen(function* () {
  const db = (yield* Core.Service).db
  yield* db.run(
    "INSERT INTO raya_composer_draft(id,workspace,project,box,record,content_bytes,metadata_bytes) VALUES ('allocator_fixture_deleted','','','','{}',2,0)",
  )
  yield* db.run("DELETE FROM raya_composer_draft WHERE id='allocator_fixture_deleted'")
  const rows = yield* db.all<{ name: string; seq: number }>("SELECT name,seq FROM sqlite_sequence")
  const highwater = yield* db.all<{ value: number }>(
    "SELECT COALESCE(MAX(sequence),0) AS value FROM raya_composer_draft",
  )
  return { rows, highwater: highwater[0].value }
})
