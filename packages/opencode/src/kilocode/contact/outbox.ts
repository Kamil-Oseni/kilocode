import { and, asc, eq, inArray, lte } from "drizzle-orm"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import {
  RayaContactDestinationTable as DestinationRow,
  RayaContactMessageTable as MessageRow,
  RayaContactReceiptTable as ReceiptRow,
} from "@opencode-ai/core/kilocode/contact.sql"

const Token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.:-]{1,128}$/))
const ID = Schema.String.check(Schema.isPattern(/^ct[dm]_[a-f0-9]{48}$/))
const Stamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(8.64e15))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Minute = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1440))
const Channel = Schema.Literals(["raya", "email", "telegram", "whatsapp"])
const Scope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global") }),
  Schema.Struct({ kind: Schema.Literal("agent"), id: Token }),
  Schema.Struct({ kind: Schema.Literal("organization"), id: Token }),
])
const Quiet = Schema.Struct({
  start: Minute,
  end: Minute,
  timezone: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
}).check(
  Schema.makeFilter((value) =>
    value.start === value.end ? "Quiet hours need distinct start and end times." : undefined,
  ),
)

export const Destination = Schema.Struct({
  version: Schema.Literal(1),
  id: ID,
  source: Token,
  channel: Channel,
  address: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(320)),
  label: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))),
  scope: Scope,
  quiet: Schema.optional(Quiet),
  revision: Revision,
  enabled: Schema.Boolean,
  revokedAt: Schema.optional(Stamp),
  createdAt: Stamp,
  updatedAt: Stamp,
})
export const Authorize = Schema.Struct({
  source: Token,
  channel: Channel,
  address: Destination.fields.address,
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  scope: Scope,
  quiet: Schema.optional(Quiet),
})
export const Enqueue = Schema.Struct({
  source: Token,
  destinationID: ID,
  agentID: Schema.optional(Token),
  organizationID: Schema.optional(Token),
  sessionID: Schema.optional(Token),
  body: Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000)),
})
const State = Schema.Literals(["queued", "leased", "retry", "delivered", "failed", "cancelled"])
const Code = Schema.Literals([
  "delivered",
  "authorization-revoked",
  "delivery-failed",
  "delivery-unknown",
  "retry-exhausted",
])
export const Receipt = Schema.Struct({
  status: Schema.Literals(["delivered", "failed", "cancelled"]),
  code: Code,
  providerRef: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(5)),
  time: Stamp,
})
export const Message = Schema.Struct({
  version: Schema.Literal(1),
  id: ID,
  source: Token,
  destinationID: ID,
  destinationRevision: Revision,
  agentID: Schema.optional(Token),
  organizationID: Schema.optional(Token),
  sessionID: Schema.optional(Token),
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  state: State,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(5)),
  availableAt: Stamp,
  leaseID: Schema.optional(Token),
  leaseOwner: Schema.optional(Token),
  leaseUntil: Schema.optional(Stamp),
  createdAt: Stamp,
  updatedAt: Stamp,
  receipt: Schema.optional(Receipt),
})
export const Delivery = Schema.Struct({ message: Message, destination: Destination })

export type Destination = typeof Destination.Type
export type Authorize = typeof Authorize.Type
export type Enqueue = typeof Enqueue.Type
export type Message = typeof Message.Type

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RayaContact.Invalid", { message: Schema.String }) {}
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("RayaContact.NotFound", { message: Schema.String }) {}
export class Conflict extends Schema.TaggedErrorClass<Conflict>()("RayaContact.Conflict", { message: Schema.String }) {}

function key(prefix: "ctd" | "ctm", source: string) {
  return `${prefix}_${createHash("sha256").update(source).digest("hex").slice(0, 48)}`
}

function address(channel: typeof Channel.Type, input: string) {
  const value = input.trim()
  if (channel === "raya") return value === "owner" ? value : undefined
  if (channel === "email")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320 ? value.toLowerCase() : undefined
  if (channel === "telegram") return /^@[A-Za-z0-9_]{5,32}$/.test(value) ? value.toLowerCase() : undefined
  return /^\+[1-9][0-9]{7,14}$/.test(value) ? value : undefined
}

function zone(value: string) {
  return Effect.try({
    try: () => new Intl.DateTimeFormat("en-US", { timeZone: value, hour: "2-digit" }).resolvedOptions().timeZone,
    catch: () => new Invalid({ message: "Choose a valid IANA timezone for quiet hours." }),
  })
}

function local(at: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at)
  const hour = Number(parts.find((part) => part.type === "hour")?.value)
  const minute = Number(parts.find((part) => part.type === "minute")?.value)
  return hour * 60 + minute
}

function blocked(at: number, quiet: typeof Quiet.Type) {
  const minute = local(at, quiet.timezone)
  if (quiet.start < quiet.end) return minute >= quiet.start && minute < quiet.end
  return minute >= quiet.start || minute < quiet.end
}

function available(at: number, quiet?: typeof Quiet.Type) {
  if (!quiet || !blocked(at, quiet)) return at
  const base = Math.floor(at / 60_000) * 60_000
  for (let index = 1; index <= 1500; index++) {
    const next = base + index * 60_000
    if (!blocked(next, quiet)) return next
  }
  return at + 26 * 60 * 60_000
}

function scope(value: typeof Scope.Type) {
  return value.kind === "global" ? "" : value.id
}

function destination(row: typeof DestinationRow.$inferSelect): Destination {
  return {
    version: 1,
    id: row.id,
    source: row.source,
    channel: row.channel,
    address: row.address,
    ...(row.label ? { label: row.label } : {}),
    scope: row.scope === "global" ? { kind: "global" } : { kind: row.scope, id: row.scope_id },
    ...(row.quiet_start !== null && row.quiet_end !== null && row.timezone
      ? { quiet: { start: row.quiet_start, end: row.quiet_end, timezone: row.timezone } }
      : {}),
    revision: row.revision,
    enabled: row.enabled,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

function receipt(row: typeof ReceiptRow.$inferSelect | undefined) {
  if (!row) return undefined
  return {
    status: row.status,
    code: row.code,
    ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
    attempts: row.attempts,
    time: row.time_created,
  }
}

function message(row: typeof MessageRow.$inferSelect, result?: typeof ReceiptRow.$inferSelect): Message {
  return {
    version: 1,
    id: row.id,
    source: row.source,
    destinationID: row.destination_id,
    destinationRevision: row.destination_revision,
    ...(row.agent_id ? { agentID: row.agent_id } : {}),
    ...(row.organization_id ? { organizationID: row.organization_id } : {}),
    ...(row.session_id ? { sessionID: row.session_id } : {}),
    body: row.body,
    state: row.state,
    attempts: row.attempts,
    availableAt: row.available_at,
    ...(row.lease_id ? { leaseID: row.lease_id } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
    createdAt: row.time_created,
    updatedAt: row.time_updated,
    ...(result ? { receipt: receipt(result)! } : {}),
  }
}

function allowed(item: Destination, input: Enqueue) {
  if (item.scope.kind === "global") return true
  if (item.scope.kind === "agent") return item.scope.id === input.agentID
  return item.scope.id === input.organizationID
}

const retry = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000]

export namespace RayaContactOutbox {
  export function make(database: Database.Interface, clock = Date.now) {
    const db = database.db

    const getDestination = Effect.fn("RayaContactOutbox.destination")(function* (id: string) {
      const row = yield* db.select().from(DestinationRow).where(eq(DestinationRow.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFound({ message: "Contact destination not found." })
      return destination(row)
    })

    const get = Effect.fn("RayaContactOutbox.get")(function* (id: string) {
      const row = yield* db.select().from(MessageRow).where(eq(MessageRow.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new NotFound({ message: "Contact message not found." })
      const result = yield* db.select().from(ReceiptRow).where(eq(ReceiptRow.message_id, id)).get().pipe(Effect.orDie)
      return message(row, result)
    })

    const authorize = Effect.fn("RayaContactOutbox.authorize")(function* (input: Authorize) {
      const value = yield* Schema.decodeUnknownEffect(Authorize)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Provide a valid contact destination and authorization scope." })),
      )
      const normalized = address(value.channel, value.address)
      if (!normalized) return yield* new Invalid({ message: `Provide a valid ${value.channel} destination.` })
      const timezone = value.quiet ? yield* zone(value.quiet.timezone) : undefined
      const label = value.label?.trim() || undefined
      const id = key("ctd", value.source)
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const prior = yield* tx.select().from(DestinationRow).where(eq(DestinationRow.source, value.source)).get()
            if (prior) {
              const item = destination(prior)
              const quiet = value.quiet ? { ...value.quiet, timezone: timezone! } : undefined
              if (
                item.channel === value.channel &&
                item.address === normalized &&
                item.label === label &&
                JSON.stringify(item.scope) === JSON.stringify(value.scope) &&
                JSON.stringify(item.quiet) === JSON.stringify(quiet)
              )
                return item
              return yield* new Conflict({ message: "This destination source already authorizes different details." })
            }
            const duplicate = yield* tx
              .select()
              .from(DestinationRow)
              .where(
                and(
                  eq(DestinationRow.channel, value.channel),
                  eq(DestinationRow.address, normalized),
                  eq(DestinationRow.scope, value.scope.kind),
                  eq(DestinationRow.scope_id, scope(value.scope)),
                ),
              )
              .get()
            if (duplicate)
              return yield* new Conflict({ message: "That contact destination and authorization scope already exist." })
            const now = clock()
            yield* tx
              .insert(DestinationRow)
              .values({
                id,
                source: value.source,
                channel: value.channel,
                address: normalized,
                label: label ?? null,
                scope: value.scope.kind,
                scope_id: scope(value.scope),
                quiet_start: value.quiet?.start ?? null,
                quiet_end: value.quiet?.end ?? null,
                timezone: timezone ?? null,
                revision: 1,
                enabled: true,
                revoked_at: null,
                time_created: now,
                time_updated: now,
              })
              .run()
            return yield* tx
              .select()
              .from(DestinationRow)
              .where(eq(DestinationRow.id, id))
              .get()
              .pipe(
                Effect.flatMap((row) =>
                  row ? Effect.succeed(destination(row)) : Effect.die("Destination insert failed."),
                ),
              )
          }),
        { behavior: "immediate" },
      )
    })

    const enqueue = Effect.fn("RayaContactOutbox.enqueue")(function* (input: Enqueue) {
      const value = yield* Schema.decodeUnknownEffect(Enqueue)(input).pipe(
        Effect.mapError(() => new Invalid({ message: "Provide a valid idempotent contact message." })),
      )
      const id = key("ctm", value.source)
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const prior = yield* tx.select().from(MessageRow).where(eq(MessageRow.source, value.source)).get()
            if (prior) {
              if (
                prior.destination_id === value.destinationID &&
                prior.agent_id === (value.agentID ?? null) &&
                prior.organization_id === (value.organizationID ?? null) &&
                prior.session_id === (value.sessionID ?? null) &&
                prior.body === value.body.trim()
              )
                return message(prior)
              return yield* new Conflict({ message: "This contact source already contains a different message." })
            }
            const row = yield* tx.select().from(DestinationRow).where(eq(DestinationRow.id, value.destinationID)).get()
            if (!row) return yield* new NotFound({ message: "Contact destination not found." })
            const target = destination(row)
            if (!target.enabled) return yield* new Conflict({ message: "This contact destination was revoked." })
            if (!allowed(target, value))
              return yield* new Conflict({
                message: "This worker or organization is not authorized for that destination.",
              })
            const now = clock()
            yield* tx
              .insert(MessageRow)
              .values({
                id,
                source: value.source,
                destination_id: target.id,
                destination_revision: target.revision,
                agent_id: value.agentID ?? null,
                organization_id: value.organizationID ?? null,
                session_id: value.sessionID ?? null,
                body: value.body.trim(),
                state: "queued",
                attempts: 0,
                available_at: available(now, target.quiet),
                time_created: now,
                time_updated: now,
              })
              .run()
            return yield* tx
              .select()
              .from(MessageRow)
              .where(eq(MessageRow.id, id))
              .get()
              .pipe(
                Effect.flatMap((item) => (item ? Effect.succeed(message(item)) : Effect.die("Message insert failed."))),
              )
          }),
        { behavior: "immediate" },
      )
    })

    const terminal = (
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
      row: typeof MessageRow.$inferSelect,
      status: "delivered" | "failed" | "cancelled",
      code: typeof Code.Type,
      now: number,
      provider?: string,
    ) =>
      Effect.gen(function* () {
        yield* tx
          .update(MessageRow)
          .set({ state: status, lease_id: null, lease_owner: null, lease_until: null, time_updated: now })
          .where(eq(MessageRow.id, row.id))
          .run()
        yield* tx
          .insert(ReceiptRow)
          .values({
            message_id: row.id,
            status,
            code,
            provider_ref: provider ?? null,
            attempts: row.attempts,
            time_created: now,
          })
          .onConflictDoNothing()
          .run()
      })

    const recover = Effect.fn("RayaContactOutbox.recover")(function* (now: number) {
      yield* Schema.decodeUnknownEffect(Stamp)(now).pipe(
        Effect.mapError(() => new Invalid({ message: "Recovery time is invalid." })),
      )
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select()
              .from(MessageRow)
              .where(and(eq(MessageRow.state, "leased"), lte(MessageRow.lease_until, now)))
              .all()
            for (const row of rows) yield* terminal(tx, row, "failed", "delivery-unknown", now)
            return rows.length
          }),
        { behavior: "immediate" },
      )
    })

    const claim = Effect.fn("RayaContactOutbox.claim")(function* (input: {
      owner: string
      leaseID: string
      now: number
      until: number
    }) {
      if (!Schema.is(Token)(input.owner) || !Schema.is(Token)(input.leaseID) || !Schema.is(Stamp)(input.now))
        return yield* new Invalid({ message: "Contact delivery lease is invalid." })
      if (!Schema.is(Stamp)(input.until) || input.until <= input.now || input.until - input.now > 5 * 60_000)
        return yield* new Invalid({ message: "Contact delivery leases must last at most five minutes." })
      yield* recover(input.now)
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .select()
              .from(MessageRow)
              .where(and(inArray(MessageRow.state, ["queued", "retry"]), lte(MessageRow.available_at, input.now)))
              .orderBy(asc(MessageRow.available_at), asc(MessageRow.time_created), asc(MessageRow.id))
              .limit(1)
              .get()
            if (!row) return undefined
            const targetRow = yield* tx
              .select()
              .from(DestinationRow)
              .where(eq(DestinationRow.id, row.destination_id))
              .get()
            if (!targetRow || !targetRow.enabled || targetRow.revision !== row.destination_revision) {
              yield* terminal(tx, row, "cancelled", "authorization-revoked", input.now)
              return undefined
            }
            yield* tx
              .update(MessageRow)
              .set({
                state: "leased",
                attempts: row.attempts + 1,
                lease_id: input.leaseID,
                lease_owner: input.owner,
                lease_until: input.until,
                time_updated: input.now,
              })
              .where(and(eq(MessageRow.id, row.id), inArray(MessageRow.state, ["queued", "retry"])))
              .run()
            const claimed = yield* tx.select().from(MessageRow).where(eq(MessageRow.id, row.id)).get()
            if (!claimed || claimed.lease_id !== input.leaseID)
              return yield* new Conflict({ message: "Another dispatcher claimed this contact message." })
            return { message: message(claimed), destination: destination(targetRow) }
          }),
        { behavior: "immediate" },
      )
    })

    const deliver = Effect.fn("RayaContactOutbox.deliver")(function* (input: {
      id: string
      leaseID: string
      now: number
      providerRef?: string
    }) {
      if (
        !Schema.is(Stamp)(input.now) ||
        (input.providerRef !== undefined && !Schema.is(Receipt.fields.providerRef)(input.providerRef))
      )
        return yield* new Invalid({ message: "Contact delivery receipt is invalid." })
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(MessageRow).where(eq(MessageRow.id, input.id)).get()
            if (!row) return yield* new NotFound({ message: "Contact message not found." })
            if (row.state !== "leased" || row.lease_id !== input.leaseID)
              return yield* new Conflict({ message: "This dispatcher no longer owns the contact message." })
            yield* terminal(tx, row, "delivered", "delivered", input.now, input.providerRef)
            const saved = yield* tx.select().from(ReceiptRow).where(eq(ReceiptRow.message_id, row.id)).get()
            return receipt(saved)!
          }),
        { behavior: "immediate" },
      )
    })

    const fail = Effect.fn("RayaContactOutbox.fail")(function* (input: {
      id: string
      leaseID: string
      now: number
      unknown?: boolean
    }) {
      if (!Schema.is(Stamp)(input.now)) return yield* new Invalid({ message: "Contact failure time is invalid." })
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(MessageRow).where(eq(MessageRow.id, input.id)).get()
            if (!row) return yield* new NotFound({ message: "Contact message not found." })
            if (row.state !== "leased" || row.lease_id !== input.leaseID)
              return yield* new Conflict({ message: "This dispatcher no longer owns the contact message." })
            if (input.unknown) {
              yield* terminal(tx, row, "failed", "delivery-unknown", input.now)
              const result = yield* tx.select().from(ReceiptRow).where(eq(ReceiptRow.message_id, row.id)).get()
              return message(
                {
                  ...row,
                  state: "failed",
                  lease_id: null,
                  lease_owner: null,
                  lease_until: null,
                  time_updated: input.now,
                },
                result,
              )
            }
            if (row.attempts >= retry.length) {
              yield* terminal(tx, row, "failed", "retry-exhausted", input.now)
              const result = yield* tx.select().from(ReceiptRow).where(eq(ReceiptRow.message_id, row.id)).get()
              return message(
                {
                  ...row,
                  state: "failed",
                  lease_id: null,
                  lease_owner: null,
                  lease_until: null,
                  time_updated: input.now,
                },
                result,
              )
            }
            const target = yield* tx
              .select()
              .from(DestinationRow)
              .where(eq(DestinationRow.id, row.destination_id))
              .get()
            if (!target || !target.enabled || target.revision !== row.destination_revision) {
              yield* terminal(tx, row, "cancelled", "authorization-revoked", input.now)
              const result = yield* tx.select().from(ReceiptRow).where(eq(ReceiptRow.message_id, row.id)).get()
              return message(
                {
                  ...row,
                  state: "cancelled",
                  lease_id: null,
                  lease_owner: null,
                  lease_until: null,
                  time_updated: input.now,
                },
                result,
              )
            }
            const at = available(input.now + retry[row.attempts - 1], destination(target).quiet)
            yield* tx
              .update(MessageRow)
              .set({
                state: "retry",
                available_at: at,
                lease_id: null,
                lease_owner: null,
                lease_until: null,
                time_updated: input.now,
              })
              .where(eq(MessageRow.id, row.id))
              .run()
            return message({
              ...row,
              state: "retry",
              available_at: at,
              lease_id: null,
              lease_owner: null,
              lease_until: null,
              time_updated: input.now,
            })
          }),
        { behavior: "immediate" },
      )
    })

    const revoke = Effect.fn("RayaContactOutbox.revoke")(function* (id: string, expectedRevision: number) {
      if (!Schema.is(Revision)(expectedRevision))
        return yield* new Invalid({ message: "Destination revision is invalid." })
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const row = yield* tx.select().from(DestinationRow).where(eq(DestinationRow.id, id)).get()
            if (!row) return yield* new NotFound({ message: "Contact destination not found." })
            if (!row.enabled) return destination(row)
            if (row.revision !== expectedRevision)
              return yield* new Conflict({ message: "This destination changed. Reload it before revoking access." })
            const now = clock()
            const pending = yield* tx
              .select()
              .from(MessageRow)
              .where(and(eq(MessageRow.destination_id, id), inArray(MessageRow.state, ["queued", "retry", "leased"])))
              .all()
            for (const item of pending)
              yield* terminal(
                tx,
                item,
                item.state === "leased" ? "failed" : "cancelled",
                item.state === "leased" ? "delivery-unknown" : "authorization-revoked",
                now,
              )
            yield* tx
              .update(DestinationRow)
              .set({ enabled: false, revision: row.revision + 1, revoked_at: now, time_updated: now })
              .where(and(eq(DestinationRow.id, id), eq(DestinationRow.revision, expectedRevision)))
              .run()
            return yield* tx
              .select()
              .from(DestinationRow)
              .where(eq(DestinationRow.id, id))
              .get()
              .pipe(
                Effect.flatMap((saved) => (saved ? Effect.succeed(destination(saved)) : Effect.die("Revoke failed."))),
              )
          }),
        { behavior: "immediate" },
      )
    })

    const destinations = () =>
      db
        .select()
        .from(DestinationRow)
        .orderBy(asc(DestinationRow.time_created), asc(DestinationRow.id))
        .all()
        .pipe(
          Effect.map((rows) => rows.map(destination)),
          Effect.orDie,
        )

    const messages = () =>
      Effect.gen(function* () {
        const rows = yield* db.select().from(MessageRow).orderBy(asc(MessageRow.time_created), asc(MessageRow.id)).all()
        const results = yield* db.select().from(ReceiptRow).all()
        const receipts = new Map(results.map((item) => [item.message_id, item]))
        return rows.map((row) => message(row, receipts.get(row.id)))
      }).pipe(Effect.orDie)

    return { authorize, destinations, getDestination, revoke, enqueue, get, messages, recover, claim, deliver, fail }
  }
}
