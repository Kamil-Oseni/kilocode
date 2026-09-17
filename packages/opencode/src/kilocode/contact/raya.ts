import { Effect, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import { RayaRoutineMessageTable as InboxMessage } from "@opencode-ai/core/kilocode/routine.sql"
import { SessionID } from "@/session/schema"
import { RayaAdminLog } from "@/kilocode/admin/log"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { Message, RayaContactOutbox } from "./outbox"

const Limit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100))

export namespace RayaContactMessenger {
  export function make(
    database: Database.Interface,
    opts: {
      owner?: string
      clock?: () => number
      exists?: (agentID: string) => Effect.Effect<boolean>
      report?: (event: RayaAdminLog.Input) => Effect.Effect<unknown, unknown>
    } = {},
  ) {
    const outbox = RayaContactOutbox.make(database, opts.clock)
    const inbox = RayaTaskInbox.make(database)
    const owner = opts.owner ?? `raya:${crypto.randomUUID()}`
    const clock = opts.clock ?? Date.now

    const source = (item: Message) => `contact:${item.id}`

    const report = (code: RayaAdminLog.Code, fields?: RayaAdminLog.Fields) =>
      opts.report
        ? opts
            .report({ subsystem: "routines", severity: code === "delivery.failed" ? "warning" : "info", code, fields })
            .pipe(
              Effect.catchCause(() => Effect.void),
              Effect.asVoid,
            )
        : Effect.void

    const find = (agentID: string, value: string) =>
      database.db
        .select({
          id: InboxMessage.id,
          body: InboxMessage.body,
          kind: InboxMessage.kind,
          sessionID: InboxMessage.session_id,
        })
        .from(InboxMessage)
        .where(and(eq(InboxMessage.agent_id, agentID), eq(InboxMessage.source, value)))
        .get()
        .pipe(
          Effect.map((row) =>
            row ? { ...row, ...(row.sessionID ? { sessionID: row.sessionID } : { sessionID: undefined }) } : undefined,
          ),
          Effect.orDie,
        )

    const reject = (item: Message, now: number) =>
      outbox.reject({ id: item.id, leaseID: item.leaseID!, now }).pipe(
        Effect.tap(() => report("delivery.failed", { source: "routines", attempt: item.attempts })),
        Effect.as("failed" as const),
      )

    const deliver = (item: Message, now: number, providerRef: string) =>
      outbox.deliver({ id: item.id, leaseID: item.leaseID!, now, providerRef }).pipe(
        Effect.as("delivered" as const),
        Effect.catchTag("RayaContact.Conflict", (err) =>
          outbox
            .get(item.id)
            .pipe(
              Effect.flatMap((current) =>
                current.receipt?.status === "delivered" ? Effect.succeed("delivered" as const) : Effect.fail(err),
              ),
            ),
        ),
      )

    const publish = Effect.fn("RayaContactMessenger.publish")(function* (item: Message, now: number) {
      if (!item.leaseID) return yield* Effect.die(new Error("Claimed Raya contact message has no lease identity."))
      yield* report("delivery.started", { source: "routines", attempt: item.attempts })
      if (!item.agentID) return yield* reject(item, now)
      if (opts.exists && !(yield* opts.exists(item.agentID))) return yield* reject(item, now)
      const expected = item.sessionID && Schema.is(SessionID)(item.sessionID) ? item.sessionID : undefined
      const prior = yield* find(item.agentID, source(item))
      const saved =
        prior ??
        (yield* inbox
          .publish({
            agentID: item.agentID,
            source: source(item),
            kind: "report",
            body: item.body,
            ...(expected ? { sessionID: expected } : {}),
          })
          .pipe(
            Effect.catchTags({
              "RayaTaskInbox.Invalid": () => reject(item, now),
              "RayaTaskInbox.Conflict": () => reject(item, now),
            }),
          ))
      if (saved === "failed") return saved
      if (saved.body !== item.body || saved.kind !== "report" || saved.sessionID !== expected)
        return yield* reject(item, now)
      const result = yield* deliver(item, now, saved.id)
      yield* report("delivery.completed", { source: "routines", attempt: item.attempts })
      return result
    })

    const reconcile = Effect.fn("RayaContactMessenger.reconcile")(function* (now: number) {
      const rows = yield* outbox.expired("raya", now)
      if (rows.length) yield* report("delivery.recovered", { source: "routines", count: rows.length })
      for (const row of rows) yield* publish(row, now)
      return rows.length
    })

    const once = Effect.fn("RayaContactMessenger.once")(function* () {
      const now = clock()
      yield* reconcile(now)
      const delivery = yield* outbox.claim({
        owner,
        leaseID: crypto.randomUUID(),
        now,
        until: now + 60_000,
        channel: "raya",
      })
      if (!delivery) return "idle" as const
      return yield* publish(delivery.message, now)
    })

    const drain = Effect.fn("RayaContactMessenger.drain")(function* (limit = 50) {
      const count = yield* Schema.decodeUnknownEffect(Limit)(limit).pipe(
        Effect.mapError(() => new Error("Raya Messenger dispatch batches are limited to 100 messages.")),
      )
      const results: ("delivered" | "failed")[] = []
      for (let index = 0; index < count; index++) {
        const result = yield* once()
        if (result === "idle") break
        results.push(result)
      }
      return results
    })

    return { once, drain, reconcile }
  }
}
