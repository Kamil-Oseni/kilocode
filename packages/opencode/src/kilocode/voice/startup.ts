import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import { hold } from "@/kilocode/task/hold"

/** Automatic reconciliation must not publish imported charges before destination review. */
export function startup<A, E, R>(storage: Storage.Interface, reconcile: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    if (yield* hold(storage).held()) return
    yield* reconcile
  })
}
