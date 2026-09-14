import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { owner as identity, stopped } from "@/kilocode/task/owner"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const Identity = Schema.Struct({ dev: Schema.String, ino: Schema.String })
const Proof = Schema.Struct({ identity: Identity, sha256: Schema.String })
const Anchor = Schema.Struct({ path: Schema.String, identity: Identity })
const Result = Schema.Struct({ sha256: Schema.String })
export const Entry = Schema.Struct({
  kind: Schema.Literals(["create", "replace", "remove"]),
  target: Schema.String,
  stage: Schema.optional(Schema.String),
  hold: Schema.optional(Schema.String),
  review: Schema.optional(Proof),
  result: Schema.optional(Result),
  artifact: Schema.optional(Proof),
  anchor: Schema.optional(Anchor),
})
export const Phase = Schema.Literals([
  "reserved",
  "staging",
  "prepared",
  "committing",
  "committed",
  "rolling_back",
  "rolled_back",
  "cleaning",
  "releasing",
  "done",
  "conflict",
])
const Owner = Schema.Struct({ host: Schema.String, pid: Schema.Number })
const Recovery = Schema.Struct({ id: Schema.String, owner: Schema.String })
export const Outcome = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  invocation: Schema.String,
  digest: Schema.String,
  workspace: Schema.String,
  entries: Schema.Array(Entry),
  phase: Phase,
  revision: Schema.Number,
  cursor: Schema.Number,
  decision: Schema.optional(Schema.Literals(["commit", "rollback"])),
  owner: Owner,
  authority: Schema.optional(Schema.String),
  recovery: Schema.optional(Recovery),
  at: Schema.Number,
  reason: Schema.optional(Schema.String),
})
const Claim = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  invocation: Schema.String,
  target: Schema.String,
  owner: Schema.String,
})
const Permit = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  transaction: Schema.String,
  revision: Schema.Number,
  owner: Owner,
  secret: Schema.String,
})
const Active = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  invocation: Schema.String,
  owner: Owner,
})

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("RayaMutationJournal.Conflict", {
  message: Schema.String,
}) {}

type Store = Pick<Storage.Interface, "create" | "read" | "remove" | "list">
type Plan = {
  readonly invocation: string
  readonly digest: string
  readonly workspace: string
  readonly entries: ReadonlyArray<typeof Entry.Type>
}
type Advance = {
  readonly token: string
  readonly revision: number
  readonly phase: typeof Phase.Type
  readonly cursor: number
  readonly entries?: ReadonlyArray<typeof Entry.Type>
  readonly reason?: string
}

const transitions: Record<typeof Phase.Type, ReadonlySet<typeof Phase.Type>> = {
  reserved: new Set(["staging", "rolling_back", "conflict"]),
  staging: new Set(["staging", "prepared", "rolling_back", "conflict"]),
  prepared: new Set(["committing", "rolling_back", "conflict"]),
  committing: new Set(["committing", "committed", "rolling_back", "conflict"]),
  committed: new Set(["cleaning", "conflict"]),
  rolling_back: new Set(["rolling_back", "rolled_back", "conflict"]),
  rolled_back: new Set(["cleaning", "conflict"]),
  cleaning: new Set(["cleaning", "releasing", "conflict"]),
  releasing: new Set(["done", "conflict"]),
  done: new Set(),
  conflict: new Set(),
}

const lower = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
const journal = (id: string, revision: number) => ["raya", "file-transactions", hash(id), String(revision)]
const ownership = (target: string) => ["raya", "file-transaction-targets", hash(lower(target))]
const recovery = (id: string, prior: string) => ["raya", "file-transaction-recovery", hash(id), hash(prior)]
const active = (id: string) => ["raya", "file-transaction-active", id]
const activeRoot = ["raya", "file-transaction-active"]
const decode = Schema.decodeUnknownEffect(Outcome)
const decodeClaim = Schema.decodeUnknownEffect(Claim)
const decodePermit = Schema.decodeUnknownEffect(Permit)
const decodeActive = Schema.decodeUnknownEffect(Active)

function valid(entries: ReadonlyArray<typeof Entry.Type>) {
  if (entries.length === 0 || entries.length > 256) return false
  const targets = new Set<string>()
  const sidecars = new Set<string>()
  for (const entry of entries) {
    if (!path.isAbsolute(entry.target) || entry.target.length > 32_768) return false
    const target = lower(path.resolve(entry.target))
    if (targets.has(target) || sidecars.has(target)) return false
    targets.add(target)
    if (!entry.result && entry.kind !== "remove") return false
    if (!entry.review && entry.kind !== "create") return false
    if (!entry.anchor && entry.kind === "create") return false
    if (!entry.stage && entry.kind !== "remove") return false
    if (!entry.hold && entry.kind !== "create") return false
    if (entry.artifact && entry.result?.sha256 !== entry.artifact.sha256) return false
    for (const sidecar of [entry.stage, entry.hold]) {
      if (!sidecar) continue
      if (!path.isAbsolute(sidecar) || lower(path.dirname(sidecar)) !== lower(path.dirname(entry.target))) return false
      if (!path.basename(sidecar).startsWith(".raya-txn-")) return false
      const resolved = lower(path.resolve(sidecar))
      if (resolved === target || sidecars.has(resolved)) return false
      sidecars.add(resolved)
    }
    for (const sha256 of [entry.review?.sha256, entry.result?.sha256, entry.artifact?.sha256]) {
      if (sha256 !== undefined && !/^[a-f0-9]{64}$/.test(sha256)) return false
    }
    for (const identity of [entry.review?.identity, entry.artifact?.identity, entry.anchor?.identity]) {
      if (identity && (!/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino))) return false
    }
    if (entry.anchor && !path.isAbsolute(entry.anchor.path)) return false
  }
  return true
}

function same(previous: ReadonlyArray<typeof Entry.Type>, next: ReadonlyArray<typeof Entry.Type>) {
  if (previous.length !== next.length) return false
  return previous.every((entry, index) => {
    const item = next[index]
    if (
      entry.kind !== item.kind ||
      entry.target !== item.target ||
      entry.stage !== item.stage ||
      entry.hold !== item.hold ||
      JSON.stringify(entry.review) !== JSON.stringify(item.review) ||
      JSON.stringify(entry.result) !== JSON.stringify(item.result) ||
      JSON.stringify(entry.anchor) !== JSON.stringify(item.anchor)
    )
      return false
    return !entry.artifact || JSON.stringify(entry.artifact) === JSON.stringify(item.artifact)
  })
}

export function journals(storage: Store) {
  const read = Effect.fn("RayaMutationJournal.read")(function* (id: string) {
    const first = yield* storage.read<unknown>(journal(id, 0)).pipe(
      Effect.flatMap(decode),
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
    )
    if (!first) return
    let outcome = first
    for (let revision = 1; revision <= 2_048; revision++) {
      const next = yield* storage.read<unknown>(journal(id, revision)).pipe(
        Effect.flatMap(decode),
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      )
      if (!next) return outcome
      if (next.id !== outcome.id || next.invocation !== id || next.revision !== revision)
        return yield* new Conflict({ message: "Mutation journal revision identity is invalid." })
      outcome = next
    }
    return yield* new Conflict({ message: "Mutation journal exceeded its bounded revision history." })
  })

  const get = (id: string) => read(id)

  const release = Effect.fn("RayaMutationJournal.release")(function* (outcome: typeof Outcome.Type, strict = true) {
    for (const entry of outcome.entries) {
      const key = ownership(entry.target)
      const claim = yield* storage.read<unknown>(key).pipe(
        Effect.flatMap(decodeClaim),
        Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      )
      if (!claim) continue
      if (claim.id !== outcome.id || claim.invocation !== outcome.invocation) {
        if (strict) return yield* new Conflict({ message: `Mutation target ownership changed for ${entry.target}.` })
        continue
      }
      yield* storage.remove(key)
    }
  })

  const admit = Effect.fn("RayaMutationJournal.admit")(function* (input: Plan) {
    if (!input.invocation || !/^[a-f0-9]{64}$/.test(input.digest) || !path.isAbsolute(input.workspace))
      return yield* new Conflict({ message: "Mutation identity or workspace is invalid." })
    if (!valid(input.entries)) return yield* new Conflict({ message: "Mutation entries are invalid or ambiguous." })
    const token = crypto.randomUUID()
    const owner = hash(token)
    const outcome: typeof Outcome.Type = {
      version: 1,
      id: crypto.randomUUID(),
      invocation: input.invocation,
      digest: input.digest,
      workspace: path.resolve(input.workspace),
      entries: [...input.entries],
      phase: "reserved",
      revision: 0,
      cursor: 0,
      owner: { host: os.hostname(), pid: process.pid },
      authority: owner,
      at: Date.now(),
    }
    const index: typeof Active.Type = {
      version: 1,
      id: outcome.id,
      invocation: outcome.invocation,
      owner: outcome.owner,
    }
    if (!(yield* storage.create(active(outcome.id), index)))
      return yield* new Conflict({ message: "Mutation active index ownership could not be recorded." })
    if (!(yield* storage.create(journal(input.invocation, 0), outcome))) {
      yield* storage.remove(active(outcome.id))
      const previous = yield* read(input.invocation)
      if (!previous || previous.digest !== input.digest)
        return yield* new Conflict({ message: "This mutation invocation is already bound to different content." })
      return { owned: false as const, outcome: previous }
    }
    const acquired: (typeof Entry.Type)[] = []
    for (const entry of [...outcome.entries].toSorted((a, b) => lower(a.target).localeCompare(lower(b.target)))) {
      const claim: typeof Claim.Type = {
        version: 1,
        id: outcome.id,
        invocation: outcome.invocation,
        target: entry.target,
        owner,
      }
      if (yield* storage.create(ownership(entry.target), claim)) {
        acquired.push(entry)
        continue
      }
      const conflict: typeof Outcome.Type = {
        ...outcome,
        phase: "conflict",
        revision: 1,
        reason: `Another durable transaction owns ${entry.target}.`,
        at: Date.now(),
      }
      yield* release({ ...outcome, entries: acquired })
      if (!(yield* storage.create(journal(input.invocation, 1), conflict)))
        return yield* new Conflict({ message: "Mutation ownership conflict could not be recorded." })
      yield* storage.remove(active(outcome.id))
      return { owned: false as const, outcome: conflict }
    }
    const staging: typeof Outcome.Type = { ...outcome, phase: "staging", revision: 1, at: Date.now() }
    if (!(yield* storage.create(journal(input.invocation, 1), staging)))
      return yield* new Conflict({ message: "Mutation staging ownership could not be recorded." })
    return { owned: true as const, outcome: staging, token }
  })

  const advance = Effect.fn("RayaMutationJournal.advance")(function* (id: string, input: Advance) {
    const previous = yield* read(id)
    if (!previous) return yield* new Conflict({ message: "Mutation journal ownership changed." })
    const owner = hash(input.token)
    const authority = previous.authority ?? previous.recovery?.owner
    if (authority && authority !== owner) return yield* new Conflict({ message: "Mutation journal authority changed." })
    if (previous.phase !== "releasing") {
      for (const entry of previous.entries) {
        const claim = yield* storage.read<unknown>(ownership(entry.target)).pipe(
          Effect.flatMap(decodeClaim),
          Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        )
        if (!claim || claim.id !== previous.id || (!authority && claim.owner !== owner))
          return yield* new Conflict({ message: "Mutation journal ownership changed." })
      }
    }
    if (previous.revision !== input.revision || !transitions[previous.phase].has(input.phase))
      return yield* new Conflict({ message: "Mutation journal phase or revision changed." })
    const reset = input.phase !== previous.phase && ["committing", "rolling_back", "cleaning"].includes(input.phase)
    if (
      !Number.isInteger(input.cursor) ||
      input.cursor < (reset ? 0 : previous.cursor) ||
      input.cursor > previous.entries.length
    )
      return yield* new Conflict({ message: "Mutation journal cursor is invalid." })
    const entries = input.entries ? [...input.entries] : previous.entries
    if (!valid(entries) || !same(previous.entries, entries))
      return yield* new Conflict({ message: "Mutation journal entries changed after reservation." })
    if (
      (["prepared", "committed", "rolled_back", "releasing", "done"].includes(input.phase) &&
        input.cursor !== entries.length) ||
      (input.phase === "prepared" && entries.some((entry) => entry.kind !== "remove" && !entry.artifact))
    )
      return yield* new Conflict({ message: "Mutation journal phase is incomplete." })
    const outcome: typeof Outcome.Type = {
      ...previous,
      entries,
      phase: input.phase,
      revision: previous.revision + 1,
      cursor: input.cursor,
      ...(input.phase === "committed"
        ? { decision: "commit" as const }
        : input.phase === "rolled_back"
          ? { decision: "rollback" as const }
          : {}),
      at: Date.now(),
      ...(input.reason ? { reason: input.reason } : {}),
    }
    if (outcome.phase === "done") yield* release(previous, false)
    if (!(yield* storage.create(journal(id, outcome.revision), outcome)))
      return yield* new Conflict({ message: "Another caller already advanced this mutation." })
    if (outcome.phase === "releasing") yield* release(outcome, false)
    if (outcome.phase === "done") yield* storage.remove(active(outcome.id))
    return outcome
  })

  const recover = Effect.fn("RayaMutationJournal.recover")(function* (
    id: string,
    authorize?: (outcome: typeof Outcome.Type) => Effect.Effect<boolean>,
  ) {
    const outcome = yield* read(id)
    if (!outcome || outcome.phase === "done" || outcome.phase === "conflict") return { owned: false as const, outcome }
    const allowed = authorize ? yield* authorize(outcome) : stopped(outcome.owner)
    if (!allowed) return { owned: false as const, outcome }
    let prior = outcome.recovery?.id ?? outcome.id
    for (let depth = 0; depth < 64; depth++) {
      const token = crypto.randomUUID()
      const permit: typeof Permit.Type = {
        version: 1,
        id: crypto.randomUUID(),
        transaction: outcome.id,
        revision: outcome.revision,
        owner: identity(),
        secret: hash(token),
      }
      const key = recovery(id, prior)
      if (!(yield* storage.create(key, permit))) {
        const previous = yield* storage.read<unknown>(key).pipe(
          Effect.flatMap(decodePermit),
          Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
        )
        if (
          !previous ||
          previous.transaction !== outcome.id ||
          previous.revision !== outcome.revision ||
          !stopped(previous.owner)
        )
          return { owned: false as const, outcome: yield* read(id) }
        prior = previous.id
        continue
      }
      const current = yield* read(id)
      const still = current && JSON.stringify(current) === JSON.stringify(outcome)
      const authorized = current && (authorize ? yield* authorize(current) : stopped(current.owner))
      if (!current || !still || !authorized) return { owned: false as const, outcome: current }
      let blocked: string | undefined
      if (current.phase !== "releasing") {
        for (const entry of [...current.entries].toSorted((a, b) => lower(a.target).localeCompare(lower(b.target)))) {
          const key = ownership(entry.target)
          const existing = yield* storage.read<unknown>(key).pipe(
            Effect.flatMap(decodeClaim),
            Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
          )
          if (existing?.id === current.id && existing.invocation === current.invocation) continue
          if (existing) {
            blocked = entry.target
            break
          }
          const claim: typeof Claim.Type = {
            version: 1,
            id: current.id,
            invocation: current.invocation,
            target: entry.target,
            owner: permit.secret,
          }
          if (yield* storage.create(key, claim)) continue
          const raced = yield* storage.read<unknown>(key).pipe(Effect.flatMap(decodeClaim))
          if (raced.id === current.id && raced.invocation === current.invocation) continue
          blocked = entry.target
          break
        }
      }
      if (blocked) {
        yield* release(current, false)
        const conflict: typeof Outcome.Type = {
          ...current,
          phase: "conflict",
          revision: current.revision + 1,
          owner: permit.owner,
          authority: permit.secret,
          recovery: { id: permit.id, owner: permit.secret },
          at: Date.now(),
          reason: `Another durable transaction owns ${blocked}.`,
        }
        if (!(yield* storage.create(journal(id, conflict.revision), conflict)))
          return { owned: false as const, outcome: yield* read(id) }
        return { owned: false as const, outcome: conflict }
      }
      const adopted: typeof Outcome.Type = {
        ...current,
        revision: current.revision + 1,
        owner: permit.owner,
        authority: permit.secret,
        recovery: { id: permit.id, owner: permit.secret },
        at: Date.now(),
      }
      if (!(yield* storage.create(journal(id, adopted.revision), adopted)))
        return { owned: false as const, outcome: yield* read(id) }
      return { owned: true as const, outcome: adopted, token }
    }
    return yield* new Conflict({ message: "Mutation recovery ownership exceeded its bounded ancestry." })
  })

  const pending = Effect.fn("RayaMutationJournal.pending")(function* () {
    const keys = yield* storage.list(activeRoot)
    const issues: { key: string; reason: string }[] = []
    const outcomes: (typeof Outcome.Type)[] = []
    if (keys.length > 1_024)
      issues.push({ key: activeRoot.join("/"), reason: `Active mutation index exceeds the 1024-entry scan bound.` })
    for (const key of keys.slice(0, 1_024)) {
      const name = key.join("/")
      if (key.length !== activeRoot.length + 1 || key[0] !== activeRoot[0] || key[1] !== activeRoot[1]) {
        issues.push({ key: name, reason: "Active mutation index key is malformed." })
        continue
      }
      const decoded = yield* Effect.exit(storage.read<unknown>(key).pipe(Effect.flatMap(decodeActive)))
      if (Exit.isFailure(decoded)) {
        issues.push({ key: name, reason: Cause.pretty(decoded.cause) })
        continue
      }
      const index = decoded.value
      if (index.id !== key[2]) {
        issues.push({ key: name, reason: "Active mutation index identity is malformed." })
        continue
      }
      const loaded = yield* Effect.exit(read(index.invocation))
      if (Exit.isFailure(loaded)) {
        issues.push({ key: name, reason: Cause.pretty(loaded.cause) })
        continue
      }
      const outcome = loaded.value
      if (!outcome) {
        if (stopped(index.owner)) yield* storage.remove(key)
        continue
      }
      if (outcome.id !== index.id) {
        if (stopped(index.owner)) {
          yield* storage.remove(key)
          continue
        }
        issues.push({ key: name, reason: "Active mutation index references another transaction." })
        continue
      }
      if (outcome.phase === "done") {
        yield* storage.remove(key)
        continue
      }
      outcomes.push(outcome)
    }
    return { outcomes, issues, truncated: keys.length > 1_024 }
  })

  return { get, admit, advance, recover, pending }
}
