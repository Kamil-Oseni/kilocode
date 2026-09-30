import { expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RayaComposerControlTable as Control, RayaComposerTable as Rows } from "@opencode-ai/core/kilocode/composer.sql"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Git } from "@/git"
import { Storage } from "@/storage/storage"
import {
  composerDrafts,
  type DraftContent,
  type DraftIdentity,
  type DraftEntry,
} from "@/kilocode/session/composer-drafts"
import { composerRetention } from "@/kilocode/session/composer-retention"
import { tmpdir } from "../fixture/fixture"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"

const content: DraftContent = {
  text: "  Violin 🎻\n你好  ",
  comments: [],
  images: [
    { id: "file", filename: "practice.txt", mime: "text/plain", dataUrl: "data:text/plain;base64,cHJhY3RpY2UK" },
  ],
  scroll: 4,
  model: { providerID: "local", modelID: "9b" },
  agent: "build",
  variant: "medium",
  selection: { start: 2, end: 7 },
}
const identity = (root: string, id = "pending"): DraftIdentity => ({
  key: id,
  box: "prompt:default",
  workspace: root,
  projectID: "project",
  pendingID: id,
})
function fixture(root: string) {
  const dir = path.join(root, "storage")
  const file = path.join(root, "composer.sqlite")
  const layers = Layer.mergeAll(Storage.layerFromDir(dir), Database.layerFromPath(file)).pipe(
    Layer.provide(LayerNode.compile(LayerNode.group([FSUtil.node, Git.node, CrossSpawnSpawner.node]))),
  )
  const run = <A, E>(
    body: (
      drafts: ReturnType<typeof composerRetention>,
      store: Storage.Interface,
      database: Database.Interface,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Storage.Service
        const database = yield* Database.Service
        return yield* body(composerRetention(database, store, dir, file), store, database)
      }).pipe(Effect.provide(layers)),
    )
  return { dir, file, run }
}

test("hundreds of accepted new chats retain CAS membership and replay after reopening", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  const first = await data.run((drafts) =>
    Effect.gen(function* () {
      let initial: DraftEntry | undefined
      for (let index = 0; index < 300; index++) {
        const pending = identity(tmp.path, `pending-${index}`)
        const target = { ...pending, key: `session-${index}`, pendingID: undefined, sessionID: `session-${index}` }
        const saved = yield* drafts.save(pending, undefined, content, `save-${index}`)
        const moved = yield* drafts.promote(pending, target, saved.token, undefined, `move-${index}`)
        const cleared = yield* drafts.clear(target, moved.target.token, `clear-${index}`)
        if (index === 0) initial = cleared
      }
      expect(yield* drafts.save(identity(tmp.path, "after-300"), undefined, content, "after")).toBeDefined()
      return initial
    }).pipe(Effect.timeout("55 seconds")),
  )
  expect(first).toBeDefined()
  await data.run((drafts) =>
    Effect.gen(function* () {
      const target = {
        ...identity(tmp.path, "pending-0"),
        key: "session-0",
        pendingID: undefined,
        sessionID: "session-0",
      }
      expect(yield* drafts.load(target)).toEqual(first)
      expect(Exit.isFailure(yield* drafts.save(target, undefined, content, "stale").pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(
          yield* drafts.save(identity(tmp.path, "pending-0"), undefined, content, "stale-pending").pipe(Effect.exit),
        ),
      ).toBe(true)
      const stored = yield* drafts.load(identity(tmp.path, "after-300"))
      if (!stored) throw new Error("Expected retained live draft")
      expect(yield* drafts.save(identity(tmp.path, "after-300"), undefined, content, "after")).toEqual(stored)
      const entries: DraftEntry[] = []
      let cursor: string | undefined
      do {
        const page = yield* drafts.page(
          { workspace: tmp.path, projectID: "project", box: "prompt:default" },
          { cursor, limit: 100 },
        )
        entries.push(...page.entries)
        cursor = page.cursor
      } while (cursor)
      expect(entries).toHaveLength(601)
      const expected = new Set([
        "after-300",
        ...Array.from({ length: 300 }, (_, index) => [`pending-${index}`, `session-${index}`]).flat(),
      ])
      expect(new Set(entries.map((entry) => entry.identity.key))).toEqual(expected)
      expect(entries.filter((entry) => entry.content === null)).toHaveLength(600)
      expect(entries.filter((entry) => entry.content !== null).map((entry) => entry.content)).toEqual([content])
    }),
  )
}, 60_000)

test("cutover preserves exact legacy bytes, receipt and tokens and fences old writers", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  const who = identity(tmp.path)
  const prior = await data.run((_drafts, store) =>
    composerDrafts(store, data.dir).save(who, undefined, content, "legacy"),
  )
  const source = path.join(data.dir, "raya", "composer-drafts.json")
  const raw = ` \n${await readFile(source, "utf8")}\n\t`
  await writeFile(source, raw)
  await data.run((drafts, store, database) =>
    Effect.gen(function* () {
      expect(yield* drafts.load(who)).toEqual(prior)
      expect(yield* drafts.save(who, undefined, content, "legacy")).toEqual(prior)
      const journal = yield* database.db.select().from(Control).get()
      expect(journal?.source).toBe(raw)
      expect(journal?.phase).toBe("active")
      expect(
        Exit.isFailure(
          yield* composerDrafts(store, data.dir).save(who, prior.token, content, "old-binary").pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )
}, 30_000)

for (const stage of ["imported", "source-retired", "verified"]) {
  test(`cutover resumes the durable ${stage} boundary after reopening`, async () => {
    await using tmp = await tmpdir()
    const data = fixture(tmp.path)
    const who = identity(tmp.path)
    const prior = await data.run((_drafts, store) =>
      composerDrafts(store, data.dir).save(who, undefined, content, "legacy"),
    )
    await data.run((_drafts, store, database) =>
      Effect.gen(function* () {
        const interrupted = composerRetention(database, store, data.dir, data.file, {
          checkpoint: (current) =>
            Effect.sync(() => {
              if (current === stage) throw new Error("Fixture crash boundary")
            }),
        })
        expect(Exit.isFailure(yield* interrupted.load(who).pipe(Effect.exit))).toBe(true)
        expect((yield* database.db.select().from(Control).get())?.phase).toBe("pending")
      }),
    )
    expect(await data.run((drafts) => drafts.load(who))).toEqual(prior)
  }, 30_000)
}

test("changed source and missing initialized document refuse without replacing evidence", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  const who = identity(tmp.path)
  await data.run((_drafts, store) => composerDrafts(store, data.dir).save(who, undefined, content, "legacy"))
  await data.run((_drafts, store, database) =>
    Effect.gen(function* () {
      const interrupted = composerRetention(database, store, data.dir, data.file, {
        checkpoint: () =>
          Effect.sync(() => {
            throw new Error("Pause")
          }),
      })
      expect(Exit.isFailure(yield* interrupted.load(who).pipe(Effect.exit))).toBe(true)
    }),
  )
  const source = path.join(data.dir, "raya", "composer-drafts.json")
  const before = await readFile(source, "utf8")
  const changed = before + " "
  await writeFile(source, changed)
  await data.run((drafts, _store, database) =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* drafts.load(who).pipe(Effect.exit))).toBe(true)
      expect((yield* database.db.select().from(Control).get())?.source).toBe(before)
      expect((yield* database.db.select().from(Control).get())?.phase).toBe("pending")
    }),
  )
  expect(await readFile(source, "utf8")).toBe(changed)
  await rm(source)
  await data.run((drafts) =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* drafts.load(who).pipe(Effect.exit))).toBe(true)
    }),
  )
}, 30_000)

test("immutable scoped pagination retains rows across clear and excludes later insertions until refresh", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  await data.run((drafts) =>
    Effect.gen(function* () {
      const scope = { workspace: tmp.path, projectID: "project", box: "prompt:default" }
      for (let index = 0; index < 125; index++)
        yield* drafts.save(identity(tmp.path, `page-${index}`), undefined, content, `page-${index}`)
      const first = yield* drafts.page(scope, { limit: 17 })
      expect(first.entries).toHaveLength(17)
      expect(first.cursor).toBeDefined()
      yield* drafts.clear(first.entries[16].identity, first.entries[16].token, "clear-boundary")
      yield* drafts.save(identity(tmp.path, "later"), undefined, content, "later")
      const found = [...first.entries]
      let cursor = first.cursor
      while (cursor) {
        const page = yield* drafts.page(scope, { cursor, limit: 17 })
        found.push(...page.entries)
        cursor = page.cursor
      }
      expect(new Set(found.map((entry) => entry.identity.key)).size).toBe(125)
      expect(found.some((entry) => entry.identity.key === "later")).toBe(false)
      expect(
        Exit.isFailure(yield* drafts.page({ ...scope, box: "different" }, { cursor: first.cursor }).pipe(Effect.exit)),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* drafts
            .page({ ...scope, workspace: tmp.path + "-foreign" }, { cursor: first.cursor })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* drafts.page(scope, { cursor: "malformed" }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* drafts.page(scope, { limit: 101 }).pipe(Effect.exit))).toBe(true)
      let refreshed = 0
      cursor = undefined
      do {
        const page: Effect.Success<ReturnType<typeof drafts.page>> = yield* drafts.page(scope, { cursor, limit: 100 })
        refreshed += page.entries.length
        cursor = page.cursor
      } while (cursor)
      expect(refreshed).toBe(126)
    }),
  )
}, 60_000)

test("quota refusal rolls back row and ledger changes; source root and database ownership cannot be mixed", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  await data.run((drafts, store, database) =>
    Effect.gen(function* () {
      const huge = {
        ...content,
        images: [{ ...content.images[0], dataUrl: "data:text/plain;base64," + "a".repeat(11_500_000) }],
      }
      yield* drafts.save(identity(tmp.path, "large-1"), undefined, huge, "large-1")
      yield* drafts.save(identity(tmp.path, "large-2"), undefined, huge, "large-2")
      const before = yield* database.db.select().from(Control).get()
      expect(
        Exit.isFailure(yield* drafts.save(identity(tmp.path, "large-3"), undefined, huge, "large-3").pipe(Effect.exit)),
      ).toBe(true)
      expect(yield* database.db.select().from(Control).get()).toEqual(before)
      expect(yield* database.db.select().from(Rows).all()).toHaveLength(2)
      expect(yield* drafts.load(identity(tmp.path, "large-3"))).toBeUndefined()
      const wrong = composerRetention(database, store, data.dir, path.join(tmp.path, "other.sqlite"))
      expect(Exit.isFailure(yield* wrong.load(identity(tmp.path)).pipe(Effect.exit))).toBe(true)
      expect(
        Exit.isFailure(
          yield* composerRetention(database, store, path.join(tmp.path, "other-storage"), data.file)
            .load(identity(tmp.path))
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* database.db.select().from(Control).get()).toEqual(before)
    }),
  )
}, 60_000)

test("damaged retained evidence, indexed identity and byte ledger fail closed", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  const who = identity(tmp.path)
  await data.run((drafts, _store, database) =>
    Effect.gen(function* () {
      const saved = yield* drafts.save(who, undefined, content, "first")
      const original = yield* database.db.select().from(Control).get()
      expect(original).toBeDefined()
      if (!original) throw new Error("Expected journal")
      yield* database.db
        .update(Control)
        .set({ source: "damaged private evidence" })
        .where(eq(Control.id, original.id))
        .run()
      expect(Exit.isFailure(yield* drafts.save(who, saved.token, content, "next").pipe(Effect.exit))).toBe(true)
      expect((yield* database.db.select().from(Control).get())?.source).toBe("damaged private evidence")
      yield* database.db.update(Control).set(original).where(eq(Control.id, original.id)).run()
      const stored = yield* database.db.select().from(Rows).get()
      if (!stored) throw new Error("Expected stored draft")
      yield* database.db.update(Rows).set({ box: "wrong-index" }).where(eq(Rows.id, stored.id)).run()
      expect(Exit.isFailure(yield* drafts.load(who).pipe(Effect.exit))).toBe(true)
      expect((yield* database.db.select().from(Rows).get())?.record).toBe(stored.record)
      yield* database.db
        .update(Rows)
        .set({ box: stored.box, metadata_bytes: stored.metadata_bytes + 1 })
        .where(eq(Rows.id, stored.id))
        .run()
      expect(Exit.isFailure(yield* drafts.save(who, saved.token, content, "next").pipe(Effect.exit))).toBe(true)
      expect((yield* database.db.select().from(Rows).get())?.record).toBe(stored.record)
      yield* database.db.update(Rows).set({ metadata_bytes: stored.metadata_bytes }).where(eq(Rows.id, stored.id)).run()
      expect(yield* drafts.load(who)).toEqual(saved)
    }),
  )
}, 30_000)

test("a missing initialized legacy document never creates an empty SQL catalog", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  await data.run((_drafts, store) =>
    composerDrafts(store, data.dir).save(identity(tmp.path), undefined, content, "legacy"),
  )
  await rm(path.join(data.dir, "raya", "composer-drafts.json"))
  await data.run((drafts, _store, database) =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* drafts.load(identity(tmp.path)).pipe(Effect.exit))).toBe(true)
      expect(yield* database.db.select().from(Control).get()).toBeUndefined()
      expect(yield* database.db.select().from(Rows).all()).toEqual([])
    }),
  )
}, 30_000)

test("transaction and activation recheck same-generation immutable owner evidence", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  await data.run((drafts, store, database) =>
    Effect.gen(function* () {
      const saved = yield* drafts.save(identity(tmp.path), undefined, content, "first")
      const journal = yield* database.db.select().from(Control).get()
      if (!journal) throw new Error("Expected journal")
      const raced = composerRetention(database, store, data.dir, data.file, {
        checkpoint: (stage) =>
          stage === "admitted"
            ? database.db
                .update(Control)
                .set({ cursor_secret: "b".repeat(64) })
                .where(eq(Control.id, journal.id))
                .run()
                .pipe(Effect.orDie, Effect.asVoid)
            : Effect.void,
      })
      expect(
        Exit.isFailure(yield* raced.save(identity(tmp.path), saved.token, content, "raced").pipe(Effect.exit)),
      ).toBe(true)
      expect((yield* database.db.select().from(Rows).get())?.record).toBe(JSON.stringify(saved))
      yield* database.db
        .update(Control)
        .set({ cursor_secret: journal.cursor_secret })
        .where(eq(Control.id, journal.id))
        .run()
      const stored = yield* database.db.select().from(Rows).get()
      if (!stored) throw new Error("Expected draft")
      yield* database.db.update(Rows).set({ sequence: 0 }).where(eq(Rows.id, stored.id)).run()
      expect(
        Exit.isFailure(
          yield* drafts.page({ workspace: tmp.path, projectID: "project", box: "prompt:default" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* database.db.update(Rows).set({ sequence: stored.sequence }).where(eq(Rows.id, stored.id)).run()
      expect(yield* drafts.load(identity(tmp.path))).toEqual(saved)
    }),
  )
  await using other = await tmpdir()
  const pending = fixture(other.path)
  await pending.run((_drafts, store, database) =>
    Effect.gen(function* () {
      const raced = composerRetention(database, store, pending.dir, pending.file, {
        checkpoint: (stage) =>
          stage === "verified"
            ? database.db.update(Control).set({ storage: "replaced-owner" }).run().pipe(Effect.orDie, Effect.asVoid)
            : Effect.void,
      })
      expect(Exit.isFailure(yield* raced.load(identity(other.path)).pipe(Effect.exit))).toBe(true)
      expect((yield* database.db.select().from(Control).get())?.phase).toBe("pending")
      expect((yield* database.db.select().from(Control).get())?.storage).toBe("replaced-owner")
    }),
  )
}, 30_000)

test("measure real admission stages and migrated source cost without draft values", async () => {
  await using tmp = await tmpdir()
  const data = fixture(tmp.path)
  await data.run((drafts, _store, database) =>
    Effect.gen(function* () {
      const timings: Record<string, number> = {}
      const measure = <A, E>(name: string, body: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const start = performance.now()
          const value = yield* body
          timings[name] = Math.round(performance.now() - start)
          return value
        })
      yield* drafts.load(identity(tmp.path))
      yield* measure(
        "sql-standalone-10",
        Effect.gen(function* () {
          for (let index = 0; index < 10; index++) yield* database.db.get(sql`SELECT 1 AS value`)
        }),
      )
      yield* measure(
        "sql-one-transaction-10",
        database.db.transaction(
          (tx) =>
            Effect.gen(function* () {
              for (let index = 0; index < 10; index++) yield* tx.get(sql`SELECT 1 AS value`)
            }),
          { behavior: "immediate" },
        ),
      )
      yield* measure(
        "canonical-roots-10",
        Effect.promise(async () => {
          for (let index = 0; index < 10; index++) {
            await resolveProfileRoot({ kind: "json", path: data.dir })
            await resolveProfileRoot({ kind: "sqlite", path: data.file })
          }
        }),
      )
      yield* measure(
        "sentinel-reads-10",
        Effect.promise(async () => {
          for (let index = 0; index < 10; index++) {
            await readFile(path.join(data.dir, "raya", "composer-drafts.json"))
            await readFile(path.join(data.dir, "raya", "composer-drafts-initialized.json"))
          }
        }),
      )
      yield* measure(
        "production-load-10",
        Effect.gen(function* () {
          for (let index = 0; index < 10; index++) expect(yield* drafts.load(identity(tmp.path))).toBeUndefined()
        }),
      )
      console.log("Retention stage timings", timings)
    }),
  )
  await using other = await tmpdir()
  const migrated = fixture(other.path)
  const rich = {
    ...content,
    images: [{ ...content.images[0], dataUrl: "data:text/plain;base64," + "a".repeat(8_000_000) }],
  }
  await migrated.run((drafts, store) =>
    Effect.gen(function* () {
      const prior = yield* composerDrafts(store, migrated.dir).save(
        identity(other.path),
        undefined,
        rich,
        "legacy-large",
      )
      expect(yield* drafts.load(identity(other.path))).toEqual(prior)
      const start = performance.now()
      for (let index = 0; index < 10; index++)
        expect((yield* drafts.load(identity(other.path)))?.token).toEqual(prior.token)
      console.log("Retention migrated source timing", {
        sourceBytes: 8_000_000,
        operations: 10,
        elapsedMs: Math.round(performance.now() - start),
      })
    }),
  )
}, 60_000)
