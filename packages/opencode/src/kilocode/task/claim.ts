import { createHash } from "node:crypto"
import { Effect, Exit } from "effect"
import type { Storage } from "@/storage/storage"
import type { SessionID } from "@/session/schema"
import { RayaTask } from "."
import { owner as identity, stopped } from "./owner"

type Store = Pick<Storage.Interface, "create" | "replace" | "remove"> & {
  read: (key: string[]) => ReturnType<Storage.Interface["read"]>
}
type Claim = { id: string; at: number; link: (sessionID: SessionID) => Effect.Effect<void> }
const active = new Set<string>()

export function starting(id: string) {
  return active.has(id)
}

/** Own startup until history is recorded. Uncertain startup retains its claim for reconciliation. */
export function claim<A, E, R, B, F, S>(
  storage: Store,
  id: string,
  check: Effect.Effect<A, E, R>,
  start: (input: A, claim: Claim) => Effect.Effect<B, F, S>,
  trigger?: (input: A) => RayaTask.Trigger,
) {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const key = ["raya", "agent-claims", createHash("sha256").update(id).digest("hex")]
      const record = {
        version: 1,
        agentID: id,
        id: crypto.randomUUID(),
        at: Date.now(),
        phase: "claimed",
        owner: identity(),
      }
      const acquired = yield* storage.create(key, record).pipe(Effect.orDie)
      if (!acquired) {
        const previous = yield* storage.read(key).pipe(
          Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
          Effect.orDie,
        )
        const interrupted = previous && typeof previous === "object" && "owner" in previous && stopped(previous.owner)
        return yield* new RayaTask.GuardError({
          message: interrupted
            ? "This routine's previous backend has stopped. Its interrupted start needs recovery before another run."
            : "This routine has another start in progress or an interrupted start awaiting recovery.",
        })
      }
      active.add(record.id)
      return yield* Effect.gen(function* () {
        // This check must remain read-only: failure or interruption here cannot have started work.
        const input = yield* restore(check).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : storage.remove(key).pipe(Effect.orDie))),
        )
        const selected = trigger?.(input)
        const prepared = selected ? { ...record, trigger: selected } : record
        if (selected) yield* storage.replace(key, prepared).pipe(Effect.orDie)
        const owner: Claim = {
          id: record.id,
          at: record.at,
          link: (sessionID) =>
            storage.replace(key, { ...prepared, phase: "session-created", sessionID }).pipe(Effect.orDie),
        }
        return yield* restore(Effect.suspend(() => start(input, owner))).pipe(
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? storage.remove(key).pipe(Effect.orDie) : Effect.void)),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(record.id)
          }),
        ),
      )
    }),
  )
}
