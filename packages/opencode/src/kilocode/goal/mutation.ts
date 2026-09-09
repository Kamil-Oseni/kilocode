import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { Storage } from "@/storage/storage"
import { mutate } from "@/kilocode/task/mutation"

type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">

/** Reuse filesystem claim/recovery semantics in a separate, per-goal namespace. */
export function mutation<A, E, R>(storage: Store, id: string, operation: Effect.Effect<A, E, R>) {
  const key = (parts: string[]) => [
    "raya",
    "goal-mutations",
    createHash("sha256")
      .update(JSON.stringify([id, parts]))
      .digest("hex"),
  ]
  return mutate(
    {
      read: (parts) => storage.read(key(parts)),
      create: (parts, value) => storage.create(key(parts), value),
      replace: (parts, value) => storage.replace(key(parts), value),
      remove: (parts) => storage.remove(key(parts)),
    },
    operation,
    "Goal",
  )
}
