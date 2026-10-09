import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"

const key = ["raya", "agent-removals"]
const limit = 1024
const identity = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((id) => Buffer.byteLength(id, "utf8") <= 256),
)
class RemovalError extends Schema.TaggedErrorClass<RemovalError>()("RayaTask.RemovalError", {
  message: Schema.String,
}) {}
const records = Schema.Array(
  Schema.Struct({
    version: Schema.Literal(1),
    agentID: identity,
    at: Schema.Finite,
  }),
)

/** Call mutations only while holding the shared routine mutation gate. */
export function removals(storage: Pick<Storage.Interface, "read" | "replace">) {
  const pending = () =>
    storage.read(key).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed([])),
      Effect.orDie,
      Effect.flatMap((value) => {
        if (Array.isArray(value) && value.length > limit)
          return Effect.fail(
            new RemovalError({
              message:
                "Retained routine removal evidence exceeds 1024 records. Review it before changing routines; no records were discarded.",
            }),
          )
        return Schema.decodeUnknownEffect(records)(value).pipe(
          Effect.mapError(
            () =>
              new RemovalError({
                message:
                  "Retained routine removal evidence is invalid or has an ID exceeding 256 UTF-8 bytes. Review it before changing routines; no records were discarded.",
              }),
          ),
        )
      }),
    )
  const selected = (id: string) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(identity)(id).pipe(
        Effect.mapError(
          () =>
            new RemovalError({
              message: "Routine removal requires a nonempty ID of at most 256 UTF-8 bytes.",
            }),
        ),
      )
      const current = yield* pending()
      if (!current.some((item) => item.agentID === id) && current.length >= limit)
        return yield* new RemovalError({
          message:
            "Routine removal cleanup is full at 1024 records. Resolve pending cleanup before removing another routine.",
        })
      return current
    })
  const check = (id: string) => selected(id).pipe(Effect.asVoid)
  const stage = (id: string) =>
    Effect.gen(function* () {
      const current = yield* selected(id)
      if (current.some((item) => item.agentID === id)) return
      yield* storage.replace(key, [...current, { version: 1, agentID: id, at: Date.now() }]).pipe(Effect.orDie)
    })
  const finish = (ids: readonly string[]) =>
    Effect.gen(function* () {
      const current = yield* pending()
      yield* storage
        .replace(
          key,
          current.filter((item) => !ids.includes(item.agentID)),
        )
        .pipe(Effect.orDie)
    })
  return { pending, check, stage, finish }
}
