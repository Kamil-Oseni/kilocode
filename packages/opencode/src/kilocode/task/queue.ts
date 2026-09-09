import { and, asc, eq, gt, inArray, lt, lte } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaRoutineCursorTable as Cursor,
  RayaRoutineOccurrenceTable as Occurrence,
} from "@opencode-ai/core/kilocode/routine.sql"

const timestamp = Schema.Int.check(Schema.isBetween({ minimum: -8.64e15, maximum: 8.64e15 }))
const version = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }))
const name = Schema.String.check(Schema.isMinLength(1))
const publish = Schema.Struct({
  agentID: name,
  version,
  expected: Schema.optional(timestamp),
  occurrences: Schema.Array(Schema.Struct({ at: timestamp, observedAt: timestamp, tz: Schema.optional(name) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
})
type Publish = typeof publish.Type
const lease = Schema.Struct({ id: name, claimID: name, owner: name, until: timestamp, now: timestamp })
type Lease = typeof lease.Type
const transition = Schema.Struct({ id: name, claimID: name, sessionID: name, now: timestamp })
type Transition = typeof transition.Type

export namespace RayaTaskQueue {
  export class Conflict extends Schema.TaggedErrorClass<Conflict>()("RayaTaskQueue.Conflict", {
    message: Schema.String,
  }) {}

  export function make(database: Database.Interface) {
    const db = database.db
    const cursor = (agentID: string, version: number) =>
      db
        .select()
        .from(Cursor)
        .where(and(eq(Cursor.agent_id, agentID), eq(Cursor.schedule_version, version)))
        .get()
    const publish = Effect.fn("RayaTaskQueue.publish")(function* (input: Publish) {
      yield* validate(input)
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(Cursor)
              .where(and(eq(Cursor.agent_id, input.agentID), eq(Cursor.schedule_version, input.version)))
              .get()
            if (current?.through !== input.expected)
              return yield* new Conflict({
                message: "The scheduling cursor changed. Reload it before publishing occurrences.",
              })
            const ordered = [...input.occurrences].sort((a, b) => a.at - b.at)
            if (input.expected !== undefined && ordered[0].at <= input.expected)
              return yield* new Conflict({ message: "New occurrences must follow the stored scheduling cursor." })
            const now = Date.now()
            for (const item of ordered) {
              if (item.at > item.observedAt)
                return yield* new Conflict({ message: "An occurrence cannot be observed before its scheduled time." })
              yield* tx
                .insert(Occurrence)
                .values({
                  id: `timer:${JSON.stringify([input.agentID, input.version, item.at])}`,
                  agent_id: input.agentID,
                  schedule_version: input.version,
                  scheduled_at: item.at,
                  observed_at: item.observedAt,
                  timezone: item.tz,
                  state: "queued",
                  time_updated: now,
                })
                .onConflictDoNothing()
                .run()
            }
            const through = ordered[ordered.length - 1].at
            yield* tx
              .insert(Cursor)
              .values({ agent_id: input.agentID, schedule_version: input.version, through, time_updated: now })
              .onConflictDoUpdate({
                target: [Cursor.agent_id, Cursor.schedule_version],
                set: { through, time_updated: now },
              })
              .run()
            return through
          }),
        { behavior: "immediate" },
      )
    })
    const pending = (agentID: string, version: number) =>
      db
        .select()
        .from(Occurrence)
        .where(
          and(
            eq(Occurrence.agent_id, agentID),
            eq(Occurrence.schedule_version, version),
            eq(Occurrence.state, "queued"),
          ),
        )
        .orderBy(asc(Occurrence.scheduled_at))
        .limit(256)
        .all()
    const claim = Effect.fn("RayaTaskQueue.claim")(function* (input: Lease) {
      yield* Schema.decodeUnknownEffect(lease)(input)
      if (input.until <= input.now) return yield* new Conflict({ message: "A claim lease must expire in the future." })
      const rows = yield* db
        .update(Occurrence)
        .set({
          state: "starting",
          claim_id: input.claimID,
          owner: input.owner,
          lease_until: input.until,
          time_updated: input.now,
        })
        .where(and(eq(Occurrence.id, input.id), eq(Occurrence.state, "queued")))
        .returning()
        .all()
      return rows[0]
    })
    const heartbeat = Effect.fn("RayaTaskQueue.heartbeat")(function* (input: Lease) {
      yield* Schema.decodeUnknownEffect(lease)(input)
      if (input.until <= input.now) return yield* new Conflict({ message: "A claim lease must expire in the future." })
      const rows = yield* db
        .update(Occurrence)
        .set({ lease_until: input.until, time_updated: input.now })
        .where(
          and(
            eq(Occurrence.id, input.id),
            eq(Occurrence.claim_id, input.claimID),
            eq(Occurrence.owner, input.owner),
            inArray(Occurrence.state, ["starting", "linked"]),
            gt(Occurrence.lease_until, input.now),
            lte(Occurrence.lease_until, input.until),
          ),
        )
        .returning()
        .all()
      return rows.length === 1
    })
    const link = Effect.fn("RayaTaskQueue.link")(function* (input: Transition) {
      yield* Schema.decodeUnknownEffect(transition)(input)
      return yield* db
        .update(Occurrence)
        .set({ state: "linked", session_id: input.sessionID, time_updated: input.now })
        .where(
          and(eq(Occurrence.id, input.id), eq(Occurrence.claim_id, input.claimID), eq(Occurrence.state, "starting")),
        )
        .returning()
        .all()
        .pipe(Effect.map((rows) => rows.length === 1))
    })
    const settle = Effect.fn("RayaTaskQueue.settle")(function* (input: Transition) {
      yield* Schema.decodeUnknownEffect(transition)(input)
      return yield* db
        .update(Occurrence)
        .set({ state: "complete", lease_until: null, time_updated: input.now })
        .where(
          and(
            eq(Occurrence.id, input.id),
            eq(Occurrence.claim_id, input.claimID),
            eq(Occurrence.session_id, input.sessionID),
            eq(Occurrence.state, "linked"),
          ),
        )
        .returning()
        .all()
        .pipe(Effect.map((rows) => rows.length === 1))
    })
    const stale = (now: number) =>
      db
        .select()
        .from(Occurrence)
        .where(and(inArray(Occurrence.state, ["starting", "linked"]), lte(Occurrence.lease_until, now)))
        .orderBy(asc(Occurrence.lease_until))
        .limit(256)
        .all()
    const get = (id: string) => db.select().from(Occurrence).where(eq(Occurrence.id, id)).get()
    const active = (agentID: string) =>
      db
        .select()
        .from(Occurrence)
        .where(and(eq(Occurrence.agent_id, agentID), inArray(Occurrence.state, ["starting", "linked"])))
        .orderBy(asc(Occurrence.scheduled_at))
        .limit(256)
        .all()
    const skip = (id: string, reason: string) =>
      db
        .update(Occurrence)
        .set({ state: "skipped", reason, time_updated: Date.now() })
        .where(and(eq(Occurrence.id, id), eq(Occurrence.state, "queued")))
        .returning()
        .all()
        .pipe(Effect.map((rows) => rows.length === 1))
    const retire = (agentID: string, version: number) =>
      db
        .update(Occurrence)
        .set({ state: "skipped", reason: "Replaced by a newer schedule version.", time_updated: Date.now() })
        .where(
          and(
            eq(Occurrence.agent_id, agentID),
            lt(Occurrence.schedule_version, version),
            eq(Occurrence.state, "queued"),
          ),
        )
        .run()
    const discard = (agentID: string) =>
      db
        .update(Occurrence)
        .set({ state: "skipped", reason: "Routine removed from the roster.", time_updated: Date.now() })
        .where(and(eq(Occurrence.agent_id, agentID), eq(Occurrence.state, "queued")))
        .run()
    return { cursor, publish, pending, claim, heartbeat, link, settle, stale, get, active, skip, retire, discard }
  }
}

const validate = Schema.decodeUnknownEffect(publish)
