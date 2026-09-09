import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { archive } from "@/kilocode/task/archive"
import { tmpdir } from "../fixture/fixture"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>, filename = ":memory:") =>
  Effect.runPromise(effect.pipe(Effect.provide(Database.layerFromPath(filename))))
const entry = (id: string, at = 1000) => ({
  id,
  archived_at: at,
  definition: JSON.stringify({ id, objective: `Work for ${id}` }),
})

test("legacy import rolls back partial rows and its checkpoint, then resumes once after reopening", async () => {
  await using directory = await tmpdir()
  const filename = path.join(directory.path, "archive.sqlite")
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const store = archive(database)
        expect(yield* store.ready()).toBe(false)
        expect(
          Exit.isFailure(
            yield* store
              .migrate([entry("first"), { ...entry("second"), definition: '{"id":"wrong"}' }])
              .pipe(Effect.exit),
          ),
        ).toBe(true)
        expect(yield* store.get("first")).toBeUndefined()
        expect(yield* store.ready()).toBe(false)
        expect(Exit.isFailure(yield* store.migrate([entry("first"), entry("first")]).pipe(Effect.exit))).toBe(true)
        expect(yield* store.get("first")).toBeUndefined()
        expect(yield* store.migrate([entry("first"), entry("second")])).toBe(true)
      }),
    ),
    filename,
  )
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const store = archive(database)
        expect(yield* store.ready()).toBe(true)
        expect(yield* store.get("first")).toEqual(entry("first"))
        yield* store.put(entry("first", 2000))
        expect(yield* store.migrate([entry("first")])).toBe(false)
        expect(yield* store.get("first")).toEqual(entry("first", 2000))
        expect((yield* store.page({ excluded: [] })).items.map((item) => item.id)).toEqual(["first", "second"])
      }),
    ),
    filename,
  )
}, 30_000)

test("conflicting indexed evidence prevents import without replacing either record", async () => {
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const store = archive(database)
        yield* store.put(entry("existing", 2000))
        expect(Exit.isFailure(yield* store.migrate([entry("new"), entry("existing")]).pipe(Effect.exit))).toBe(true)
        expect(yield* store.get("new")).toBeUndefined()
        expect(yield* store.get("existing")).toEqual(entry("existing", 2000))
        expect(yield* store.ready()).toBe(false)
      }),
    ),
  )
})

test("indexed archive pages exclude live IDs, preserve anchors and use the ordering index", async () => {
  await run(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const store = archive(database)
        const entries = Array.from({ length: 53 }, (_, index) => entry(`archive-${String(index).padStart(2, "0")}`))
        yield* store.migrate(entries)
        const first = yield* store.page({ excluded: ["archive-00"] })
        expect(first.items).toHaveLength(50)
        expect(first.items[0].id).toBe("archive-01")
        expect(first.next).toBe("archive-50")
        yield* store.put(entry("newer", 2000))
        const second = yield* store.page({ excluded: ["archive-00"], cursor: first.next })
        expect(second.items.map((item) => item.id)).toEqual(["archive-51", "archive-52"])
        expect(second.next).toBeUndefined()
        expect((yield* store.page({ excluded: [], agentID: "archive-52" })).items).toEqual([entry("archive-52")])
        expect((yield* store.page({ excluded: ["archive-52"], agentID: "archive-52" })).items).toEqual([])
        expect(Exit.isFailure(yield* store.page({ excluded: [], cursor: "missing" }).pipe(Effect.exit))).toBe(true)
        expect(
          Exit.isFailure(yield* store.page({ excluded: ["archive-50"], cursor: "archive-50" }).pipe(Effect.exit)),
        ).toBe(true)
        const plan = yield* database.db.all<{ detail: string }>(
          sql`EXPLAIN QUERY PLAN SELECT * FROM raya_routine_archive WHERE archived_at < 1000 OR (archived_at = 1000 AND id > 'archive-50') ORDER BY archived_at DESC, id ASC LIMIT 51`,
        )
        expect(plan.some((row) => row.detail.includes("raya_routine_archive_order"))).toBe(true)
        expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
      }),
    ),
  )
})
