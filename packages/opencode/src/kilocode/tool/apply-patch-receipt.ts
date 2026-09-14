import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Conflict, journals } from "./mutation-journal"

export const File = Schema.Struct({
  filePath: Schema.String,
  relativePath: Schema.String,
  type: Schema.Literal("add", "update", "delete", "move"),
  patch: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  movePath: Schema.optional(Schema.String),
})

export const Change = Schema.Struct({
  filePath: Schema.String,
  type: Schema.Literal("add", "update", "delete", "move"),
  movePath: Schema.optional(Schema.String),
})

export const Intent = Schema.Struct({
  version: Schema.Literal(1),
  invocation: Schema.String,
  request: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  workspace: Schema.String,
  diff: Schema.String,
  files: Schema.Array(File),
  changes: Schema.Array(Change),
})

export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  invocation: Schema.String,
  request: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  result: Schema.Struct({
    title: Schema.String,
    output: Schema.String,
    metadata: Schema.Record(Schema.String, Schema.Unknown),
  }),
})

const Session = Schema.Struct({
  version: Schema.Literal(1),
  session: Schema.String,
  invocation: Schema.String,
})

export type Intent = typeof Intent.Type
export type Receipt = typeof Receipt.Type
type Store = Pick<Storage.Interface, "create" | "read" | "remove" | "list">
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const intent = (id: string) => ["raya", "apply-patch-intents", hash(id)]
const receipt = (id: string) => ["raya", "apply-patch-receipts", hash(id)]
const sessions = (id: string) => ["raya", "apply-patch-sessions", hash(id)]
const session = (owner: string, id: string) => [...sessions(owner), hash(id)]
const decodeIntent = Schema.decodeUnknownEffect(Intent)
const decodeReceipt = Schema.decodeUnknownEffect(Receipt)
const decodeSession = Schema.decodeUnknownEffect(Session)

export function seal(value: Omit<Intent, "digest">) {
  return hash(
    JSON.stringify([
      value.version,
      value.invocation,
      value.request,
      value.workspace,
      value.diff,
      value.files,
      value.changes,
    ]),
  )
}

function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024) return Effect.void
  return new Conflict({ message: "Apply Patch replay state exceeds the 8 MiB bound." })
}

export function records(storage: Store) {
  const read = <A>(key: string[], decode: (value: unknown) => Effect.Effect<A, unknown>) =>
    storage.read<unknown>(key).pipe(
      Effect.flatMap(decode),
      Effect.catchIf(
        (error) => Storage.NotFoundError.isInstance(error),
        () => Effect.succeed(undefined),
      ),
    )

  const getIntent = (id: string) =>
    read(intent(id), decodeIntent).pipe(
      Effect.flatMap((value) =>
        !value || (value.invocation === id && value.digest === seal(value))
          ? Effect.succeed(value)
          : new Conflict({ message: "Apply Patch replay intent integrity is invalid." }),
      ),
    )
  const getReceipt = (id: string) =>
    read(receipt(id), decodeReceipt).pipe(
      Effect.flatMap((value) =>
        !value || value.invocation === id
          ? Effect.succeed(value)
          : new Conflict({ message: "Apply Patch response receipt identity is invalid." }),
      ),
    )

  const prepare = Effect.fn("ApplyPatchReceipt.prepare")(function* (owner: string, value: Intent) {
    yield* bounded(value)
    const binding: typeof Session.Type = { version: 1, session: owner, invocation: value.invocation }
    const key = session(owner, value.invocation)
    const owned = yield* storage.create(key, binding)
    if (!owned) {
      const prior = yield* storage.read<unknown>(key).pipe(Effect.flatMap(decodeSession))
      if (prior.session !== owner || prior.invocation !== value.invocation)
        return yield* new Conflict({ message: "Apply Patch session retention identity is invalid." })
    }
    const indexed = yield* storage.list(sessions(owner))
    if (indexed.length > 4_096) {
      if (owned) yield* storage.remove(key)
      return yield* new Conflict({ message: "Apply Patch session retention exceeds the 4096-entry bound." })
    }
    if (yield* storage.create(intent(value.invocation), value)) return value
    const previous = yield* getIntent(value.invocation)
    if (previous && previous.digest === value.digest) return previous
    return yield* new Conflict({ message: "This Apply Patch invocation is already bound to different content." })
  })

  const publish = Effect.fn("ApplyPatchReceipt.publish")(function* (value: Receipt) {
    yield* bounded(value)
    if (yield* storage.create(receipt(value.invocation), value)) return { receipt: value, owned: true as const }
    const previous = yield* getReceipt(value.invocation)
    if (previous && previous.digest === value.digest) return { receipt: previous, owned: false as const }
    return yield* new Conflict({ message: "This Apply Patch invocation has a conflicting response receipt." })
  })

  return { getIntent, getReceipt, prepare, publish }
}

export const cleanup = Effect.fn("ApplyPatchReceipt.cleanup")(function* (storage: Store, owner: string) {
  const keys = yield* storage.list(sessions(owner))
  if (keys.length > 4_096)
    return yield* new Conflict({ message: "Apply Patch session retention exceeds the 4096-entry cleanup bound." })
  const bindings: { key: string[]; value: typeof Session.Type }[] = []
  for (const key of keys) {
    if (key.length !== 4 || key[0] !== "raya" || key[1] !== "apply-patch-sessions" || key[2] !== hash(owner))
      return yield* new Conflict({ message: "Apply Patch session retention key is malformed." })
    const value = yield* storage.read<unknown>(key).pipe(Effect.flatMap(decodeSession))
    if (value.session !== owner || key[3] !== hash(value.invocation))
      return yield* new Conflict({ message: "Apply Patch session retention identity is invalid." })
    bindings.push({ key, value })
  }
  const journal = journals(storage)
  for (const binding of bindings) yield* journal.removable(binding.value.invocation)
  for (const binding of bindings) {
    yield* journal.erase(binding.value.invocation)
    yield* storage.remove(receipt(binding.value.invocation))
    yield* storage.remove(intent(binding.value.invocation))
    yield* storage.remove(binding.key)
  }
  return yield* Effect.void
})
