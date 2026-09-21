import { Cause, Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { and, count, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineMessageTable as Message,
  RayaRoutineOccurrenceTable as Occurrence,
} from "@opencode-ai/core/kilocode/routine.sql"
import type { Storage } from "@/storage/storage"
import { RayaTask } from "."
import { starting } from "./claim"
import { stopped } from "./owner"
import { Record as Claim } from "./recovery"

export namespace RayaTaskHealth {
  export type Summary = {
    queued: number
    active: number
    recovering: number
    claims: number
    staged: number
    pending: number
    stranded: number
    failed: number
    incomplete: number
  }

  const limit = 256
  const claim = Schema.decodeUnknownEffect(Claim)
  const stage = Schema.decodeUnknownEffect(RayaTask.Stage)

  const read = <A>(
    storage: Pick<Storage.Interface, "read">,
    key: string[],
    decode: (value: unknown) => Effect.Effect<A, unknown>,
  ) =>
    storage.read<unknown>(key).pipe(
      Effect.flatMap(decode),
      Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(undefined))),
    )

  export const inspect = Effect.fn("RayaTaskHealth.inspect")(function* (
    database: Database.Interface,
    storage: Pick<Storage.Interface, "list" | "read">,
    now = Date.now(),
  ) {
    const db = database.db
    const total = (where: ReturnType<typeof eq> | undefined, table: typeof Occurrence | typeof Message) =>
      db
        .select({ n: count() })
        .from(table)
        .where(where)
        .get()
        .pipe(Effect.map((row) => row?.n ?? 0))
    const [queued, active, leases, pending, stranded] = yield* Effect.all([
      total(eq(Occurrence.state, "queued"), Occurrence),
      total(and(inArray(Occurrence.state, ["starting", "linked"]), gt(Occurrence.lease_until, now)), Occurrence),
      total(
        and(
          inArray(Occurrence.state, ["starting", "linked"]),
          or(isNull(Occurrence.lease_until), lte(Occurrence.lease_until, now)),
        ),
        Occurrence,
      ),
      total(and(eq(Message.kind, "user"), isNull(Message.session_id)), Message),
      total(
        and(
          eq(Message.kind, "user"),
          isNotNull(Message.session_id),
          isNull(Message.delivery_id),
          isNull(Message.delivered_at),
        ),
        Message,
      ),
    ])
    const claimKeys = yield* storage.list(["raya", "agent-claims"])
    const stageKeys = yield* storage.list(["raya", "agent-stage"])
    const claims = yield* Effect.forEach(
      claimKeys.slice(0, limit),
      (key) =>
        read(storage, key, claim).pipe(
          Effect.map((item) =>
            item &&
            key.length === 3 &&
            key[0] === "raya" &&
            key[1] === "agent-claims" &&
            key[2] === createHash("sha256").update(item.agentID).digest("hex")
              ? item
              : undefined,
          ),
        ),
      { concurrency: 8 },
    )
    const stages = yield* Effect.forEach(
      stageKeys.slice(0, limit),
      (key) =>
        read(storage, key, stage).pipe(
          Effect.map((item) =>
            item && key.length === 3 && key[0] === "raya" && key[1] === "agent-stage" && key[2] === item.agentID
              ? item
              : undefined,
          ),
        ),
      { concurrency: 8 },
    )
    const claimFailed = claims.filter((item) => item === undefined).length
    const stageFailed = stages.filter((item) => item === undefined).length
    const claimRecovery = claims.filter((item) => item && !starting(item.id) && stopped(item.owner)).length
    const stageRecovery = stages.filter((item) => item && stopped(item.owner)).length
    return {
      queued,
      active,
      recovering: leases + stranded + claimRecovery + stageRecovery,
      claims: claimKeys.length,
      staged: stageKeys.length,
      pending,
      stranded,
      failed: claimFailed + stageFailed,
      incomplete: Math.max(0, claimKeys.length - limit) + Math.max(0, stageKeys.length - limit),
    } satisfies Summary
  })
}
