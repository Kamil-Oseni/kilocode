import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { mutate } from "./mutation"

const key = ["raya", "restore-hold"]
const record = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isMinLength(1)),
  state: Schema.Literals(["held", "released"]),
  createdAt: Schema.Finite,
  review: Schema.optional(
    Schema.Struct({ at: Schema.Finite, by: Schema.Literal("user"), revision: Schema.optional(Schema.String) }),
  ),
})
type Store = Pick<Storage.Interface, "read" | "replace" | "create" | "remove" | "list">

/** Portable transfer authority is distinct from process ownership and archived stop fences. */
export function hold(storage: Store) {
  const get = () =>
    storage.read<unknown>(key).pipe(
      Effect.catchIf(
        (err) => Storage.NotFoundError.isInstance(err),
        () => Effect.succeed(undefined),
      ),
      Effect.flatMap((value) =>
        value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(record)(value),
      ),
      Effect.flatMap((value) =>
        value?.state === "released" && !value.review
          ? Effect.fail(new Error("Missing destination review receipt"))
          : Effect.succeed(value),
      ),
      Effect.mapError(
        () =>
          new RayaTask.GuardError({
            kind: "unavailable",
            field: "restore-hold",
            message: "This profile's transfer review state is unreadable. Repair it before starting workers.",
          }),
      ),
    )
  const held = () => get().pipe(Effect.map((value) => value?.state === "held"))
  const check = () =>
    Effect.gen(function* () {
      if (yield* held())
        return yield* new RayaTask.GuardError({
          kind: "paused",
          field: "restore-hold",
          message: "This transferred profile is paused. Review it on this computer before starting workers.",
        })
      return undefined
    })
  // Arm only after draining/retiring the source runner or before destination
  // startup. This fence prevents new admission; it does not cancel work already
  // executing inside a model or operating-system call.
  const begin = () =>
    mutate(
      storage,
      Effect.gen(function* () {
        const prior = yield* get()
        if (prior?.state === "held") return prior
        const value = { version: 1 as const, id: crypto.randomUUID(), state: "held" as const, createdAt: Date.now() }
        yield* storage.replace(key, value).pipe(Effect.orDie)
        return value
      }),
      "Portable transfer hold",
    )
  // Caller must be the explicit destination-review flow, never a worker or a
  // startup recovery hook. Exact generation matching rejects obsolete review.
  const release = (
    id: string,
    review: { reviewed: boolean; revision?: string },
    check?: () => Effect.Effect<void, RayaTask.GuardError>,
  ) =>
    mutate(
      storage,
      Effect.gen(function* () {
        const prior = yield* get()
        if (!prior || prior.id !== id || review.reviewed !== true)
          return yield* new RayaTask.GuardError({
            kind: "conflict",
            field: "restore-hold",
            message: "Review this exact transferred profile before activating it on this computer.",
          })
        if (prior.state === "released") {
          if (review.revision !== undefined && review.revision !== prior.review?.revision)
            return yield* new RayaTask.GuardError({
              kind: "conflict",
              field: "restore-hold",
              message: "This profile was reviewed with different evidence. Reload its current review.",
            })
          return prior
        }
        if (check) yield* check()
        const value = {
          ...prior,
          state: "released" as const,
          review: { at: Date.now(), by: "user" as const, ...(review.revision ? { revision: review.revision } : {}) },
        }
        yield* storage.replace(key, value).pipe(Effect.orDie)
        return value
      }),
      "Portable transfer review",
    )
  return { get, held, check, begin, release }
}
