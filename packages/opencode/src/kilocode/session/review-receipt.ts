import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Storage } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { ReviewConflict } from "./review-revision"

const Receipt = Schema.Struct({ digest: Schema.String, complete: Schema.Boolean })
type Input = {
  sessionID: SessionID
  requestID?: string
  files?: readonly string[]
  expected?: Readonly<Record<string, string>>
}

/** Run inside the checkpoint semaphore; pending receipts never authorize replaying a mutation. */
export const receipt = Effect.fn("ReviewReceipt.run")(function* (
  storage: Storage.Interface,
  input: Input,
  action: "keep" | "undo",
  operation: Effect.Effect<Session.Info, Session.BusyError | ReviewConflict>,
  replay: Effect.Effect<Session.Info>,
) {
  if (input.requestID === undefined) return yield* operation
  if (!input.requestID || input.requestID.length > 128 || !input.expected)
    return yield* new ReviewConflict({ message: "A review retry requires a request ID and expected file revisions." })
  // Validate session lifetime before creating metadata; deletion shares the caller's gate.
  const session = yield* replay
  const key = ["review_receipt", input.sessionID, createHash("sha256").update(input.requestID).digest("hex")]
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        action,
        input.files ? [...input.files].sort() : null,
        Object.entries(input.expected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ]),
    )
    .digest("hex")
  const previous = yield* storage.read<unknown>(key).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
    Effect.flatMap((value) =>
      value === undefined ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(Receipt)(value),
    ),
    Effect.orDie,
  )
  if (previous) {
    if (previous.digest !== digest)
      return yield* new ReviewConflict({
        message: "This review request ID was already used for a different action or revision.",
      })
    if (!previous.complete)
      return yield* new ReviewConflict({
        message:
          "The previous review outcome is uncertain. Inspect the current files before starting another review action.",
      })
    return session
  }
  const claimed = yield* storage.create(key, { digest, complete: false }).pipe(Effect.orDie)
  if (!claimed)
    return yield* new ReviewConflict({
      message: "Another backend claimed this review request. Retry with the same request ID to check its outcome.",
    })
  const result = yield* operation.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        // Busy and revision conflicts are pre-mutation failures; a corrected retry is safe.
        // Unexpected defects retain the pending receipt, including failed persistence after a restore.
        yield* storage.remove(key).pipe(Effect.orDie)
        return yield* Effect.fail(error)
      }),
    ),
  )
  yield* storage.replace(key, { digest, complete: true }).pipe(Effect.orDie)
  return result
})
