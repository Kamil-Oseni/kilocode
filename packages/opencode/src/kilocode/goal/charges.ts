import { Effect, SynchronizedRef } from "effect"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { RayaGoal } from "."

type Deps = {
  storage: Storage.Interface
  sessions: Session.Interface
}

type Owner = {
  id: SessionID
  createdAt: number
}

export const make = Effect.fn("RayaGoalCharges.make")(function* (deps: Deps) {
  const state = yield* SynchronizedRef.make(new Map<string, Map<string, number>>())
  const goals = RayaGoal.make(deps)

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

  const claim = Effect.fn("RayaGoalCharges.claim")(function* (sessionID: SessionID, currency: string) {
    const found = yield* locate(sessionID)
    const noop = {
      release: Effect.void,
      settle: (_charge: RayaGoal.Charge) => Effect.void,
    }
    if (!found) return noop
    const owner: Owner = { id: found.id, createdAt: found.goal.createdAt }
    const settle = (charge: RayaGoal.Charge) => goals.charged(owner.id, charge, owner.createdAt).pipe(Effect.asVoid)
    const cfg = found.goal.budget?.chargeCosts?.find((item) => item.currency === currency)
    if (!cfg) return { release: Effect.void, settle }
    const items = found.goal.charges?.filter((item) => item.currency === currency) ?? []
    const spent = items.reduce((sum, item) => sum + (item.coverage === "recorded" ? item.amount : 0), 0)
    if (items.some((item) => item.coverage === "unknown")) {
      yield* goals.limited(owner.id, owner.createdAt, currency, spent, true)
      return yield* Effect.fail(
        new Error(
          `Goal ${currency} non-model charge limit cannot be reconciled because a provider did not report an amount. Remove that currency limit before trying another billed operation.`,
        ),
      )
    }
    if (spent + cfg.reservation > cfg.limit) {
      yield* goals.limited(owner.id, owner.createdAt, currency, spent)
      return yield* Effect.fail(
        new Error(
          `Goal ${currency} non-model charge reservation does not fit the remaining limit (${spent.toFixed(6)} recorded of ${cfg.limit.toFixed(6)}, ${cfg.reservation.toFixed(6)} required). Increase or remove the limit before trying again.`,
        ),
      )
    }
    const key = `${owner.id}:${owner.createdAt}:${currency}`
    const token = crypto.randomUUID()
    const admitted = yield* SynchronizedRef.modify(state, (current) => {
      const active = current.get(key) ?? new Map<string, number>()
      const reserved = [...active.values()].reduce((sum, amount) => sum + amount, 0)
      if (spent + reserved + cfg.reservation > cfg.limit) return [false, current] as const
      const next = new Map(current)
      next.set(key, new Map(active).set(token, cfg.reservation))
      return [true, next] as const
    })
    if (!admitted)
      return yield* Effect.fail(
        new Error(
          `Goal ${currency} non-model charge capacity is reserved by another in-flight operation. Wait for it to settle before trying again.`,
        ),
      )
    const release = SynchronizedRef.update(state, (current) => {
      const active = current.get(key)
      if (!active?.has(token)) return current
      const next = new Map(current)
      const remaining = new Map(active)
      remaining.delete(token)
      if (remaining.size) next.set(key, remaining)
      if (!remaining.size) next.delete(key)
      return next
    })
    return { release, settle }
  })

  return { claim }
})
