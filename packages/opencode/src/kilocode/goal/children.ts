import { createHash } from "node:crypto"
import { Effect, Fiber, Schema } from "effect"
import { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { RayaGoal } from "."
import { mutation } from "./mutation"

type Deps = {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages" | "children">
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
  origin: SessionID,
  claimedAt: Schema.Finite,
  expiresAt: Schema.Finite,
})
type Lease = typeof Lease.Type

const Record = Schema.Struct({
  version: Schema.Literal(1),
  goalID: SessionID,
  createdAt: Schema.Finite,
  leases: Schema.Array(Lease).check(Schema.isMaxLength(32)),
})
type Record = typeof Record.Type

export const make = Effect.fn("RayaGoalChildren.make")(function* (deps: Deps) {
  yield* Effect.void
  const goals = RayaGoal.make(deps)
  const now = deps.clock ?? Date.now
  const ttl = deps.ttl ?? 60_000
  const heartbeat = deps.heartbeat ?? 10_000

  const locate = Effect.fn("RayaGoalChildren.locate")(function* (sessionID: SessionID) {
    let id: SessionID | undefined = sessionID
    for (let depth = 0; id && depth < 64; depth++) {
      const goal = yield* goals.get(id)
      if (goal?.status === "active" && goal.budget?.concurrentChildren !== undefined) return { id, goal }
      const session: Session.Info | undefined = yield* deps.sessions
        .get(id)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      id = session?.parentID
    }
  })

  const key = (owner: Owner) => [
    "raya",
    "goal-child-reservations",
    createHash("sha256")
      .update(JSON.stringify([owner.id, owner.createdAt]))
      .digest("hex"),
  ]
  const lock = (owner: Owner) => `children:${owner.id}:${owner.createdAt}`

  const load = Effect.fn("RayaGoalChildren.load")(function* (owner: Owner) {
    const raw = yield* deps.storage.read<unknown>(key(owner)).pipe(
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
    if (raw === undefined) return
    const record = yield* Schema.decodeUnknownEffect(Record)(raw).pipe(
      Effect.mapError(() => new Error("Goal concurrent-child reservation state is unreadable.")),
    )
    if (record.goalID !== owner.id || record.createdAt !== owner.createdAt)
      return yield* Effect.fail(new Error("Goal concurrent-child reservation identity changed."))
    return record
  })

  const save = Effect.fn("RayaGoalChildren.save")(function* (owner: Owner, leases: Lease[]) {
    if (!leases.length) {
      yield* deps.storage.remove(key(owner)).pipe(Effect.orDie)
      return
    }
    yield* deps.storage
      .replace(key(owner), {
        version: 1,
        goalID: owner.id,
        createdAt: owner.createdAt,
        leases,
      } satisfies Record)
      .pipe(Effect.orDie)
  })

  const change = <A, E, R>(owner: Owner, body: (record: Record | undefined) => Effect.Effect<A, E, R>) =>
    mutation(
      deps.storage,
      lock(owner),
      Effect.gen(function* () {
        const record = yield* load(owner)
        return yield* body(record)
      }),
    )

  const claim = Effect.fn("RayaGoalChildren.claim")(function* (sessionID: SessionID) {
    const found = yield* locate(sessionID)
    if (!found) return { release: Effect.void }
    const owner: Owner = { id: found.id, createdAt: found.goal.createdAt }
    const token = crypto.randomUUID()
    const admitted = yield* change(
      owner,
      Effect.fnUntraced(function* (record) {
        const goal = yield* goals.get(owner.id)
        if (!goal || goal.createdAt !== owner.createdAt || goal.status !== "active")
          return { kind: "inactive" as const }
        const limit = goal.budget?.concurrentChildren
        if (limit === undefined) return { kind: "unlimited" as const }
        const at = now()
        const active = record?.leases.filter((item) => item.expiresAt > at) ?? []
        if (active.length >= limit) return { kind: "limited" as const, limit }
        yield* save(owner, [
          ...active,
          {
            token,
            origin: sessionID,
            claimedAt: at,
            expiresAt: at + ttl,
          },
        ])
        return { kind: "admitted" as const }
      }),
    )
    if (admitted.kind === "unlimited") return { release: Effect.void }
    if (admitted.kind === "inactive")
      return yield* Effect.fail(new Error("Goal concurrent-child reservation cannot start because the goal changed."))
    if (admitted.kind === "limited")
      return yield* Effect.fail(
        new Error(
          `Goal concurrent-child limit reached (${admitted.limit}). Wait for a delegated task to finish, or review and increase the limit before starting another child.`,
        ),
      )

    const update = (body: (item: Lease) => Lease | null | undefined) =>
      change(
        owner,
        Effect.fnUntraced(function* (record) {
          const item = record?.leases.find((entry) => entry.token === token)
          if (!record || !item) return false
          const next = body(item)
          if (next === undefined) return false
          yield* save(
            owner,
            next !== null
              ? record.leases.map((entry) => (entry.token === token ? next : entry))
              : record.leases.filter((entry) => entry.token !== token),
          )
          return true
        }),
      )
    const fiber = yield* Effect.sleep(heartbeat).pipe(
      Effect.andThen(update((item) => ({ ...item, expiresAt: now() + ttl }))),
      Effect.forever,
      Effect.forkScoped,
    )
    const release = Fiber.interrupt(fiber).pipe(Effect.andThen(update(() => null)), Effect.asVoid)
    return { release }
  })

  return { claim }
})
