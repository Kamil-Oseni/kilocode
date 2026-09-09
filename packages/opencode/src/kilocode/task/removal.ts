import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"

const key = ["raya", "agent-removals"]
const records = Schema.Array(
  Schema.Struct({
    version: Schema.Literal(1),
    agentID: Schema.String.check(Schema.isMinLength(1)),
    at: Schema.Finite,
  }),
)

/** Call mutations only while holding the shared routine mutation gate. */
export function removals(storage: Pick<Storage.Interface, "read" | "replace">) {
  const pending = () =>
    storage.read(key).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed([])),
      Effect.flatMap(Schema.decodeUnknownEffect(records)),
      Effect.orDie,
    )
  const stage = (id: string) =>
    Effect.gen(function* () {
      const current = yield* pending()
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
  return { pending, stage, finish }
}
