import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import z from "zod"
import { Flock } from "@opencode-ai/core/util/flock"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Storage } from "@/storage/storage"

const short = z.string().min(1).max(4096)
const line = z.number().int().positive()
const comment = z.discriminatedUnion("origin", [
  z
    .object({
      origin: z.literal("pr"),
      id: short,
      author: short,
      body: z.string().max(100_000),
      file: short.optional(),
      line: line.optional(),
      diffHunk: z.string().max(200_000).optional(),
      outdated: z.boolean().optional(),
      replies: z
        .array(z.object({ author: short, body: z.string().max(100_000) }).strict())
        .max(20)
        .optional(),
    })
    .strict(),
  z
    .object({
      origin: z.undefined().optional(),
      id: short,
      file: short,
      side: z.enum(["additions", "deletions"]),
      line,
      comment: z.string().max(100_000),
      selectedText: z.string().max(200_000),
    })
    .strict(),
])
const identity = z
  .object({
    key: short,
    box: short,
    workspace: short,
    projectID: short.optional(),
    sessionID: short.optional(),
    pendingID: short.optional(),
  })
  .strict()
const content = z
  .object({
    text: z.string().max(1_000_000),
    comments: z.array(comment).max(100),
    images: z
      .array(
        z
          .object({
            id: short,
            filename: short,
            mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
            dataUrl: z.string().max(12_000_000),
          })
          .strict(),
      )
      .max(16),
    scroll: z.number().finite().min(0),
  })
  .strict()
const token = z
  .object({ generation: z.string().uuid(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict()
const entry = z
  .object({ identity, token, content: content.nullable(), mutation: short, digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
const document = z.object({ version: z.literal(1), entries: z.array(entry).max(128) }).strict()

export type DraftIdentity = z.infer<typeof identity>
export type DraftContent = z.infer<typeof content>
export type DraftToken = z.infer<typeof token>
export type DraftEntry = z.infer<typeof entry>

/** Deliberately carries no draft text, attachment bytes, filenames or workspace paths. */
export class DraftError extends Error {
  constructor(readonly code: "invalid" | "corrupt" | "missing" | "conflict" | "capacity" | "admission") {
    super(`Composer draft persistence: ${code}`)
  }
}

const key = ["raya", "composer-drafts"]
const mark = ["raya", "composer-drafts-initialized"]
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const same = (left: DraftToken | undefined, right: DraftToken | undefined) =>
  left?.generation === right?.generation && left?.revision === right?.revision
const id = (value: DraftIdentity) => hash(identity.parse(value))
function parse<T>(schema: z.ZodType<T>, value: unknown, code: "invalid" | "corrupt" = "invalid"): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new DraftError(code)
  return result.data
}
function checked(value: unknown) {
  const data = parse(document, value, "corrupt")
  if (Buffer.byteLength(JSON.stringify(data)) > 32 * 1024 * 1024) throw new DraftError("capacity")
  const keys = data.entries.map((item) => id(item.identity))
  if (new Set(keys).size !== keys.length || data.entries.some((item) => item.digest !== hash(item.content)))
    throw new DraftError("corrupt")
  return data
}

/** Effect-native durable state only. The caller supplies the actual Storage root, never a project directory. */
export function composerDrafts(store: Storage.Interface, dir: string) {
  const validate = <T>(body: () => T) =>
    Effect.try({ try: body, catch: (err) => (err instanceof DraftError ? err : new DraftError("invalid")) })
  const read = Effect.gen(function* () {
    const initialized = yield* store
      .read<unknown>(mark)
      .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
    if (
      initialized !== undefined &&
      (!initialized || typeof initialized !== "object" || !("version" in initialized) || initialized.version !== 1)
    )
      return yield* Effect.fail(new DraftError("corrupt"))
    const raw = yield* store.read<unknown>(key).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
    if (raw === undefined && initialized !== undefined) return yield* Effect.fail(new DraftError("missing"))
    return raw === undefined
      ? { version: 1 as const, entries: [] as DraftEntry[] }
      : yield* validate(() => checked(raw))
  })
  const locked = <A, E>(body: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async (signal) => {
          const root = await resolveProfileRoot({ kind: "json", path: dir })
          return Flock.acquire(`raya.composer-drafts:${root.id}`, {
            dir: path.join(path.dirname(root.path), ".raya-draft-locks"),
            recover: "dead",
            timeoutMs: 5000,
            baseDelayMs: 10,
            maxDelayMs: 50,
            signal,
          })
        },
        catch: () => new DraftError("admission"),
      }),
      () => Effect.uninterruptible(body),
      (lease) => Effect.promise(() => lease.release()),
    )
  const publish = (data: z.infer<typeof document>) =>
    Effect.gen(function* () {
      yield* validate(() => checked(data))
      yield* store.replace(key, data)
      // Publish the marker after the document: an interrupted first initialization never erases a valid document.
      yield* store.replace(mark, { version: 1 })
    })
  const change = (who: DraftIdentity, expected: DraftToken | undefined, value: DraftContent | null, mutation: string) =>
    locked(
      Effect.gen(function* () {
        const owner = yield* validate(() => parse(identity, who))
        const next = yield* validate(() => (value === null ? null : parse(content, value)))
        yield* validate(() => parse(short, mutation))
        if (expected !== undefined) yield* validate(() => parse(token, expected))
        const data = yield* read
        const index = data.entries.findIndex((item) => id(item.identity) === id(owner))
        const prior = data.entries[index]
        if (!same(expected, prior?.token)) return yield* Effect.fail(new DraftError("conflict"))
        if (index < 0 && data.entries.length === 128) return yield* Effect.fail(new DraftError("capacity"))
        const stamp = {
          generation:
            prior?.content === null && next !== null ? randomUUID() : (prior?.token.generation ?? randomUUID()),
          revision: (prior?.token.revision ?? 0) + 1,
        }
        const item = { identity: owner, content: next, token: stamp, mutation, digest: hash(next) }
        if (index < 0) data.entries.push(item)
        if (index >= 0) data.entries[index] = item
        yield* publish(data)
        return item
      }),
    )
  return {
    load: (who: DraftIdentity) =>
      locked(
        Effect.gen(function* () {
          const target = yield* validate(() => id(parse(identity, who)))
          return (yield* read).entries.find((item) => id(item.identity) === target)
        }),
      ),
    save: (who: DraftIdentity, expected: DraftToken | undefined, value: DraftContent, mutation: string) =>
      change(who, expected, value, mutation),
    clear: (who: DraftIdentity, expected: DraftToken, mutation: string) => change(who, expected, null, mutation),
    promote: (
      from: DraftIdentity,
      to: DraftIdentity,
      source: DraftToken,
      target: DraftToken | undefined,
      mutation: string,
    ) =>
      locked(
        Effect.gen(function* () {
          const left = yield* validate(() => parse(identity, from))
          const right = yield* validate(() => parse(identity, to))
          yield* validate(() => parse(token, source))
          if (target !== undefined) yield* validate(() => parse(token, target))
          yield* validate(() => parse(short, mutation))
          if (id(left) === id(right)) return yield* Effect.fail(new DraftError("invalid"))
          const data = yield* read
          const prior = data.entries.find((item) => id(item.identity) === id(left))
          const index = data.entries.findIndex((item) => id(item.identity) === id(right))
          const destination = data.entries[index]
          if (!prior?.content || !same(source, prior.token) || !same(target, destination?.token))
            return yield* Effect.fail(new DraftError("conflict"))
          if (index < 0 && data.entries.length === 128) return yield* Effect.fail(new DraftError("capacity"))
          const moved = {
            identity: right,
            content: prior.content,
            token: { generation: randomUUID(), revision: (destination?.token.revision ?? 0) + 1 },
            mutation,
            digest: prior.digest,
          }
          prior.content = null
          prior.token = { generation: prior.token.generation, revision: prior.token.revision + 1 }
          prior.mutation = mutation
          prior.digest = hash(null)
          if (index < 0) data.entries.push(moved)
          if (index >= 0) data.entries[index] = moved
          yield* publish(data)
          return { source: prior, target: moved }
        }),
      ),
    snapshot: () => locked(read),
  }
}
