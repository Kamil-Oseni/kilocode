import { Effect, SynchronizedRef } from "effect"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { RayaGoal } from "."

type Deps = {
  storage: Storage.Interface
  sessions: Session.Interface
}

export const make = Effect.fn("RayaGoalChildren.make")(function* (deps: Deps) {
  const state = yield* SynchronizedRef.make(new Map<SessionID, Set<string>>())
  const goals = RayaGoal.make(deps)

  const locate = Effect.fn("RayaGoalChildren.locate")(function* (sessionID: SessionID) {
    let id: SessionID | undefined = sessionID
    for (let depth = 0; id && depth < 64; depth++) {
      const goal = yield* goals.get(id).pipe(Effect.catchTag("RayaGoal.NotFoundError", () => Effect.succeed(undefined)))
      if (goal?.status === "active" && goal.budget?.concurrentChildren !== undefined)
        return { id, limit: goal.budget.concurrentChildren }
      const session = yield* deps.sessions
        .get(id)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      id = session?.parentID
    }
  })

  const claim = Effect.fn("RayaGoalChildren.claim")(function* (sessionID: SessionID) {
    const goal = yield* locate(sessionID)
    if (!goal) return { release: Effect.void }
    const token = crypto.randomUUID()
    const admitted = yield* SynchronizedRef.modify(state, (current) => {
      const active = current.get(goal.id) ?? new Set<string>()
      if (active.size >= goal.limit) return [false, current] as const
      const next = new Map(current)
      next.set(goal.id, new Set(active).add(token))
      return [true, next] as const
    })
    if (!admitted)
      return yield* Effect.fail(
        new Error(
          `Goal concurrent-child limit reached (${goal.limit}). Wait for a delegated task to finish, or review and increase the limit before starting another child.`,
        ),
      )
    const release = SynchronizedRef.update(state, (current) => {
      const active = current.get(goal.id)
      if (!active?.has(token)) return current
      const next = new Map(current)
      const remaining = new Set(active)
      remaining.delete(token)
      if (remaining.size) next.set(goal.id, remaining)
      if (!remaining.size) next.delete(goal.id)
      return next
    })
    return { release }
  })

  return { claim }
})
