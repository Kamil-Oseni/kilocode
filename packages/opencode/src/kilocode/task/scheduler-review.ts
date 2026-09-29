import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { durable, stopped } from "./owner"
import { read } from "./storage-read"

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Time = Schema.Int.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
const Owner = Schema.Struct({ host: Name, pid: Schema.Int.check(Schema.isGreaterThan(0)), birth: Name })
const Ledger = Schema.Struct({ version: Schema.Literal(1), id: Name, owner: Owner, at: Time })
const Execution = Schema.Struct({
  version: Schema.Literal(1),
  agentID: Name,
  runID: Name,
  sessionID: Name,
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  owner: Owner,
  createdAt: Time,
  updatedAt: Time,
  state: Schema.optional(Schema.Literals(["active", "idle", "recovering"])),
})
const Review = Schema.Struct({ version: Schema.Literal(1), actor: Schema.Literal("user"), at: Time, record: Execution })
export const Context = Schema.Struct({ intent: Text, source: Name, execution: Digest })
type Context = typeof Context.Type
const Snapshot = Schema.Struct({ owner: Name, leaseUntil: Schema.NullOr(Time), updated: Time })
const Identity = Schema.Struct({
  id: Name,
  agentID: Name,
  version: Schema.Int.check(Schema.isGreaterThan(0)),
  scheduledAt: Time,
  observedAt: Time,
  timezone: Schema.NullOr(Name),
  runID: Name,
  sessionID: Name,
  cursor: Time,
})
export const Journal = Schema.Struct({
  version: Schema.Literal(1),
  phase: Schema.Literals(["prepared", "cas", "complete"]),
  identity: Identity,
  review: Context,
  origin: Snapshot,
  prior: Snapshot,
  target: Schema.Struct({ id: Name, owner: Owner, leaseUntil: Time, updated: Time }),
  at: Time,
  updatedAt: Time,
})
export type Journal = typeof Journal.Type
type Identity = typeof Identity.Type
export type Snapshot = typeof Snapshot.Type
type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const ownerKey = (id: string) => ["raya", "scheduler-owners", hash(id)]
const journalKey = (id: string) => ["raya", "scheduler-reviews", hash(id)]
const executionKey = (id: string) => ["raya", "agent-executions", hash(id)]
const reviewKey = (id: string, digest: string) => ["raya", "agent-execution-reviews", hash(id), digest]
const missing = <A>(effect: Effect.Effect<A, Storage.Error>) =>
  effect.pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
const guard = (message: string) => new RayaTask.GuardError({ message })
const decode = <S extends Schema.Top>(schema: S, value: unknown, message: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => guard(message)))
const same = (left: typeof Owner.Type, right: typeof Owner.Type) =>
  left.host === right.host && left.pid === right.pid && left.birth === right.birth

export function schedulerReview(storage: Store) {
  const ledger = (id: string) =>
    missing(read(storage, ownerKey(id))).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(undefined)
          : decode(Ledger, value, "This scheduled occurrence has an invalid durable owner receipt."),
      ),
    )
  const ensure = Effect.fn("RayaTaskSchedulerReview.ensure")(function* (id: string) {
    const found = durable()
    if (!found.birth) return undefined
    const record: typeof Ledger.Type = { version: 1, id, owner: { ...found, birth: found.birth }, at: Date.now() }
    const prior = yield* ledger(id)
    if (prior) {
      if (prior.id !== id || !same(prior.owner, record.owner))
        return yield* guard("This scheduler owner identity changed and needs recovery review.")
      return prior
    }
    if (!(yield* storage.create(ownerKey(id), record).pipe(Effect.orDie)))
      return yield* guard("This scheduler owner changed during admission.")
    return record
  })
  const available = Effect.fn("RayaTaskSchedulerReview.available")(function* (
    id: string,
    current: string,
    expected?: typeof Owner.Type,
  ) {
    const record = yield* ledger(id)
    if (!record || record.id !== id) return yield* guard("This scheduled occurrence has no durable owner receipt.")
    if (expected && !same(record.owner, expected))
      return yield* guard("This scheduled occurrence's durable owner receipt changed.")
    if (id === current) {
      const found = durable()
      if (!found.birth || !same(record.owner, { ...found, birth: found.birth }))
        return yield* guard("This scheduler owner identity changed and needs recovery review.")
      return record
    }
    if (!stopped(record.owner)) return yield* guard("This scheduled occurrence is still owned by another backend.")
    return record
  })
  const execution = Effect.fn("RayaTaskSchedulerReview.execution")(function* (
    run: RayaTask.Run,
    ctx: Context,
    immutable: boolean,
  ) {
    yield* decode(Context, ctx, "This reviewed follow-up has invalid scheduler context.")
    const current = yield* missing(read(storage, executionKey(run.id)))
    const value = immutable
      ? yield* missing(read(storage, reviewKey(run.id, ctx.execution)))
      : current === undefined
        ? yield* missing(read(storage, reviewKey(run.id, ctx.execution)))
        : current
    if (value === undefined) return yield* guard("This reviewed follow-up has no exact execution receipt.")
    const saved = immutable || current === undefined
    const record = saved
      ? (yield* decode(Review, value, "This reviewed follow-up has an invalid execution review.")).record
      : yield* decode(Execution, value, "This reviewed follow-up has an invalid execution receipt.")
    if (
      record.runID !== run.id ||
      record.agentID !== run.agentID ||
      record.sessionID !== run.sessionID ||
      hash(record.token) !== ctx.execution
    )
      return yield* guard("This reviewed follow-up does not match its exact execution receipt.")
    if (immutable && current !== undefined)
      return yield* guard("This reviewed follow-up has a current execution receipt.")
    return record
  })
  const load = (id: string) =>
    missing(read(storage, journalKey(id))).pipe(
      Effect.flatMap((value) =>
        value === undefined
          ? Effect.succeed(undefined)
          : decode(Journal, value, "This scheduled follow-up has an invalid rearm journal."),
      ),
    )
  const prepare = Effect.fn("RayaTaskSchedulerReview.prepare")(function* (input: {
    run: RayaTask.Run
    ctx: Context
    identity: Identity
    row: Snapshot
    owner: typeof Ledger.Type
    until: number
  }) {
    const prior = yield* load(input.run.id)
    const exact =
      prior && isDeepStrictEqual(prior.identity, input.identity) && isDeepStrictEqual(prior.review, input.ctx)
    if (prior && !exact && prior.phase !== "complete")
      return yield* guard("A different scheduler rearm is still pending for this run.")
    if (prior && exact) return prior
    const now = Date.now()
    const journal: Journal = {
      version: 1,
      phase: "prepared",
      identity: input.identity,
      review: input.ctx,
      origin: input.row,
      prior: input.row,
      target: { id: input.owner.id, owner: input.owner.owner, leaseUntil: input.until, updated: now },
      at: now,
      updatedAt: now,
    }
    if (prior) yield* storage.replace(journalKey(input.run.id), journal).pipe(Effect.orDie)
    else if (!(yield* storage.create(journalKey(input.run.id), journal).pipe(Effect.orDie)))
      return yield* guard("This scheduler rearm changed during preparation.")
    return journal
  })
  const replace = Effect.fn("RayaTaskSchedulerReview.replace")(function* (prior: Journal, next: Journal) {
    const current = yield* load(prior.identity.runID)
    if (!current || !isDeepStrictEqual(current, prior))
      return yield* guard("This scheduler rearm journal changed during recovery.")
    yield* storage.replace(journalKey(prior.identity.runID), next).pipe(Effect.orDie)
    return next
  })
  const finish = Effect.fn("RayaTaskSchedulerReview.finish")(function* (
    run: RayaTask.Run,
    row: {
      id: string
      agentID: string
      version: number
      scheduledAt: number
      observedAt: number
      timezone: string | null
    },
  ) {
    const journal = yield* load(run.id)
    if (!journal) return
    if (
      journal.identity.id !== row.id ||
      journal.identity.agentID !== row.agentID ||
      journal.identity.version !== row.version ||
      journal.identity.scheduledAt !== row.scheduledAt ||
      journal.identity.observedAt !== row.observedAt ||
      journal.identity.timezone !== row.timezone ||
      journal.identity.runID !== run.id ||
      journal.identity.sessionID !== run.sessionID
    )
      return yield* guard("This terminal scheduled run does not match its rearm journal.")
    yield* storage.remove(journalKey(run.id)).pipe(Effect.orDie)
  })
  return { ensure, available, execution, load, prepare, replace, finish }
}
