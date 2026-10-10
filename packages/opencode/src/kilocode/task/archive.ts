import { and, asc, desc, eq, gt, lt, lte, notInArray, or, sql } from "drizzle-orm"
import { definition as cap } from "./capacity"
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
    if (Buffer.byteLength(input.definition) > cap)
      return yield* Effect.fail(
        new Error(
          "Archived definition exceeds 16 MiB. Preserve the saved evidence and review its size before retrying.",
        ),
      )
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
            const held = yield* tx.select(metadata()).from(Archive).where(eq(Archive.id, item.id)).get()
            if (held) {
              if (held.bytes > cap)
                return yield* Effect.fail(
                  new Error(
                    "Archived definition exceeds 16 MiB. Preserve the saved evidence and review its size before retrying.",
                  ),
                )
              const prior = yield* tx
                .select()
                .from(Archive)
                .where(and(eq(Archive.id, item.id), lte(size, cap)))
                .get()
              if (!prior || prior.archived_at !== item.archived_at || prior.definition !== item.definition)
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
  const size = sql<number>`length(cast(${Archive.definition} as blob))`
  const identity = sql<number>`length(cast(${Archive.id} as blob))`
  const metadata = (remaining = cap) => ({
    id: sql<string | null>`case when ${identity} <= ${remaining} then ${Archive.id} else null end`,
    archived_at: Archive.archived_at,
    bytes: size,
    identity,
  })
  const lookup = (id: string) => db.select(metadata()).from(Archive).where(eq(Archive.id, id)).get()
  const used = (id: string) => lookup(id).pipe(Effect.map(Boolean))
  const load = (item: { id: string | null; archived_at: number; bytes: number }) =>
    Effect.gen(function* () {
      if (item.id === null)
        return yield* Effect.fail(
          new Error(
            "Archived identity exceeds 16 MiB. Preserve the saved evidence and review its size before retrying.",
          ),
        )
      if (item.bytes > cap)
        return yield* Effect.fail(
          new Error(
            "Archived definition exceeds 16 MiB. Preserve the saved evidence and review its size before retrying.",
          ),
        )
      const row = yield* db
        .select()
        .from(Archive)
        .where(
          and(eq(Archive.id, item.id), eq(Archive.archived_at, item.archived_at), eq(size, item.bytes), lte(size, cap)),
        )
        .get()
      if (!row) return yield* Effect.fail(new Error("Archived definition changed while reading. Refresh the archive."))
      return row
    })
  const get = (id: string) =>
    Effect.gen(function* () {
      const item = yield* lookup(id)
      return item ? yield* load(item) : undefined
    })
  const occupied = () =>
    db
      .select({ present: sql<number>`1` })
      .from(Archive)
      .limit(1)
      .get()
      .pipe(Effect.map(Boolean))
  const page = (input: { cursor?: string; agentID?: string; excluded: readonly string[] }) =>
    Effect.gen(function* () {
      if (input.cursor !== undefined && input.agentID !== undefined)
        return yield* new InvalidCursor({ message: "Choose an archive page or a routine, not both." })
      const visible = input.excluded.length ? notInArray(Archive.id, [...input.excluded]) : undefined
      if (input.agentID !== undefined) {
        const item = yield* db
          .select(metadata())
          .from(Archive)
          .where(and(visible, eq(Archive.id, input.agentID)))
          .get()
        return { items: item ? [yield* load(item)] : [] }
      }
      const held =
        input.cursor === undefined
          ? undefined
          : yield* db.select(metadata(0)).from(Archive).where(eq(Archive.id, input.cursor)).get()
      const anchor = held && input.cursor !== undefined ? { ...held, id: input.cursor } : undefined
      if (input.cursor !== undefined && (!anchor || input.excluded.includes(input.cursor)))
        return yield* new InvalidCursor({ message: "The archive page is no longer available. Refresh the archive." })
      if (anchor && anchor.identity > cap)
        return yield* Effect.fail(
          new Error(
            "Archived identity exceeds 16 MiB. Preserve the saved evidence and review its size before retrying.",
          ),
        )
      const after = (item: { id: string | null; archived_at: number } | undefined) =>
        and(
          visible,
          item
            ? or(
                lt(Archive.archived_at, item.archived_at),
                and(eq(Archive.archived_at, item.archived_at), gt(Archive.id, item.id!)),
              )
            : undefined,
        )
      const items: Entry[] = []
      let bytes = 0
      let ids = 0
      let cursor: { id: string | null; archived_at: number } | undefined = anchor
      let more = false
      while (items.length < 50) {
        const item = yield* db
          .select(metadata(cap - ids))
          .from(Archive)
          .where(after(cursor))
          .orderBy(desc(Archive.archived_at), asc(Archive.id))
          .limit(1)
          .get()
        if (!item) break
        if (item.identity > cap)
          return yield* Effect.fail(
            new Error(
              "Archived identity exceeds 16 MiB. Preserve the saved evidence and review its size before retrying.",
            ),
          )
        if (item.bytes > cap) yield* load(item)
        if (item.id === null || bytes + item.bytes > cap) {
          if (!items.length)
            return yield* Effect.fail(
              new Error(
                "Archived page exceeds its byte capacity. Preserve the saved evidence and review its size before retrying.",
              ),
            )
          more = true
          break
        }
        items.push(yield* load(item))
        bytes += item.bytes
        ids += item.identity
        cursor = item
      }
      if (items.length === 50)
        more = !!(yield* db
          .select({ present: sql<number>`1` })
          .from(Archive)
          .where(after(cursor))
          .limit(1)
          .get())
      return { items, ...(more ? { next: items[items.length - 1].id } : {}) }
    })
  return { ready, migrate, put, get, used, page, occupied }
}
