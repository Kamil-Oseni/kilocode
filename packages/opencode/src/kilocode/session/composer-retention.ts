import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm"
import { Effect } from "effect"
import z from "zod"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaComposerTable as Rows, RayaComposerControlTable as Control } from "@opencode-ai/core/kilocode/composer.sql"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Flock } from "@opencode-ai/core/util/flock"
import type { Storage } from "@/storage/storage"
import { DraftImported, DraftRetirement } from "./composer-codec"
import {
  DraftError,
  DraftLegacy as Legacy,
  DraftSchemas,
  type DraftContent,
  type DraftEntry,
  type DraftIdentity,
  type DraftToken,
} from "./composer-drafts"

const budget = 32 * 1024 * 1024
const metadata = 64 * 1024 * 1024
const control = "profile-v1"
const cursor = z
  .object({
    version: z.literal(1),
    generation: z.string().uuid(),
    scope: z.string().length(64),
    after: z.number().int().min(0),
    upper: z.number().int().min(0),
  })
  .strict()
const proof = DraftRetirement.schema
type Journal = typeof Control.$inferSelect
type Transaction = Pick<Database.Interface["db"], "select" | "insert" | "update" | "get" | "all">
type Scope = Pick<DraftIdentity, "workspace" | "projectID" | "box">
const validate = <A>(body: () => A, code: "invalid" | "corrupt" = "invalid") =>
  Effect.try({ try: body, catch: (err) => (err instanceof DraftError ? err : new DraftError(code)) })
const bytes = (value: string | null) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function json(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new DraftError("corrupt")
  }
}
const decode = (value: string): DraftEntry => {
  const result = DraftSchemas.entry.safeParse(json(value))
  if (!result.success || result.data.digest !== Legacy.hash(result.data.content)) throw new DraftError("corrupt")
  return result.data
}
function row(item: DraftEntry) {
  const record = JSON.stringify(item)
  const content = item.content === null ? 0 : Buffer.byteLength(JSON.stringify(item.content))
  return {
    id: Legacy.id(item.identity),
    workspace: item.identity.workspace,
    project: item.identity.projectID ?? "",
    box: item.identity.box,
    record,
    content_bytes: content,
    metadata_bytes:
      Buffer.byteLength(record) -
      content +
      Buffer.byteLength(
        JSON.stringify([
          Legacy.id(item.identity),
          item.identity.workspace,
          item.identity.projectID ?? "",
          item.identity.box,
        ]),
      ),
  }
}
function checked(value: typeof Rows.$inferSelect) {
  const entry = decode(value.record)
  const expected = row(entry)
  if (
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.id !== expected.id ||
    value.workspace !== expected.workspace ||
    value.project !== expected.project ||
    value.box !== expected.box ||
    value.content_bytes !== expected.content_bytes ||
    value.metadata_bytes !== expected.metadata_bytes
  )
    throw new DraftError("corrupt")
  return entry
}
function read(dir: string, key: string[]) {
  return Effect.tryPromise({
    try: () =>
      (async () => {
        const file = path.join(dir, ...key) + ".json"
        if ((await stat(file)).size > budget) throw new DraftError("capacity")
        const buffer = await readFile(file)
        const text = buffer.toString("utf8")
        if (!Buffer.from(text).equals(buffer)) throw new DraftError("corrupt")
        return text
      })().catch((err: unknown) => {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return null
        throw err
      }),
    catch: (err) => (err instanceof DraftError ? err : new DraftError("corrupt")),
  })
}
function parsed(source: string | null, marker: string | null) {
  if (marker !== null) {
    const value = json(marker)
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1)
      throw new DraftError("corrupt")
    if (source === null) throw new DraftError("missing")
  }
  return source === null ? { version: 1 as const, entries: [] as DraftEntry[] } : Legacy.checked(json(source))
}
const sentinel = DraftRetirement.encode
const overhead = DraftRetirement.overhead
function retired(value: string | null, journal: Journal) {
  if (value === null) return false
  try {
    return JSON.stringify(JSON.parse(value)) === JSON.stringify(sentinel(journal))
  } catch {
    return false
  }
}

function stable(current: Journal, prior: Journal) {
  return (
    current.storage === prior.storage &&
    current.database === prior.database &&
    current.generation === prior.generation &&
    current.source_digest === prior.source_digest &&
    current.marker_digest === prior.marker_digest &&
    current.cursor_secret === prior.cursor_secret &&
    current.source_digest === bytes(current.source) &&
    current.marker_digest === bytes(current.marker)
  )
}
const valid = DraftRetirement.validate

/** SQL mutations are admitted only after an exact, recoverable JSON cutover. */
export function composerRetention(
  database: Database.Interface,
  store: Storage.Interface,
  dir: string,
  file: string,
  opts: {
    checkpoint?: (stage: string) => Effect.Effect<void>
    project?: (workspace: string) => Effect.Effect<string>
  } = {},
) {
  const db = database.db
  const checkpoint = (stage: string) => opts.checkpoint?.(stage) ?? Effect.void
  const journal = (tx: Transaction) => tx.select().from(Control).where(eq(Control.id, control)).get()
  const connection = (tx: Transaction, owner: { id: string }) =>
    Effect.gen(function* () {
      const files = yield* tx.all(sql`PRAGMA database_list`)
      const actual = yield* validate(
        () =>
          z
            .array(z.object({ name: z.string(), file: z.string() }))
            .parse(files)
            .find((item) => item.name === "main"),
        "corrupt",
      )
      if (!actual) return yield* Effect.fail(new DraftError("corrupt"))
      const connected =
        actual.file === ""
          ? { id: "memory" }
          : yield* Effect.tryPromise({
              try: () => resolveProfileRoot({ kind: "sqlite", path: actual.file }),
              catch: () => new DraftError("admission"),
            })
      if (connected.id !== owner.id) return yield* Effect.fail(new DraftError("conflict"))
    })
  const ledger = (tx: Transaction, owner: Journal) =>
    Effect.gen(function* () {
      const raw = yield* tx.get(
        sql`SELECT COALESCE(SUM(content_bytes),0) AS content, COALESCE(SUM(metadata_bytes),0) AS metadata, COALESCE(SUM(CASE WHEN sequence < 1 OR sequence > ${Number.MAX_SAFE_INTEGER} THEN 1 ELSE 0 END),0) AS invalid FROM raya_composer_draft`,
      )
      const totals = yield* validate(
        () =>
          z
            .object({ content: z.number().int().min(0), metadata: z.number().int().min(0), invalid: z.literal(0) })
            .parse(raw),
        "corrupt",
      )
      if (totals.content !== owner.content_bytes || totals.metadata + overhead(owner) !== owner.metadata_bytes)
        return yield* Effect.fail(new DraftError("corrupt"))
    })
  const inspect = (root: { id: string; path: string }, owner: { id: string }) =>
    Effect.gen(function* () {
      yield* connection(db, owner)
      // Run the genuine Storage initialization/migrations before reading the exact source bytes.
      yield* store.read<unknown>(Legacy.mark).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      const source = yield* read(root.path, Legacy.key)
      const marker = yield* read(root.path, Legacy.mark)
      const prior = yield* journal(db)
      if (prior) yield* validate(() => valid(prior))
      if (prior && (prior.storage !== root.id || prior.database !== owner.id))
        return yield* Effect.fail(new DraftError("conflict"))
      if (prior?.phase === "active" && (!retired(source, prior) || !retired(marker, prior)))
        return yield* Effect.fail(new DraftError(source === null || marker === null ? "missing" : "corrupt"))
      return { source, marker, prior }
    })
  const boot = Effect.acquireUseRelease(
    Effect.tryPromise({
      try: async (signal) => {
        const root = await resolveProfileRoot({ kind: "json", path: dir })
        const owner = file === ":memory:" ? { id: "memory" } : await resolveProfileRoot({ kind: "sqlite", path: file })
        const lease = await Flock.acquire(`raya.composer-drafts:${root.id}`, {
          dir: path.join(path.dirname(root.path), ".raya-draft-locks"),
          recover: "dead",
          timeoutMs: 5000,
          baseDelayMs: 10,
          maxDelayMs: 50,
          signal,
        })
        return { root, owner, lease }
      },
      catch: () => new DraftError("admission"),
    }),
    ({ root, owner }) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const { source, marker, prior } = yield* inspect(root, owner)
          if (prior?.phase === "active") return prior
          const pending =
            prior ??
            (yield* Effect.gen(function* () {
              const data = yield* validate(() => parsed(source, marker))
              const imported = marker === null ? undefined : DraftImported.safeParse(json(marker))
              if (marker !== null && !imported?.success) {
                const value = json(marker)
                if (
                  value &&
                  typeof value === "object" &&
                  "format" in value &&
                  value.format === "raya.restored-composer-content"
                )
                  return yield* Effect.fail(new DraftError("corrupt"))
              }
              const entries = imported?.success
                ? yield* Effect.forEach(data.entries, (entry) => {
                    if (!entry.identity.pendingID) return Effect.succeed(entry)
                    if (!opts.project) return Effect.fail(new DraftError("admission"))
                    return opts.project(entry.identity.workspace).pipe(
                      Effect.map((projectID) => ({
                        ...entry,
                        identity: { ...entry.identity, projectID },
                      })),
                    )
                  })
                : data.entries
              yield* validate(() => Legacy.checked({ version: 1, entries }))
              const rows = entries.map(row)
              const content = rows.reduce((sum, item) => sum + item.content_bytes, 0)
              const used = rows.reduce((sum, item) => sum + item.metadata_bytes, 0)
              if (content > budget || used > metadata) return yield* Effect.fail(new DraftError("capacity"))
              return yield* db.transaction(
                (tx) =>
                  Effect.gen(function* () {
                    if ((yield* journal(tx)) || (yield* tx.select({ id: Rows.id }).from(Rows).limit(1).get()))
                      return yield* Effect.fail(new DraftError("corrupt"))
                    for (const item of rows) yield* tx.insert(Rows).values(item).run()
                    const value = {
                      id: control,
                      storage: root.id,
                      database: owner.id,
                      generation: randomUUID(),
                      phase: "pending",
                      source,
                      source_digest: bytes(source),
                      marker,
                      marker_digest: bytes(marker),
                      cursor_secret: randomBytes(32).toString("hex"),
                      content_bytes: content,
                      metadata_bytes: used,
                    }
                    value.metadata_bytes += overhead(value)
                    if (value.metadata_bytes > metadata) return yield* Effect.fail(new DraftError("capacity"))
                    yield* tx.insert(Control).values(value).run()
                    return value
                  }),
                { behavior: "immediate" },
              )
            }))
          if (pending.phase !== "pending") return yield* Effect.fail(new DraftError("corrupt"))
          yield* ledger(db, pending)
          const imported = yield* db.select().from(Rows).all()
          yield* validate(() => imported.forEach(checked))
          yield* checkpoint("imported")
          if (!retired(source, pending)) {
            if (bytes(source) !== pending.source_digest || bytes(marker) !== pending.marker_digest)
              return yield* Effect.fail(new DraftError("conflict"))
            yield* store.replace(Legacy.key, sentinel(pending))
          }
          yield* checkpoint("source-retired")
          if (!retired(marker, pending)) {
            if (bytes(marker) !== pending.marker_digest) return yield* Effect.fail(new DraftError("conflict"))
            yield* store.replace(Legacy.mark, sentinel(pending))
          }
          if (
            !retired(yield* read(root.path, Legacy.key), pending) ||
            !retired(yield* read(root.path, Legacy.mark), pending)
          )
            return yield* Effect.fail(new DraftError("corrupt"))
          yield* checkpoint("verified")
          return yield* db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const current = yield* journal(tx)
                if (!current || !stable(current, pending) || current.phase !== "pending")
                  return yield* Effect.fail(new DraftError("conflict"))
                yield* ledger(tx, current)
                yield* tx.update(Control).set({ phase: "active" }).where(eq(Control.id, control)).run()
                return { ...current, phase: "active" }
              }),
            { behavior: "immediate" },
          )
        }),
      ),
    ({ lease }) => Effect.promise(() => lease.release()),
  )
  const ready = Effect.gen(function* () {
    const { root, owner } = yield* Effect.tryPromise({
      try: async () => ({
        root: await resolveProfileRoot({ kind: "json", path: dir }),
        owner: file === ":memory:" ? { id: "memory" } : await resolveProfileRoot({ kind: "sqlite", path: file }),
      }),
      catch: () => new DraftError("admission"),
    })
    yield* store.read<unknown>(Legacy.mark).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
    const source = yield* read(root.path, Legacy.key)
    const marker = yield* read(root.path, Legacy.mark)
    const candidate = source === null ? undefined : yield* validate(() => proof.safeParse(json(source)), "corrupt")
    if (candidate?.success) {
      if (candidate.data.storage !== root.id || candidate.data.database !== owner.id)
        return yield* Effect.fail(new DraftError("conflict"))
      const paired = marker === null ? undefined : yield* validate(() => proof.safeParse(json(marker)), "corrupt")
      if (paired?.success && JSON.stringify(candidate.data) === JSON.stringify(paired.data))
        return { root, owner, proof: candidate.data }
    }
    return { root, owner, proof: sentinel(yield* boot) }
  })
  const transaction = <A, E>(body: (tx: Transaction, owner: Journal) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt++) {
        const admitted = yield* ready
        yield* checkpoint("admitted")
        const result = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* connection(tx, admitted.owner)
              const current = yield* journal(tx)
              if (current) yield* validate(() => valid(current))
              if (!current || JSON.stringify(sentinel(current)) !== JSON.stringify(admitted.proof))
                return yield* Effect.fail(new DraftError("conflict"))
              yield* ledger(tx, current)
              if (current.phase === "pending") return { pending: true as const }
              return { pending: false as const, value: yield* body(tx, current) }
            }),
          { behavior: "immediate" },
        )
        if (!result.pending) return result.value
        // Join the cutover outside the SQL transaction. The pending attempt performed no draft effect.
        yield* boot
      }
      return yield* Effect.fail(new DraftError("conflict"))
    })
  const get = (tx: Transaction, who: DraftIdentity) =>
    tx
      .select()
      .from(Rows)
      .where(eq(Rows.id, Legacy.id(who)))
      .get()
      .pipe(Effect.flatMap((value) => (value ? validate(() => checked(value)) : Effect.succeed(undefined))))
  const put = (tx: Transaction, owner: Journal, entries: readonly DraftEntry[]) =>
    Effect.gen(function* () {
      let content = owner.content_bytes
      let used = owner.metadata_bytes
      for (const item of entries) {
        const next = row(item)
        const prior = yield* tx.select().from(Rows).where(eq(Rows.id, next.id)).get()
        if (prior) yield* validate(() => checked(prior))
        content += next.content_bytes - (prior?.content_bytes ?? 0)
        used += next.metadata_bytes - (prior?.metadata_bytes ?? 0)
        yield* tx.insert(Rows).values(next).onConflictDoUpdate({ target: Rows.id, set: next }).run()
      }
      if (content > budget || used > metadata || content < 0 || used < 0)
        return yield* Effect.fail(new DraftError("capacity"))
      yield* tx
        .update(Control)
        .set({ content_bytes: content, metadata_bytes: used })
        .where(eq(Control.id, control))
        .run()
    })
  const change = (
    who: DraftIdentity,
    expected: DraftToken | undefined,
    content: DraftContent | null,
    mutation: string,
  ) =>
    transaction((tx, owner) =>
      Effect.gen(function* () {
        const identity = yield* validate(() => DraftSchemas.identity.parse(who))
        const next = yield* validate(() => (content === null ? null : DraftSchemas.content.parse(content)))
        const guard = expected === undefined ? undefined : yield* validate(() => DraftSchemas.token.parse(expected))
        yield* validate(() => z.string().min(1).max(4096).parse(mutation))
        const prior = yield* get(tx, identity)
        const request = Legacy.hash({
          operation: content === null ? "clear" : "save",
          identity,
          expected: guard,
          content: next,
        })
        if (prior?.mutation === mutation) {
          if (prior.receipt?.request === request) return prior
          return yield* Effect.fail(new DraftError("conflict"))
        }
        if (!Legacy.same(guard, prior?.token)) return yield* Effect.fail(new DraftError("conflict"))
        const item = yield* validate(() =>
          DraftSchemas.entry.parse({
            identity,
            content: next,
            token: {
              generation:
                prior?.content === null && next !== null ? randomUUID() : (prior?.token.generation ?? randomUUID()),
              revision: (prior?.token.revision ?? 0) + 1,
            },
            mutation,
            digest: Legacy.hash(next),
            receipt: { request },
          }),
        )
        yield* put(tx, owner, [item])
        return item
      }),
    )
  const promote = (
    from: DraftIdentity,
    to: DraftIdentity,
    source: DraftToken,
    target: DraftToken | undefined,
    mutation: string,
  ) =>
    transaction((tx, owner) =>
      Effect.gen(function* () {
        const left = yield* validate(() => DraftSchemas.identity.parse(from))
        const right = yield* validate(() => DraftSchemas.identity.parse(to))
        const stamp = yield* validate(() => DraftSchemas.token.parse(source))
        const guard = target === undefined ? undefined : yield* validate(() => DraftSchemas.token.parse(target))
        yield* validate(() => z.string().min(1).max(4096).parse(mutation))
        if (Legacy.id(left) === Legacy.id(right)) return yield* Effect.fail(new DraftError("invalid"))
        const prior = yield* get(tx, left)
        const destination = yield* get(tx, right)
        const request = Legacy.hash({ operation: "promote", from: left, to: right, source: stamp, target: guard })
        if (prior?.mutation === mutation || destination?.mutation === mutation) {
          if (
            prior?.content === null &&
            destination?.content &&
            prior.mutation === mutation &&
            destination.mutation === mutation &&
            prior.receipt?.request === request &&
            destination.receipt?.request === request
          )
            return { source: prior, target: destination }
          return yield* Effect.fail(new DraftError("conflict"))
        }
        if (!prior?.content || !Legacy.same(stamp, prior.token) || !Legacy.same(guard, destination?.token))
          return yield* Effect.fail(new DraftError("conflict"))
        const moved = yield* validate(() =>
          DraftSchemas.entry.parse({
            identity: right,
            content: prior.content,
            token: { generation: randomUUID(), revision: (destination?.token.revision ?? 0) + 1 },
            mutation,
            digest: prior.digest,
            receipt: { request },
          }),
        )
        const cleared = yield* validate(() =>
          DraftSchemas.entry.parse({
            ...prior,
            content: null,
            token: { generation: prior.token.generation, revision: prior.token.revision + 1 },
            mutation,
            digest: Legacy.hash(null),
            receipt: { request },
          }),
        )
        yield* put(tx, owner, [cleared, moved])
        return { source: cleared, target: moved }
      }),
    )
  const page = (scope: Scope, input: { cursor?: string; limit?: number } = {}) =>
    transaction((tx, owner) =>
      Effect.gen(function* () {
        const limit = yield* validate(() =>
          z
            .number()
            .int()
            .min(1)
            .max(100)
            .parse(input.limit ?? 50),
        )
        const binding = Legacy.hash({ workspace: scope.workspace, projectID: scope.projectID, box: scope.box })
        const sign = (value: string) => createHmac("sha256", owner.cursor_secret).update(value).digest("hex")
        const saved =
          input.cursor === undefined
            ? undefined
            : yield* validate(() => {
                if (input.cursor!.length > 2048) throw new DraftError("invalid")
                const parts = input.cursor!.split(".")
                if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) throw new DraftError("invalid")
                if (!timingSafeEqual(Buffer.from(parts[1], "hex"), Buffer.from(sign(parts[0]), "hex")))
                  throw new DraftError("invalid")
                const value = cursor.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")))
                if (value.generation !== owner.generation || value.scope !== binding || value.after > value.upper)
                  throw new DraftError("invalid")
                return value
              })
        const upper =
          saved?.upper ??
          (yield* tx.select({ sequence: Rows.sequence }).from(Rows).orderBy(desc(Rows.sequence)).limit(1).get())
            ?.sequence ??
          0
        const rows = yield* tx
          .select()
          .from(Rows)
          .where(
            and(
              eq(Rows.workspace, scope.workspace),
              eq(Rows.project, scope.projectID ?? ""),
              eq(Rows.box, scope.box),
              gt(Rows.sequence, saved?.after ?? 0),
              lte(Rows.sequence, upper),
            ),
          )
          .orderBy(asc(Rows.sequence))
          .limit(limit + 1)
          .all()
        const entries = yield* validate(() => rows.slice(0, limit).map(checked))
        const next =
          rows.length > limit
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  generation: owner.generation,
                  scope: binding,
                  after: rows[limit - 1].sequence,
                  upper,
                }),
              ).toString("base64url")
            : undefined
        return { entries, ...(next ? { cursor: `${next}.${sign(next)}` } : {}) }
      }),
    )
  return {
    load: (who: DraftIdentity) => transaction((tx) => get(tx, who)),
    save: (who: DraftIdentity, expected: DraftToken | undefined, value: DraftContent, mutation: string) =>
      change(who, expected, value, mutation),
    clear: (who: DraftIdentity, expected: DraftToken, mutation: string) => change(who, expected, null, mutation),
    promote,
    page,
  }
}
