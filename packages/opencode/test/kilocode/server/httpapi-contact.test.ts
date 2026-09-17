import { afterEach, expect, setDefaultTimeout } from "bun:test"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { Destination, RayaContactOutbox } from "@/kilocode/contact/outbox"
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
        expect(yield* Effect.promise(() => listed.json())).toEqual([destination])

        const fetched = yield* request(`/raya/contact/destinations/${destination.id}`)
        expect(fetched.status).toBe(200)
        expect(yield* Effect.promise(() => fetched.json())).toEqual(destination)

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
        expect(list).toEqual([
          expect.objectContaining({ id: queued.id, state: "leased", leaseUntil: 61_000, attempts: 1 }),
        ])
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
          body: JSON.stringify({ revision: 2 }),
        })
        expect(stale.status).toBe(409)

        const revoked = yield* request(`/raya/contact/destinations/${destination.id}/revoke`, {
          method: "POST",
          body: JSON.stringify({ revision: 1 }),
        })
        expect(revoked.status).toBe(200)
        expect(yield* Effect.promise(() => revoked.json())).toMatchObject({
          id: destination.id,
          revision: 2,
          enabled: false,
        })
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
