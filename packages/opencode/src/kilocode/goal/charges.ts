import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Fiber, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { RayaGoal } from "."
import { mutation } from "./mutation"

type Deps = {
  storage: Storage.Interface
  sessions: Session.Interface
  clock?: () => number
  ttl?: number
  heartbeat?: number
}

type Owner = {
  id: SessionID
  createdAt: number
}

const Lease = Schema.Struct({
  token: Schema.String,
  amount: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
  origin: SessionID,
  claimedAt: Schema.Finite,
  expiresAt: Schema.Finite,
  state: Schema.Literals(["reserved", "dispatched", "settling", "recovering"]),
  receipt: Schema.optional(RayaGoal.Charge),
})
type Lease = typeof Lease.Type

const Record = Schema.Struct({
  version: Schema.Literal(1),
  goalID: SessionID,
  createdAt: Schema.Finite,
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3,8}$/)),
  leases: Schema.Array(Lease).check(Schema.isMaxLength(64)),
})
type Record = typeof Record.Type

export const make = Effect.fn("RayaGoalCharges.make")(function* (deps: Deps) {
  yield* Effect.void
  const goals = RayaGoal.make(deps)
  const now = deps.clock ?? Date.now
  const ttl = deps.ttl ?? 5 * 60_000
  const heartbeat = deps.heartbeat ?? 30_000

  const locate = Effect.fn("RayaGoalCharges.locate")(function* (sessionID: SessionID) {
    let id: SessionID | undefined = sessionID
    for (let depth = 0; id && depth < 64; depth++) {
      const goal = yield* goals.get(id).pipe(Effect.catchTag("RayaGoal.NotFoundError", () => Effect.succeed(undefined)))
      if (goal?.status === "active") return { id, goal }
      const session = yield* deps.sessions
        .get(id)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      id = session?.parentID
    }
  })

  const locateAny = Effect.fn("RayaGoalCharges.locateAny")(function* (sessionID: SessionID) {
    let id: SessionID | undefined = sessionID
    for (let depth = 0; id && depth < 64; depth++) {
      const goal = yield* goals.get(id).pipe(Effect.catchTag("RayaGoal.NotFoundError", () => Effect.succeed(undefined)))
      if (goal) return { id, goal }
      const session = yield* deps.sessions
        .get(id)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      id = session?.parentID
    }
  })

  const key = (owner: Owner, currency: string) => [
    "raya",
    "goal-charge-reservations",
    createHash("sha256")
      .update(JSON.stringify([owner.id, owner.createdAt, currency]))
      .digest("hex"),
  ]
  const lock = (owner: Owner, currency: string) => `charge:${owner.id}:${owner.createdAt}:${currency}`

  const load = Effect.fn("RayaGoalCharges.load")(function* (owner: Owner, currency: string) {
    const raw = yield* deps.storage.read<unknown>(key(owner, currency)).pipe(
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
    if (raw === undefined) return
    const record = yield* Schema.decodeUnknownEffect(Record)(raw).pipe(
      Effect.mapError(
        () => new Error(`Goal ${currency} reservation state is unreadable. Refusing another billed operation.`),
      ),
    )
    if (record.goalID !== owner.id || record.createdAt !== owner.createdAt || record.currency !== currency)
      return yield* Effect.fail(
        new Error(`Goal ${currency} reservation identity changed. Refusing another billed operation.`),
      )
    return record
  })

  const save = Effect.fn("RayaGoalCharges.save")(function* (owner: Owner, currency: string, leases: Lease[]) {
    if (!leases.length) {
      yield* deps.storage.remove(key(owner, currency)).pipe(Effect.orDie)
      return
    }
    yield* deps.storage
      .replace(key(owner, currency), {
        version: 1,
        goalID: owner.id,
        createdAt: owner.createdAt,
        currency,
        leases,
      } satisfies Record)
      .pipe(Effect.orDie)
  })

  const change = <A, E, R>(
    owner: Owner,
    currency: string,
    body: (record: Record | undefined) => Effect.Effect<A, E, R>,
  ) =>
    mutation(
      deps.storage,
      lock(owner, currency),
      Effect.gen(function* () {
        const record = yield* load(owner, currency)
        return yield* body(record)
      }),
    )

  const remove = (owner: Owner, currency: string, token: string) =>
    change(owner, currency, (record) => {
      if (!record?.leases.some((item) => item.token === token)) return Effect.void
      return save(
        owner,
        currency,
        record.leases.filter((item) => item.token !== token),
      )
    })

  const recover = Effect.fn("RayaGoalCharges.recover")(function* (owner: Owner, currency: string) {
    const stale = yield* change(
      owner,
      currency,
      Effect.fnUntraced(function* (record) {
        if (!record) return []
        const at = now()
        const expired = record.leases.filter((item) => item.expiresAt <= at && item.state !== "recovering")
        const pending = record.leases.filter((item) => item.state === "recovering")
        const dropped = new Set(expired.filter((item) => item.state === "reserved").map((item) => item.token))
        const reconcile = expired
          .filter((item) => item.state !== "reserved")
          .map((item) => ({ ...item, state: "recovering" as const }))
        const ids = new Set(reconcile.map((item) => item.token))
        const leases = record.leases
          .filter((item) => !dropped.has(item.token))
          .map((item) => reconcile.find((next) => next.token === item.token) ?? item)
        if (dropped.size || ids.size) yield* save(owner, currency, leases)
        return [...pending, ...reconcile]
      }),
    )
    for (const item of stale) {
      const charge =
        item.receipt ??
        ({
          id: `goal-reservation:${item.token}`,
          kind: "tool",
          source: "durable-reservation-expired",
          origin: { sessionID: item.origin, callID: item.token },
          at: item.claimedAt,
          coverage: "unknown",
          currency,
          reason: "The billed operation lost its backend before the provider charge was settled.",
        } satisfies RayaGoal.Charge)
      yield* goals.charged(owner.id, charge, owner.createdAt)
      yield* remove(owner, currency, item.token)
    }
    return stale.length > 0
  })

  const complete = Effect.fn("RayaGoalCharges.complete")(function* (
    sessionID: SessionID,
    currency: string,
    identity: string,
  ) {
    if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(identity))
      return yield* Effect.fail(new Error(`Goal ${currency} reservation identity is invalid.`))
    const found = yield* locateAny(sessionID)
    if (!found) return false
    const owner: Owner = { id: found.id, createdAt: found.goal.createdAt }
    return yield* change(
      owner,
      currency,
      Effect.fnUntraced(function* (record) {
        const item = record?.leases.find((entry) => entry.token === identity)
        if (!record || !item) return false
        if (item.origin !== sessionID)
          return yield* Effect.fail(new Error(`Goal ${currency} reservation identity belongs to another session.`))
        if (item.state === "settling" || item.state === "recovering")
          return yield* Effect.fail(new Error(`Goal ${currency} reservation is already reconciling a receipt.`))
        yield* save(
          owner,
          currency,
          record.leases.filter((entry) => entry.token !== identity),
        )
        return true
      }),
    )
  })

  const claim = Effect.fn("RayaGoalCharges.claim")(function* (
    sessionID: SessionID,
    currency: string,
    identity?: string,
  ) {
    const noop = {
      amount: undefined,
      dispatch: Effect.void,
      finish: Effect.void,
      release: Effect.void,
      uncertain: (_reason: string) => Effect.void,
      settle: (_charge: RayaGoal.Charge) => Effect.void,
    }
    if (identity !== undefined && !/^[a-zA-Z0-9:_-]{1,256}$/.test(identity))
      return yield* Effect.fail(new Error(`Goal ${currency} reservation identity is invalid.`))
    const found = yield* locate(sessionID)
    if (!found) return noop
    const owner: Owner = { id: found.id, createdAt: found.goal.createdAt }
    const direct = (charge: RayaGoal.Charge) => goals.charged(owner.id, charge, owner.createdAt).pipe(Effect.asVoid)
    yield* recover(owner, currency)
    const current = yield* goals.get(owner.id)
    if (!current || current.createdAt !== owner.createdAt)
      return yield* Effect.fail(new Error(`Goal ${currency} charge reservation belongs to an obsolete goal lifecycle.`))
    if (current.status !== "active")
      return yield* Effect.fail(
        new Error(`Goal ${currency} charge reservation cannot start while the goal is ${current.status}.`),
      )
    const token = identity ?? crypto.randomUUID()
    const unknown = (reason: string): RayaGoal.Charge => ({
      id: `goal-reservation:${token}`,
      kind: "tool",
      source: "provider-response-without-receipt",
      origin: { sessionID, callID: token },
      at: now(),
      coverage: "unknown",
      currency,
      reason: reason.trim().slice(0, 240) || "The provider completed the billed operation without a stable receipt.",
    })
    const cfg = current.budget?.chargeCosts?.find((item) => item.currency === currency)
    if (!cfg) return { ...noop, uncertain: (reason: string) => direct(unknown(reason)), settle: direct }

    const admitted = yield* change(
      owner,
      currency,
      Effect.fnUntraced(function* (record) {
        const goal = yield* goals.get(owner.id)
        if (!goal || goal.createdAt !== owner.createdAt || goal.status !== "active")
          return { kind: "inactive" as const }
        const limit = goal.budget?.chargeCosts?.find((item) => item.currency === currency)
        if (!limit) return { kind: "unlimited" as const }
        const prior = record?.leases.find((item) => item.token === token)
        if (prior) {
          if (prior.origin !== sessionID) return { kind: "identity" as const }
          return { kind: "admitted" as const }
        }
        const items = goal.charges?.filter((item) => item.currency === currency) ?? []
        const spent = items.reduce((sum, item) => sum + (item.coverage === "recorded" ? item.amount : 0), 0)
        if (items.some((item) => item.coverage === "unknown")) return { kind: "unknown" as const, spent }
        if (spent + limit.reservation > limit.limit) return { kind: "limit" as const, spent, limit }
        const active = record?.leases ?? []
        const reserved = active.reduce((sum, item) => sum + item.amount, 0)
        if (active.length >= 64) return { kind: "capacity" as const }
        if (spent + reserved + limit.reservation > limit.limit) return { kind: "capacity" as const }
        const at = now()
        yield* save(owner, currency, [
          ...active,
          {
            token,
            amount: limit.reservation,
            origin: sessionID,
            claimedAt: at,
            expiresAt: at + ttl,
            state: "reserved",
          },
        ])
        return { kind: "admitted" as const }
      }),
    )
    if (admitted.kind === "unlimited")
      return { ...noop, uncertain: (reason: string) => direct(unknown(reason)), settle: direct }
    if (admitted.kind === "inactive")
      return yield* Effect.fail(new Error(`Goal ${currency} charge reservation cannot start because the goal changed.`))
    if (admitted.kind === "identity")
      return yield* Effect.fail(new Error(`Goal ${currency} reservation identity belongs to another session.`))
    if (admitted.kind === "unknown") {
      yield* goals.limited(owner.id, owner.createdAt, currency, admitted.spent, true)
      return yield* Effect.fail(
        new Error(
          `Goal ${currency} non-model charge limit cannot be reconciled because a provider did not report an amount. Remove that currency limit before trying another billed operation.`,
        ),
      )
    }
    if (admitted.kind === "limit") {
      yield* goals.limited(owner.id, owner.createdAt, currency, admitted.spent)
      return yield* Effect.fail(
        new Error(
          `Goal ${currency} non-model charge reservation does not fit the remaining limit (${admitted.spent.toFixed(6)} recorded of ${admitted.limit.limit.toFixed(6)}, ${admitted.limit.reservation.toFixed(6)} required). Increase or remove the limit before trying again.`,
        ),
      )
    }
    if (admitted.kind === "capacity")
      return yield* Effect.fail(
        new Error(
          `Goal ${currency} non-model charge capacity is reserved by another in-flight operation. Wait for it to settle before trying again.`,
        ),
      )

    const update = (body: (item: Lease) => Lease | null | undefined) =>
      change(
        owner,
        currency,
        Effect.fnUntraced(function* (record) {
          const item = record?.leases.find((entry) => entry.token === token)
          if (!record || !item) return false
          const next = body(item)
          if (next === undefined) return false
          yield* save(
            owner,
            currency,
            next !== null
              ? record.leases.map((entry) => (entry.token === token ? next : entry))
              : record.leases.filter((entry) => entry.token !== token),
          )
          return true
        }),
      )

    const fiber = yield* Effect.sleep(heartbeat).pipe(
      Effect.andThen(update((item) => (item.state === "recovering" ? undefined : { ...item, expiresAt: now() + ttl }))),
      Effect.forever,
      Effect.forkScoped,
    )
    const dispatch = update((item) => {
      if (item.state === "dispatched") return { ...item, expiresAt: now() + ttl }
      if (item.state === "reserved") return { ...item, state: "dispatched", expiresAt: now() + ttl }
      return undefined
    }).pipe(
      Effect.flatMap((changed) =>
        changed ? Effect.void : Effect.fail(new Error(`Goal ${currency} reservation cannot be dispatched.`)),
      ),
    )
    const finish = update((item) => (item.state === "dispatched" ? null : undefined)).pipe(
      Effect.flatMap((changed) =>
        changed ? Effect.void : Effect.fail(new Error(`Goal ${currency} reservation cannot be finalized.`)),
      ),
    )
    const settle = (charge: RayaGoal.Charge) =>
      Effect.gen(function* () {
        if (charge.currency !== currency || charge.origin.sessionID !== sessionID)
          return yield* Effect.fail(new Error(`Goal ${currency} reservation received an unrelated billing receipt.`))
        const staged = yield* update((item) => {
          if (item.state === "settling" && item.receipt && isDeepStrictEqual(item.receipt, charge)) return item
          if (item.state !== "dispatched") return
          return { ...item, state: "settling", receipt: charge, expiresAt: now() + ttl }
        })
        if (!staged) return yield* Effect.fail(new Error(`Goal ${currency} reservation is no longer owned.`))
        yield* direct(charge)
        yield* remove(owner, currency, token)
      })
    const uncertain = (reason: string) => settle(unknown(reason))
    const release = Fiber.interrupt(fiber).pipe(
      Effect.andThen(
        update((item) => {
          if (item.state === "reserved") return null
          return undefined
        }),
      ),
      Effect.asVoid,
    )
    return { amount: cfg.reservation, dispatch, finish, release, uncertain, settle }
  })

  return { claim, complete }
})
