import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RayaContactOutbox } from "@/kilocode/contact/outbox"
import { RayaContactMessenger } from "@/kilocode/contact/raya"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import type { RayaAdminLog } from "@/kilocode/admin/log"

const start = Date.parse("2026-09-17T05:00:00.000Z")

test("Raya Messenger dispatches only local messages and never exposes a delivery lease to the inbox", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const local = yield* outbox.authorize({
        source: "contact:raya-owner",
        channel: "raya",
        address: "owner",
        scope: { kind: "global" },
      })
      const email = yield* outbox.authorize({
        source: "contact:email-owner",
        channel: "email",
        address: "owner@example.com",
        scope: { kind: "global" },
      })
      expect(
        Exit.isFailure(
          yield* outbox
            .enqueue({ source: "message:raya-missing-worker", destinationID: local.id, body: "No conversation" })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      const queued = yield* outbox.enqueue({
        source: "message:raya-weekly",
        destinationID: local.id,
        agentID: "books",
        sessionID: "ses_12345678901234567890123456",
        body: "Weekly accounting report is ready.",
      })
      const external = yield* outbox.enqueue({
        source: "message:email-weekly",
        destinationID: email.id,
        body: "Email report stays queued.",
      })

      const events: RayaAdminLog.Input[] = []
      const messenger = RayaContactMessenger.make(database, {
        owner: "messenger",
        clock: () => start,
        report: (event) => Effect.sync(() => events.push(event)),
      })
      expect(yield* messenger.once()).toBe("delivered")
      expect(yield* messenger.once()).toBe("idle")
      expect(yield* outbox.get(queued.id)).toMatchObject({
        state: "delivered",
        receipt: { status: "delivered", code: "delivered", attempts: 1 },
      })
      expect(yield* outbox.get(external.id)).toMatchObject({ state: "queued", attempts: 0 })

      const page = yield* RayaTaskInbox.make(database).page("books")
      expect(page.messages).toHaveLength(1)
      expect(page.messages[0]).toMatchObject({
        agentID: "books",
        kind: "report",
        source: `contact:${queued.id}`,
        body: "Weekly accounting report is ready.",
        sessionID: "ses_12345678901234567890123456",
      })
      expect(JSON.stringify(page)).not.toContain("messenger")
      expect(JSON.stringify(page)).not.toContain("lease")
      expect(events).toEqual([
        {
          subsystem: "routines",
          severity: "info",
          code: "delivery.started",
          fields: { source: "routines", attempt: 1 },
        },
        {
          subsystem: "routines",
          severity: "info",
          code: "delivery.completed",
          fields: { source: "routines", attempt: 1 },
        },
      ])
      expect(JSON.stringify(events)).not.toContain("Weekly accounting")
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("Raya Messenger send claims only the requested idempotent message", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const target = yield* outbox.authorize({
        source: "contact:raya-owner",
        channel: "raya",
        address: "owner",
        scope: { kind: "global" },
      })
      const first = yield* outbox.enqueue({
        source: "message:raya-first",
        destinationID: target.id,
        agentID: "books",
        body: "Earlier queued report.",
      })
      const messenger = RayaContactMessenger.make(database, {
        owner: "messenger",
        clock: () => start,
        exists: () => Effect.succeed(true),
      })
      const sent = yield* messenger.send({
        source: "message:raya-requested",
        destinationID: target.id,
        agentID: "growth",
        body: "Requested report.",
      })

      expect(sent).toMatchObject({ state: "delivered", receipt: { code: "delivered", attempts: 1 } })
      expect(yield* outbox.get(first.id)).toMatchObject({ state: "queued", attempts: 0 })
      expect((yield* RayaTaskInbox.make(database).page("growth")).messages).toHaveLength(1)
      expect((yield* RayaTaskInbox.make(database).page("books")).messages).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("Raya Messenger refuses an organization destination before enqueue when membership is not authorized", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const target = yield* outbox.authorize({
        source: "contact:raya-organization",
        channel: "raya",
        address: "owner",
        scope: { kind: "organization", id: "org_accounts" },
      })
      const messenger = RayaContactMessenger.make(database, {
        clock: () => start,
        permit: () => Effect.succeed(false),
      })
      const denied = yield* messenger
        .send({
          source: "message:raya-nonmember",
          destinationID: target.id,
          agentID: "outsider",
          organizationID: "org_accounts",
          body: "Unauthorized report.",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(denied)).toBe(true)
      expect(yield* outbox.listMessages(100)).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("Raya Messenger safely reconciles a crash after inbox publication without duplicating the report", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const inbox = RayaTaskInbox.make(database)
      const target = yield* outbox.authorize({
        source: "contact:raya-recovery",
        channel: "raya",
        address: "owner",
        scope: { kind: "agent", id: "growth" },
      })
      const queued = yield* outbox.enqueue({
        source: "message:raya-recovery",
        destinationID: target.id,
        agentID: "growth",
        body: "Campaign report is ready.",
      })
      const claimed = yield* outbox.claim({
        owner: "crashed",
        leaseID: "lease:crashed",
        now: start,
        until: start + 1,
        channel: "raya",
      })
      expect(claimed?.message.id).toBe(queued.id)
      const published = yield* inbox.publish({
        agentID: "growth",
        source: `contact:${queued.id}`,
        kind: "report",
        body: queued.body,
      })

      const events: RayaAdminLog.Input[] = []
      const messenger = RayaContactMessenger.make(database, {
        owner: "recovery",
        clock: () => start + 2,
        report: (event) => Effect.sync(() => events.push(event)),
      })
      expect(yield* messenger.reconcile(start + 2)).toBe(1)
      expect(yield* messenger.reconcile(start + 3)).toBe(0)
      expect(yield* outbox.get(queued.id)).toMatchObject({
        state: "delivered",
        receipt: { providerRef: published.id, attempts: 1 },
      })
      expect((yield* inbox.page("growth")).messages).toEqual([published])
      expect(events.map((event) => event.code)).toEqual([
        "delivery.recovered",
        "delivery.started",
        "delivery.completed",
      ])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})

test("Raya Messenger records a terminal failure when the worker no longer exists", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const outbox = RayaContactOutbox.make(database, () => start)
      const target = yield* outbox.authorize({
        source: "contact:raya-retired",
        channel: "raya",
        address: "owner",
        scope: { kind: "global" },
      })
      const queued = yield* outbox.enqueue({
        source: "message:raya-retired",
        destinationID: target.id,
        agentID: "retired",
        body: "This worker was removed.",
      })
      const messenger = RayaContactMessenger.make(database, {
        owner: "messenger",
        clock: () => start,
        exists: () => Effect.succeed(false),
      })

      expect(yield* messenger.drain()).toEqual(["failed"])
      expect(yield* outbox.get(queued.id)).toMatchObject({
        state: "failed",
        receipt: { status: "failed", code: "delivery-failed", attempts: 1 },
      })
      expect((yield* RayaTaskInbox.make(database).page("retired")).messages).toEqual([])
    }).pipe(Effect.provide(Database.layerFromPath(":memory:")), Effect.scoped),
  )
})
