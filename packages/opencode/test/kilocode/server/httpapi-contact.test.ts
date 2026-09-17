import { afterEach, expect, setDefaultTimeout } from "bun:test"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { Destination, RayaContactOutbox } from "@/kilocode/contact/outbox"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { Server } from "@/server/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { testEffectShared } from "../../lib/effect"

setDefaultTimeout(15_000)

const it = testEffectShared(AppNodeBuilderV1.build(Database.node))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.live("serves authenticated owner contact destination management without dispatcher credentials", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir({ config: { formatter: false, lsp: false } })),
    (tmp) =>
      Effect.gen(function* () {
        const request = (path: string, init: RequestInit = {}) => {
          const headers = new Headers(init.headers)
          headers.set("x-kilo-directory", tmp.path)
          if (init.body) headers.set("content-type", "application/json")
          return Effect.promise(() => Promise.resolve(Server.Default().app.request(path, { ...init, headers })))
        }

        const authorized = yield* request("/raya/contact/destinations", {
          method: "POST",
          body: JSON.stringify({
            source: "settings.email.primary",
            channel: "email",
            address: " Owner@Example.com ",
            label: "Primary",
            scope: { kind: "organization", id: "org_accounts" },
            quiet: { start: 1320, end: 420, timezone: "America/Toronto" },
          }),
        })
        expect(authorized.status).toBe(200)
        const destination = yield* Effect.promise(() => authorized.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Destination)),
        )
        expect(destination).toMatchObject({
          channel: "email",
          address: "owner@example.com",
          scope: { kind: "organization", id: "org_accounts" },
          revision: 1,
          enabled: true,
        })

        const replayed = yield* request("/raya/contact/destinations", {
          method: "POST",
          body: JSON.stringify({
            source: "settings.email.primary",
            channel: "email",
            address: "owner@example.com",
            label: "Primary",
            scope: { kind: "organization", id: "org_accounts" },
            quiet: { start: 1320, end: 420, timezone: "America/Toronto" },
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* Effect.promise(() => replayed.json())).toEqual(destination)

        const policy = yield* request(`/raya/contact/destinations/${destination.id}/policy`, {
          method: "POST",
          body: JSON.stringify({ revision: destination.revision }),
        })
        expect(policy.status).toBe(200)
        const updated = yield* Effect.promise(() => policy.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Destination)),
        )
        expect(updated).toMatchObject({ id: destination.id, revision: 2, enabled: true })
        expect(updated).not.toHaveProperty("quiet")
        const policyReplay = yield* request(`/raya/contact/destinations/${destination.id}/policy`, {
          method: "POST",
          body: JSON.stringify({ revision: destination.revision }),
        })
        expect(policyReplay.status).toBe(200)
        expect(yield* Effect.promise(() => policyReplay.json())).toEqual(updated)

        const created = yield* request("/kilocode/agent", {
          method: "POST",
          body: JSON.stringify({
            name: "Books",
            role: "accountant",
            objective: "Review the weekly accounts",
            capabilities: ["accounting"],
            schedule: { kind: "manual" },
          }),
        })
        expect(created.status).toBe(200)
        const worker = yield* Effect.promise(() => created.json())
        const local = yield* request("/raya/contact/destinations", {
          method: "POST",
          body: JSON.stringify({
            source: "settings.raya.owner",
            channel: "raya",
            address: "owner",
            scope: { kind: "agent", id: worker.id },
          }),
        })
        expect(local.status).toBe(200)
        const target = yield* Effect.promise(() => local.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Destination)),
        )
        const sent = yield* request("/raya/contact/messages", {
          method: "POST",
          body: JSON.stringify({
            source: "routine.books.weekly.1",
            destinationID: target.id,
            agentID: worker.id,
            body: "Weekly books are ready.",
          }),
        })
        expect(sent.status).toBe(200)
        const report = yield* Effect.promise(() => sent.json())
        expect(report).toMatchObject({
          state: "delivered",
          agentID: worker.id,
          receipt: { status: "delivered", code: "delivered", attempts: 1 },
        })
        expect(report).not.toHaveProperty("leaseID")
        expect(report).not.toHaveProperty("leaseOwner")
        const repeated = yield* request("/raya/contact/messages", {
          method: "POST",
          body: JSON.stringify({
            source: "routine.books.weekly.1",
            destinationID: target.id,
            agentID: worker.id,
            body: "Weekly books are ready.",
          }),
        })
        expect(repeated.status).toBe(200)
        expect(yield* Effect.promise(() => repeated.json())).toEqual(report)
        const inbox = yield* Database.Service.use((database) => RayaTaskInbox.make(database).page(worker.id))
        expect(inbox.messages).toHaveLength(1)
        expect(inbox.messages[0]).toMatchObject({
          kind: "report",
          source: `contact:${report.id}`,
          body: "Weekly books are ready.",
        })
        const logged = yield* request("/raya/admin/logs?limit=10")
        expect(logged.status).toBe(200)
        const events = yield* Effect.promise(() => logged.json())
        expect(events.map((event: { code: string }) => event.code)).toEqual([
          "contact.authorized",
          "contact.updated",
          "contact.authorized",
          "delivery.started",
          "delivery.completed",
        ])
        expect(events.slice(0, 3).map((event: { fields: unknown }) => event.fields)).toEqual([
          { source: "routines", channel: "email", scope: "organization" },
          { source: "routines", channel: "email", scope: "organization" },
          { source: "routines", channel: "raya", scope: "agent" },
        ])
        expect(JSON.stringify(events)).not.toContain("Weekly books")
        expect(JSON.stringify(events)).not.toContain(report.id)
        expect(JSON.stringify(events)).not.toContain(worker.id)
        const external = yield* request("/raya/contact/messages", {
          method: "POST",
          body: JSON.stringify({
            source: "routine.books.email.1",
            destinationID: destination.id,
            organizationID: "org_accounts",
            body: "Do not send through an unavailable adapter.",
          }),
        })
        expect(external.status).toBe(409)

        const conflict = yield* request("/raya/contact/destinations", {
          method: "POST",
          body: JSON.stringify({
            source: "settings.email.primary",
            channel: "email",
            address: "different@example.com",
            scope: { kind: "organization", id: "org_accounts" },
          }),
        })
        expect(conflict.status).toBe(409)

        const listed = yield* request("/raya/contact/destinations?limit=1")
        expect(listed.status).toBe(200)
        expect(yield* Effect.promise(() => listed.json())).toEqual([target])

        const scoped = yield* request(`/raya/contact/destinations?limit=1&agentID=${worker.id}`)
        expect(scoped.status).toBe(200)
        expect(yield* Effect.promise(() => scoped.json())).toEqual([target])

        const localOrganization = yield* request("/raya/contact/destinations", {
          method: "POST",
          body: JSON.stringify({
            source: "routine-owner:organization:org_accounts",
            channel: "raya",
            address: "owner",
            scope: { kind: "organization", id: "org_accounts" },
          }),
        })
        expect(localOrganization.status).toBe(200)
        const organizationTarget = yield* Effect.promise(() => localOrganization.json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Destination)),
        )
        const organization = yield* request("/raya/contact/destinations?limit=1&organizationID=org_accounts")
        expect(organization.status).toBe(200)
        expect(yield* Effect.promise(() => organization.json())).toEqual([organizationTarget])

        const ambiguous = yield* request(
          `/raya/contact/destinations?limit=1&agentID=${worker.id}&organizationID=org_accounts`,
        )
        expect(ambiguous.status).toBe(400)

        const stopped = yield* request(`/raya/contact/destinations/${target.id}/revoke`, {
          method: "POST",
          body: JSON.stringify({ revision: 1 }),
        })
        expect(stopped.status).toBe(200)
        expect(yield* Effect.promise(() => stopped.json())).toMatchObject({ revision: 2, enabled: false })
        const resumed = yield* request("/raya/contact/destinations", {
          method: "POST",
          body: JSON.stringify({
            source: "settings.raya.owner",
            channel: "raya",
            address: "owner",
            scope: { kind: "agent", id: worker.id },
          }),
        })
        expect(resumed.status).toBe(200)
        expect(yield* Effect.promise(() => resumed.json())).toMatchObject({
          id: target.id,
          revision: 3,
          enabled: true,
        })

        const fetched = yield* request(`/raya/contact/destinations/${destination.id}`)
        expect(fetched.status).toBe(200)
        expect(yield* Effect.promise(() => fetched.json())).toEqual(updated)

        const queued = yield* Database.Service.use((database) =>
          RayaContactOutbox.make(database, () => 1_000).enqueue({
            source: "routine.accounts.weekly.1",
            destinationID: destination.id,
            organizationID: "org_accounts",
            body: "Weekly accounting report is ready.",
          }),
        )
        yield* Database.Service.use((database) =>
          RayaContactOutbox.make(database).claim({
            owner: "dispatcher-secret",
            leaseID: "lease-secret",
            now: 1_000,
            until: 61_000,
          }),
        )

        const messages = yield* request("/raya/contact/messages?limit=10")
        expect(messages.status).toBe(200)
        const list = yield* Effect.promise(() => messages.json())
        expect(list).toHaveLength(2)
        expect(list).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: queued.id, state: "leased", leaseUntil: 61_000, attempts: 1 }),
            expect.objectContaining({ id: report.id, state: "delivered", attempts: 1 }),
          ]),
        )
        expect(JSON.stringify(list)).not.toContain("dispatcher-secret")
        expect(JSON.stringify(list)).not.toContain("lease-secret")

        const message = yield* request(`/raya/contact/messages/${queued.id}`)
        expect(message.status).toBe(200)
        const item = yield* Effect.promise(() => message.json())
        expect(item).toMatchObject({ id: queued.id, state: "leased", leaseUntil: 61_000 })
        expect(item).not.toHaveProperty("leaseID")
        expect(item).not.toHaveProperty("leaseOwner")

        const invalid = yield* request("/raya/contact/messages/not-a-message")
        expect(invalid.status).toBe(400)

        const missing = yield* request(`/raya/contact/messages/ctm_${"0".repeat(48)}`)
        expect(missing.status).toBe(404)

        const stale = yield* request(`/raya/contact/destinations/${destination.id}/revoke`, {
          method: "POST",
          body: JSON.stringify({ revision: 1 }),
        })
        expect(stale.status).toBe(409)

        const revoked = yield* request(`/raya/contact/destinations/${destination.id}/revoke`, {
          method: "POST",
          body: JSON.stringify({ revision: 2 }),
        })
        expect(revoked.status).toBe(200)
        expect(yield* Effect.promise(() => revoked.json())).toMatchObject({
          id: destination.id,
          revision: 3,
          enabled: false,
        })
        const final = yield* request("/raya/admin/logs?limit=10")
        expect(final.status).toBe(200)
        const audit = yield* Effect.promise(() => final.json())
        expect(audit.map((event: { code: string }) => event.code)).toEqual([
          "contact.authorized",
          "contact.updated",
          "contact.authorized",
          "delivery.started",
          "delivery.completed",
          "contact.authorized",
          "contact.revoked",
          "contact.authorized",
          "contact.revoked",
        ])
        expect(JSON.stringify(audit)).not.toContain("settings.")
        expect(JSON.stringify(audit)).not.toContain(worker.id)
        expect(JSON.stringify(audit)).not.toContain(destination.id)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
