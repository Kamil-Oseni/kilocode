import { and, asc, eq, gt, inArray, isNull, lt, lte } from "drizzle-orm"
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
  defer: Schema.optional(Schema.Boolean),
  skip: Schema.optional(name),
  occurrences: Schema.Array(Schema.Struct({ at: timestamp, observedAt: timestamp, tz: Schema.optional(name) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
})
type Publish = typeof publish.Type
const selection = Schema.Struct({ id: name, agentID: name, version, expected: Schema.optional(timestamp) })
const lease = Schema.Struct({ id: name, claimID: name, owner: name, until: timestamp, now: timestamp })
type Lease = typeof lease.Type
const transition = Schema.Struct({ id: name, claimID: name, sessionID: name, now: timestamp })
type Transition = typeof transition.Type
const resolution = Schema.Struct({
  id: name,
  claimID: name,
  sessionID: Schema.optional(name),
  now: timestamp,
  reason: name,
  requireExpired: Schema.Boolean,
})
type Resolution = typeof resolution.Type
const rearmInput = Schema.Struct({
  id: name,
  agentID: name,
  version,
  scheduledAt: timestamp,
  observedAt: timestamp,
  timezone: Schema.NullOr(name),
  claimID: name,
  sessionID: name,
  owner: name,
  leaseUntil: Schema.NullOr(timestamp),
  updated: timestamp,
  nextOwner: name,
  now: timestamp,
  until: timestamp,
})
export type Rearm = typeof rearmInput.Type

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
            if (input.defer && !input.skip) {
              if (ordered.length !== 1)
                return yield* new Conflict({ message: "Only one deferred occurrence may wait for a routine." })
              const waiting = yield* tx
                .select()
                .from(Occurrence)
                .where(
                  and(
                    eq(Occurrence.agent_id, input.agentID),
                    eq(Occurrence.schedule_version, input.version),
                    eq(Occurrence.state, "queued"),
                  ),
                )
                .orderBy(asc(Occurrence.scheduled_at))
                .limit(1)
                .get()
              if (waiting) return waiting.scheduled_at
            }
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
                  state: input.skip ? "skipped" : "queued",
                  reason: input.skip ?? (input.defer ? "Waiting for previous work to finish." : undefined),
                  time_updated: now,
                })
                .onConflictDoNothing()
                .run()
            }
            const through = ordered[ordered.length - 1].at
            if (input.defer) return through
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
    const promote = Effect.fn("RayaTaskQueue.promote")(function* (input: typeof selection.Type) {
      yield* Schema.decodeUnknownEffect(selection)(input)
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(Occurrence).where(eq(Occurrence.id, input.id)).get()
            const current = yield* tx
              .select()
              .from(Cursor)
              .where(and(eq(Cursor.agent_id, input.agentID), eq(Cursor.schedule_version, input.version)))
              .get()
            if (
              !row ||
              row.state !== "queued" ||
              row.agent_id !== input.agentID ||
              row.schedule_version !== input.version ||
              current?.through !== input.expected ||
              (current && current.through > row.scheduled_at)
            )
              return yield* new Conflict({ message: "The deferred occurrence or scheduling cursor changed." })
            if (current?.through === row.scheduled_at) return row
            const now = Date.now()
            yield* tx
              .insert(Cursor)
              .values({
                agent_id: input.agentID,
                schedule_version: input.version,
                through: row.scheduled_at,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: [Cursor.agent_id, Cursor.schedule_version],
                set: { through: row.scheduled_at, time_updated: now },
              })
              .run()
            return row
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
    const rearm = Effect.fn("RayaTaskQueue.rearm")(function* (input: Rearm) {
      yield* Schema.decodeUnknownEffect(rearmInput)(input)
      if (input.until <= input.now)
        return yield* new Conflict({ message: "A rearmed lease must expire in the future." })
      const rows = yield* db
        .update(Occurrence)
        .set({ owner: input.nextOwner, lease_until: input.until, time_updated: input.now })
        .where(
          and(
            eq(Occurrence.id, input.id),
            eq(Occurrence.agent_id, input.agentID),
            eq(Occurrence.schedule_version, input.version),
            eq(Occurrence.scheduled_at, input.scheduledAt),
            eq(Occurrence.observed_at, input.observedAt),
            input.timezone === null ? isNull(Occurrence.timezone) : eq(Occurrence.timezone, input.timezone),
            eq(Occurrence.claim_id, input.claimID),
            eq(Occurrence.session_id, input.sessionID),
            eq(Occurrence.owner, input.owner),
            input.leaseUntil === null ? isNull(Occurrence.lease_until) : eq(Occurrence.lease_until, input.leaseUntil),
            eq(Occurrence.time_updated, input.updated),
            eq(Occurrence.state, "linked"),
          ),
        )
        .returning()
        .all()
      return rows[0]
    })
    const resolve = Effect.fn("RayaTaskQueue.resolve")(function* (input: Resolution) {
      yield* Schema.decodeUnknownEffect(resolution)(input)
      const rows = yield* db
        .update(Occurrence)
        .set({ state: "skipped", reason: input.reason, lease_until: null, time_updated: input.now })
        .where(
          and(
            eq(Occurrence.id, input.id),
            eq(Occurrence.claim_id, input.claimID),
            inArray(Occurrence.state, ["starting", "linked"]),
            input.requireExpired ? lte(Occurrence.lease_until, input.now) : undefined,
            input.sessionID ? eq(Occurrence.session_id, input.sessionID) : undefined,
          ),
        )
        .returning()
        .all()
      return rows.length === 1
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
    const used = Effect.fn("RayaTaskQueue.used")(function* (agentID: string) {
      const occurrence = yield* db
        .select({ id: Occurrence.id })
        .from(Occurrence)
        .where(eq(Occurrence.agent_id, agentID))
        .limit(1)
        .get()
      if (occurrence) return true
      return Boolean(
        yield* db.select({ id: Cursor.agent_id }).from(Cursor).where(eq(Cursor.agent_id, agentID)).limit(1).get(),
      )
    })
    const skip = (id: string, reason: string) =>
      db
        .update(Occurrence)
        .set({ state: "skipped", reason, time_updated: Date.now() })
        .where(and(eq(Occurrence.id, id), eq(Occurrence.state, "queued")))
        .returning()
        .all()
        .pipe(Effect.map((rows) => rows.length === 1))
    const obsolete = (agentID: string, version: number) =>
      db
        .select({ id: Occurrence.id })
        .from(Occurrence)
        .where(
          and(
            eq(Occurrence.agent_id, agentID),
            lt(Occurrence.schedule_version, version),
            eq(Occurrence.state, "queued"),
          ),
        )
        .limit(1)
        .get()
    const prune = Effect.fn("RayaTaskQueue.prune")(function* (
      agentID: string,
      reason: string,
      limit: number,
      threshold?: number,
    ) {
      yield* Schema.decodeUnknownEffect(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })))(limit)
      if (threshold !== undefined) yield* Schema.decodeUnknownEffect(version)(threshold)
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const queued = and(
              eq(Occurrence.agent_id, agentID),
              eq(Occurrence.state, "queued"),
              threshold === undefined ? undefined : lt(Occurrence.schedule_version, threshold),
            )
            const rows = yield* tx
              .select({ id: Occurrence.id })
              .from(Occurrence)
              .where(queued)
              .orderBy(asc(Occurrence.schedule_version), asc(Occurrence.scheduled_at), asc(Occurrence.id))
              .limit(limit)
              .all()
            const changed = rows.length
              ? yield* tx
                  .update(Occurrence)
                  .set({ state: "skipped", reason, time_updated: Date.now() })
                  .where(
                    and(
                      queued,
                      inArray(
                        Occurrence.id,
                        rows.map((row) => row.id),
                      ),
                    ),
                  )
                  .returning({ id: Occurrence.id })
                  .all()
              : []
            const remaining = yield* tx.select({ id: Occurrence.id }).from(Occurrence).where(queued).limit(1).get()
            return { removed: changed.length, complete: remaining === undefined }
          }),
        { behavior: "immediate" },
      )
    })
    const retire = (agentID: string, version: number, limit = 1024) =>
      prune(agentID, "Replaced by a newer schedule version.", limit, version)
    const discard = (agentID: string, reason = "Routine removed from the roster.", limit = 1024) =>
      prune(agentID, reason, limit)
    return {
      cursor,
      publish,
      promote,
      pending,
      claim,
      heartbeat,
      link,
      settle,
      rearm,
      resolve,
      stale,
      get,
      active,
      used,
      skip,
      retire,
      obsolete,
      discard,
    }
  }
}

const validate = Schema.decodeUnknownEffect(publish)
