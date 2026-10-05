import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { SessionID } from "@/session/schema"
import { Observation } from "./stop-jobs"
import { Operation } from "./stop-operation"
import { Trigger } from "@/kilocode/task/trigger"

export const TaskRetirement = Schema.Struct({
  version: Schema.Literal(1),
  sessionDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      agentID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      sessionID: SessionID,
      executionDigest: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
      at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
      scheduleVersion: Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
      ),
      trigger: Schema.optional(
        Trigger.check(
          Schema.makeFilter((value) =>
            JSON.stringify(value).length <= 4096 ? undefined : "Routine stop trigger is too large.",
          ),
        ),
      ),
    }),
  ).check(Schema.isMaxLength(1)),
})
export type TaskRetirement = typeof TaskRetirement.Type

export const Receipt = Schema.Struct({
  sessionID: SessionID,
  intent: Schema.String,
  phase: Schema.Literals(["requested", "cleared", "finished"]),
  at: Schema.Number,
  finishedAt: Schema.optional(Schema.Number),
  interrupted: Schema.optional(Schema.Boolean),
  background: Schema.optional(Observation),
  operations: Schema.optional(Schema.Array(Operation)),
  task: Schema.optional(TaskRetirement),
})
export type Receipt = typeof Receipt.Type

const key = (sessionID: SessionID, intent: string) => [
  "raya",
  "goal-stops",
  sessionID,
  createHash("sha256").update(intent).digest("hex"),
]

export function receipts(storage: Pick<Storage.Interface, "read" | "replace" | "list">) {
  const read = (path: string[]) =>
    storage.read<unknown>(path).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
      Effect.flatMap((receipt) =>
        JSON.stringify(key(receipt.sessionID, receipt.intent)) === JSON.stringify(path)
          ? Effect.succeed(receipt)
          : Effect.die(new Error("Goal stop receipt identity does not match its storage key")),
      ),
      Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed(undefined)),
      Effect.orDie,
    )
  return {
    read: (sessionID: SessionID, intent: string) => read(key(sessionID, intent)),
    latest: (sessionID: SessionID) =>
      Effect.gen(function* () {
        const paths = yield* storage.list(["raya", "goal-stops", sessionID]).pipe(Effect.orDie)
        const rows = yield* Effect.forEach(paths, read, { concurrency: 4 })
        return rows
          .filter((row) => row !== undefined)
          .toSorted((a, b) => b.at - a.at || b.intent.localeCompare(a.intent))[0]
      }),
    save: (receipt: Receipt) =>
      storage.replace(key(receipt.sessionID, receipt.intent), receipt).pipe(Effect.as(receipt), Effect.orDie),
  }
}
