import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import { mutate } from "./mutation"

const Record = Schema.Struct({ source: Schema.String, sessionID: SessionID })

/** Bind a chat assignment without changing the worker's standing report destination. */
export function make(storage: Storage.Interface) {
  const key = (source: string) => ["raya", "routine-report-origins", createHash("sha256").update(source).digest("hex")]
  const read = (source: string) =>
    storage.readBounded<unknown>(key(source), 2048).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Record)),
      Effect.tap((saved) =>
        saved.source === source ? Effect.void : Effect.die(new Error("Assignment report source changed.")),
      ),
      Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      Effect.orDie,
    )
  return {
    save: (source: string, sessionID: SessionID) =>
      mutate(
        storage,
        Effect.gen(function* () {
          const saved = yield* read(source)
          if (saved) return saved.sessionID === sessionID
          yield* storage.replace(key(source), { source, sessionID }).pipe(Effect.orDie)
          return true
        }),
        "Assignment report origin",
      ),
    resolve: (sources: readonly string[]) =>
      Effect.gen(function* () {
        for (const source of sources) {
          const saved = yield* read(source)
          if (saved) return saved.sessionID
        }
      }),
  }
}
