import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RayaContactOutbox } from "@/kilocode/contact/outbox"

const start = Date.parse("2026-09-16T23:30:00.000Z")

test("contact outbox enforces scoped authorization, quiet hours, replay, retry, and terminal delivery", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const created = yield* outbox.authorizeChange({
        source: "contact:books",
        channel: "email",
        address: " OWNER@Example.com ",
        label: "Owner email",
        scope: { kind: "agent", id: "books" },
        quiet: { start: 22 * 60, end: 7 * 60, timezone: "UTC" },
      })
      expect(created.changed).toBe(true)
      const target = created.target
      expect(target).toMatchObject({
        channel: "email",
        address: "owner@example.com",
        scope: { kind: "agent", id: "books" },
        revision: 1,
        enabled: true,
      })
      expect(
        (yield* outbox.authorizeChange({
          source: "contact:books",
          channel: "email",
          address: "owner@example.com",
          label: "Owner email",
          scope: { kind: "agent", id: "books" },
          quiet: { start: 22 * 60, end: 7 * 60, timezone: "UTC" },
        })).changed,
      ).toBe(false)
      expect(
        Exit.isFailure(
          yield* outbox
            .authorize({
              source: "contact:books",
              channel: "email",
              address: "other@example.com",
              scope: { kind: "agent", id: "books" },
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* outbox
            .authorize({
              source: "contact:duplicate",
              channel: "email",
              address: "owner@example.com",
              scope: { kind: "agent", id: "books" },
              quiet: { start: 22 * 60, end: 7 * 60, timezone: "UTC" },
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* outbox
            .enqueue({
              source: "message:wrong-worker",
              destinationID: target.id,
              agentID: "design",
              body: "Private accounting report",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)

      const queued = yield* outbox.enqueue({
        source: "message:weekly-report",
        destinationID: target.id,
        agentID: "books",
        sessionID: "session_books",
        body: "  Weekly accounting report is ready.  ",
      })
      expect(queued).toMatchObject({ state: "queued", body: "Weekly accounting report is ready.", attempts: 0 })
      expect(queued.availableAt).toBe(Date.parse("2026-09-17T07:00:00.000Z"))
      expect(
        yield* outbox.enqueue({
          source: "message:weekly-report",
          destinationID: target.id,
          agentID: "books",
          sessionID: "session_books",
          body: "Weekly accounting report is ready.",
        }),
      ).toEqual(queued)
      expect(
        Exit.isFailure(
          yield* outbox
            .enqueue({
              source: "message:weekly-report",
              destinationID: target.id,
              agentID: "books",
              sessionID: "session_books",
              body: "Changed report",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)

      expect(
        yield* outbox.claim({ owner: "dispatcher", leaseID: "lease:early", now: start, until: start + 60_000 }),
      ).toBeUndefined()
      const at = queued.availableAt
      const first = yield* outbox.claim({ owner: "dispatcher", leaseID: "lease:first", now: at, until: at + 60_000 })
      expect(first?.message).toMatchObject({ id: queued.id, state: "leased", attempts: 1 })
      const retry = yield* outbox.fail({ id: queued.id, leaseID: "lease:first", now: at + 10_000 })
      expect(retry).toMatchObject({ state: "retry", attempts: 1, availableAt: at + 70_000 })
      expect(
        yield* outbox.claim({
          owner: "dispatcher",
          leaseID: "lease:too-soon",
          now: at + 69_999,
          until: at + 100_000,
        }),
      ).toBeUndefined()
      const second = yield* outbox.claim({
        owner: "dispatcher",
        leaseID: "lease:second",
        now: at + 70_000,
        until: at + 120_000,
      })
      expect(second?.message).toMatchObject({ state: "leased", attempts: 2 })
      expect(
        yield* outbox.deliver({
          id: queued.id,
          leaseID: "lease:second",
          now: at + 80_000,
          providerRef: "provider_receipt_1",
        }),
      ).toEqual({
        status: "delivered",
        code: "delivered",
        providerRef: "provider_receipt_1",
        attempts: 2,
        time: at + 80_000,
      })
      expect(yield* RayaContactOutbox.make(database).get(queued.id)).toMatchObject({
        state: "delivered",
        receipt: { status: "delivered", code: "delivered", attempts: 2 },
      })
      expect((yield* outbox.messages())[0]).toMatchObject({
        id: queued.id,
        receipt: { status: "delivered", providerRef: "provider_receipt_1" },
      })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("revocation terminally fences queued and in-flight contact work without replay", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const target = yield* outbox.authorize({
        source: "contact:owner",
        channel: "raya",
        address: "owner",
        scope: { kind: "global" },
      })
      const first = yield* outbox.enqueue({
        source: "message:first",
        destinationID: target.id,
        agentID: "books",
        body: "First update",
      })
      const second = yield* outbox.enqueue({
        source: "message:second",
        destinationID: target.id,
        agentID: "books",
        body: "Second update",
      })
      const claimed = yield* outbox.claim({
        owner: "dispatcher",
        leaseID: "lease:owned",
        now: start,
        until: start + 60_000,
      })
      const claimedID = claimed!.message.id
      const queuedID = claimedID === first.id ? second.id : first.id

      const revoked = yield* outbox.revoke(target.id, 1)
      expect(revoked).toMatchObject({ enabled: false, revision: 2, revokedAt: start })
      expect(yield* outbox.get(claimedID)).toMatchObject({
        state: "failed",
        receipt: { status: "failed", code: "delivery-unknown", attempts: 1 },
      })
      expect(yield* outbox.get(queuedID)).toMatchObject({
        state: "cancelled",
        receipt: { status: "cancelled", code: "authorization-revoked", attempts: 0 },
      })
      expect(
        Exit.isFailure(
          yield* outbox
            .deliver({ id: claimedID, leaseID: "lease:owned", now: start + 1, providerRef: "late" })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      expect(yield* outbox.revoke(target.id, 2)).toEqual(revoked)
      expect(
        Exit.isFailure(
          yield* outbox
            .enqueue({
              source: "message:after-revoke",
              destinationID: target.id,
              agentID: "books",
              body: "Do not send",
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const restored = yield* outbox.authorize({
        source: "contact:owner",
        channel: "raya",
        address: "owner",
        scope: { kind: "global" },
      })
      expect(restored).toMatchObject({ id: target.id, enabled: true, revision: 3 })
      expect(restored.revokedAt).toBeUndefined()
      expect(
        yield* outbox.enqueue({
          source: "message:after-restore",
          destinationID: restored.id,
          agentID: "books",
          body: "Reports are allowed again",
        }),
      ).toMatchObject({ destinationRevision: 3, state: "queued" })
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("expired leases become unknown terminal receipts and one message has one concurrent owner", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const target = yield* outbox.authorize({
        source: "contact:telegram",
        channel: "telegram",
        address: "@RayaOwner",
        scope: { kind: "organization", id: "org_web" },
      })
      const item = yield* outbox.enqueue({
        source: "message:telegram",
        destinationID: target.id,
        organizationID: "org_web",
        body: "A customer needs your approval.",
      })
      const claims = yield* Effect.all(
        [
          outbox.claim({ owner: "one", leaseID: "lease:one", now: start, until: start + 60_000 }),
          outbox.claim({ owner: "two", leaseID: "lease:two", now: start, until: start + 60_000 }),
        ],
        { concurrency: "unbounded" },
      )
      expect(claims.filter(Boolean)).toHaveLength(1)
      expect(yield* outbox.recover(start + 60_001)).toBe(1)
      expect(yield* outbox.get(item.id)).toMatchObject({
        state: "failed",
        receipt: { status: "failed", code: "delivery-unknown", attempts: 1 },
      })
      expect(yield* RayaContactOutbox.make(database).recover(start + 120_000)).toBe(0)
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("delivery retries use bounded backoff and stop after five dispatched attempts", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const target = yield* outbox.authorize({
        source: "contact:retry",
        channel: "whatsapp",
        address: "+14165550123",
        scope: { kind: "global" },
      })
      const queued = yield* outbox.enqueue({
        source: "message:retry",
        destinationID: target.id,
        body: "Retry this bounded delivery.",
      })
      let at = queued.availableAt
      for (let attempt = 1; attempt <= 5; attempt++) {
        const leaseID = `lease:retry:${attempt}`
        const delivery = yield* outbox.claim({ owner: "dispatcher", leaseID, now: at, until: at + 30_000 })
        expect(delivery?.message.attempts).toBe(attempt)
        const result = yield* outbox.fail({ id: queued.id, leaseID, now: at + 1 })
        if (attempt < 5) {
          expect(result.state).toBe("retry")
          expect(result.availableAt).toBeGreaterThan(at)
          at = result.availableAt
          continue
        }
        expect(result).toMatchObject({
          state: "failed",
          receipt: { status: "failed", code: "retry-exhausted", attempts: 5 },
        })
      }
      expect(
        yield* outbox.claim({ owner: "dispatcher", leaseID: "lease:six", now: at + 10_000, until: at + 20_000 }),
      ).toBeUndefined()
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("contact destinations reject malformed addresses, quiet windows, and timezones", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const outbox = RayaContactOutbox.make(yield* Database.Service, () => start)
      for (const input of [
        { source: "bad:email", channel: "email", address: "missing-at", scope: { kind: "global" } },
        { source: "bad:telegram", channel: "telegram", address: "owner", scope: { kind: "global" } },
        { source: "bad:whatsapp", channel: "whatsapp", address: "555", scope: { kind: "global" } },
        { source: "bad:raya", channel: "raya", address: "somebody", scope: { kind: "global" } },
        {
          source: "bad:quiet",
          channel: "raya",
          address: "owner",
          scope: { kind: "global" },
          quiet: { start: 60, end: 60, timezone: "UTC" },
        },
        {
          source: "bad:timezone",
          channel: "raya",
          address: "owner",
          scope: { kind: "global" },
          quiet: { start: 60, end: 120, timezone: "Moon/Base" },
        },
      ] as const) {
        expect(Exit.isFailure(yield* outbox.authorize(input).pipe(Effect.exit))).toBe(true)
      }
      expect(yield* outbox.destinations()).toEqual([])
      expect(yield* outbox.messages()).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
