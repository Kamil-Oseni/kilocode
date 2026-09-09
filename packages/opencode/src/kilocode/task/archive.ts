import { and, asc, desc, eq, gt, lt, notInArray, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineArchiveTable as Archive,
  RayaRoutineArchiveImportTable as Import,
} from "@opencode-ai/core/kilocode/archive.sql"

const entry = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  archived_at: Schema.Finite,
  definition: Schema.String,
})
type Entry = typeof entry.Type
const source = "filesystem-v1"
export class InvalidCursor extends Schema.TaggedErrorClass<InvalidCursor>()("RayaTaskArchive.InvalidCursor", {
  message: Schema.String,
}) {}

const validate = (input: Entry) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(entry)(input)
    const definition: unknown = yield* Effect.try({
      try: () => JSON.parse(input.definition),
      catch: () => new Error("Archived definition is not valid JSON."),
    })
    if (!definition || typeof definition !== "object" || !("id" in definition) || definition.id !== input.id)
      return yield* Effect.fail(new Error("Archived definition identity mismatch."))
    return input
  })

/** Mutating callers must hold the routine mutation gate; this store never edits the roster. */
export function archive(database: Database.Interface) {
  const db = database.db
  const ready = () => db.select().from(Import).where(eq(Import.id, source)).get().pipe(Effect.map(Boolean))
  const migrate = (entries: readonly Entry[]) =>
    db.transaction(
      (tx) =>
        Effect.gen(function* () {
          if (yield* tx.select().from(Import).where(eq(Import.id, source)).get()) return false
          const seen = new Set<string>()
          for (const input of entries) {
            const item = yield* validate(input)
            if (seen.has(item.id)) return yield* Effect.fail(new Error("Duplicate legacy archive identity."))
            seen.add(item.id)
            const prior = yield* tx.select().from(Archive).where(eq(Archive.id, item.id)).get()
            if (prior) {
              if (prior.archived_at !== item.archived_at || prior.definition !== item.definition)
                return yield* Effect.fail(new Error("Legacy archive conflicts with indexed evidence."))
              continue
            }
            yield* tx.insert(Archive).values(item).run()
          }
          yield* tx.insert(Import).values({ id: source, time_completed: Date.now() }).run()
          return true
        }),
      { behavior: "immediate" },
    )
  const put = (input: Entry) =>
    Effect.gen(function* () {
      const item = yield* validate(input)
      yield* db
        .insert(Archive)
        .values(item)
        .onConflictDoUpdate({
          target: Archive.id,
          set: { archived_at: item.archived_at, definition: item.definition },
        })
        .run()
    })
  const get = (id: string) => db.select().from(Archive).where(eq(Archive.id, id)).get()
  const occupied = () => db.select({ id: Archive.id }).from(Archive).limit(1).get().pipe(Effect.map(Boolean))
  const page = (input: { cursor?: string; agentID?: string; excluded: readonly string[] }) =>
    Effect.gen(function* () {
      if (input.cursor !== undefined && input.agentID !== undefined)
        return yield* new InvalidCursor({ message: "Choose an archive page or a routine, not both." })
      const visible = input.excluded.length ? notInArray(Archive.id, [...input.excluded]) : undefined
      if (input.agentID !== undefined) {
        const item = yield* db
          .select()
          .from(Archive)
          .where(and(visible, eq(Archive.id, input.agentID)))
          .get()
        return { items: item ? [item] : [] }
      }
      const anchor = input.cursor === undefined ? undefined : yield* get(input.cursor)
      if (input.cursor !== undefined && (!anchor || input.excluded.includes(input.cursor)))
        return yield* new InvalidCursor({ message: "The archive page is no longer available. Refresh the archive." })
      const rows = yield* db
        .select()
        .from(Archive)
        .where(
          and(
            visible,
            anchor
              ? or(
                  lt(Archive.archived_at, anchor.archived_at),
                  and(eq(Archive.archived_at, anchor.archived_at), gt(Archive.id, anchor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(Archive.archived_at), asc(Archive.id))
        .limit(51)
        .all()
      return { items: rows.slice(0, 50), ...(rows.length > 50 ? { next: rows[49].id } : {}) }
    })
  return { ready, migrate, put, get, page, occupied }
}
