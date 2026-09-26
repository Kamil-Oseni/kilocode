import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"
import { scrub } from "../../kilocode/desktop-frame-retention"

export default {
  id: "20260926010000_kilocode-private-desktop-frames",
  up(tx) {
    return Effect.gen(function* () {
      let cursor = ""
      while (true) {
        const rows = yield* tx.all<{ id: string; data: string }>(
          sql`SELECT id, data FROM part WHERE id > ${cursor} AND CASE WHEN json_valid(data) THEN json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') GLOB 'desktop_*' ELSE 0 END ORDER BY id LIMIT 1`,
        )
        if (!rows.length) return
        for (const row of rows) {
          const data = JSON.parse(row.data) as unknown
          const next = scrub(data)
          if (JSON.stringify(next) === JSON.stringify(data)) continue
          yield* tx.run(sql`UPDATE part SET data = ${JSON.stringify(next)} WHERE id = ${row.id}`)
        }
        cursor = rows.at(-1)!.id
      }
    })
  },
} satisfies DatabaseMigration.Migration
