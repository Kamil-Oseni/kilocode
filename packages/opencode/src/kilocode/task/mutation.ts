import { Effect, Semaphore } from "effect"
import type { Storage } from "@/storage/storage"
import { claim } from "./claim"
import { recover } from "./recovery"

type Store = Pick<Storage.Interface, "read" | "create" | "replace" | "remove">
const gates = new WeakMap<Store, ReturnType<typeof Semaphore.makeUnsafe>>()

/** One storage-wide gate keeps internal roster/history updates from taking locks in opposite orders. */
export function mutate<A, E, R>(storage: Store, operation: Effect.Effect<A, E, R>, name = "Routine") {
  // Local contenders must not repeatedly read the claim while its owner waits to remove it.
  // The durable claim still arbitrates other storage services and backend processes.
  const gate = gates.get(storage) ?? Semaphore.makeUnsafe(1)
  gates.set(storage, gate)
  const key = (parts: string[]) => [parts[0], `mutation-${parts[1]}`, ...parts.slice(2)]
  const scoped = {
    read: (parts: string[]) => storage.read(key(parts)),
    create: (parts: string[], value: unknown) => storage.create(key(parts), value),
    replace: (parts: string[], value: unknown) => storage.replace(key(parts), value),
    remove: (parts: string[]) => storage.remove(key(parts)),
  }
  return Effect.gen(function* () {
    const deadline = Date.now() + 5_000
    while (true) {
      // A new mutation rereads current records; it never replays a stopped owner's operation.
      yield* recover(scoped, "routines", () => Effect.succeed(true))
      const result = yield* claim(scoped, "routines", Effect.void, () => Effect.exit(operation)).pipe(
        Effect.uninterruptible,
        Effect.catchTag("RayaTask.GuardError", () => Effect.succeed(undefined)),
      )
      if (result) return yield* result
      if (Date.now() >= deadline) return yield* Effect.die(new Error(`${name} data is busy. Try the change again.`))
      yield* Effect.sleep("20 millis")
    }
  }).pipe(gate.withPermits(1))
}
