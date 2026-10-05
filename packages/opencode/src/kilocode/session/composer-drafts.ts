import { randomUUID } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import z from "zod"
import { Flock } from "@opencode-ai/core/util/flock"
import { resolveProfileRoot } from "@opencode-ai/core/kilocode/profile-maintenance"
import { Storage } from "@/storage/storage"

import {
  DraftSchemas,
  DraftLegacy,
  DraftError,
  type DraftIdentity,
  type DraftContent,
  type DraftToken,
  type DraftEntry,
} from "./composer-codec"
export {
  DraftSchemas,
  DraftLegacy,
  DraftError,
  type DraftIdentity,
  type DraftContent,
  type DraftToken,
  type DraftEntry,
} from "./composer-codec"

const { identity, content, token } = DraftSchemas
const { key, mark, hash, same, id, checked } = DraftLegacy
const short = z.string().min(1).max(4096)
const document = z.object({ version: z.literal(1), entries: z.array(DraftSchemas.entry).max(128) }).strict()
function parse<T>(schema: z.ZodType<T>, value: unknown, code: "invalid" | "corrupt" = "invalid"): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new DraftError(code)
  return result.data
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
  const repair = Effect.gen(function* () {
    const initialized = yield* store
      .read<unknown>(mark)
      .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
    if (initialized === undefined) yield* store.replace(mark, { version: 1 })
  })
  const change = (who: DraftIdentity, expected: DraftToken | undefined, value: DraftContent | null, mutation: string) =>
    locked(
      Effect.gen(function* () {
        const owner = yield* validate(() => parse(identity, who))
        const next = yield* validate(() => (value === null ? null : parse(content, value)))
        yield* validate(() => parse(short, mutation))
        const guard = expected === undefined ? undefined : yield* validate(() => parse(token, expected))
        const data = yield* read
        const index = data.entries.findIndex((item) => id(item.identity) === id(owner))
        const prior = data.entries[index]
        const request = hash({
          operation: value === null ? "clear" : "save",
          identity: owner,
          expected: guard,
          content: next,
        })
        if (prior?.mutation === mutation) {
          if (prior.receipt?.request === request) {
            yield* repair
            return prior
          }
          return yield* Effect.fail(new DraftError("conflict"))
        }
        if (!same(expected, prior?.token)) return yield* Effect.fail(new DraftError("conflict"))
        if (index < 0 && data.entries.length === 128) return yield* Effect.fail(new DraftError("capacity"))
        const stamp = {
          generation:
            prior?.content === null && next !== null ? randomUUID() : (prior?.token.generation ?? randomUUID()),
          revision: (prior?.token.revision ?? 0) + 1,
        }
        const item = {
          identity: owner,
          content: next,
          token: stamp,
          mutation,
          digest: hash(next),
          receipt: { request },
        }
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
          const stamp = yield* validate(() => parse(token, source))
          const guard = target === undefined ? undefined : yield* validate(() => parse(token, target))
          yield* validate(() => parse(short, mutation))
          if (id(left) === id(right)) return yield* Effect.fail(new DraftError("invalid"))
          const data = yield* read
          const prior = data.entries.find((item) => id(item.identity) === id(left))
          const index = data.entries.findIndex((item) => id(item.identity) === id(right))
          const destination = data.entries[index]
          const request = hash({ operation: "promote", from: left, to: right, source: stamp, target: guard })
          if (prior?.mutation === mutation || destination?.mutation === mutation) {
            if (
              prior?.content === null &&
              destination?.content &&
              prior.mutation === mutation &&
              destination.mutation === mutation &&
              prior.receipt?.request === request &&
              destination.receipt?.request === request
            ) {
              yield* repair
              return { source: prior, target: destination }
            }
            return yield* Effect.fail(new DraftError("conflict"))
          }
          if (!prior?.content || !same(source, prior.token) || !same(target, destination?.token))
            return yield* Effect.fail(new DraftError("conflict"))
          if (index < 0 && data.entries.length === 128) return yield* Effect.fail(new DraftError("capacity"))
          const moved = {
            identity: right,
            content: prior.content,
            token: { generation: randomUUID(), revision: (destination?.token.revision ?? 0) + 1 },
            mutation,
            digest: prior.digest,
            receipt: { request },
          }
          prior.content = null
          prior.token = { generation: prior.token.generation, revision: prior.token.revision + 1 }
          prior.mutation = mutation
          prior.digest = hash(null)
          prior.receipt = { request }
          if (index < 0) data.entries.push(moved)
          if (index >= 0) data.entries[index] = moved
          yield* publish(data)
          return { source: prior, target: moved }
        }),
      ),
    snapshot: () => locked(read),
  }
}
