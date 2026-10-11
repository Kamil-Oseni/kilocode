import { expect } from "bun:test"
import path from "node:path"
import { and, eq, inArray } from "drizzle-orm"
import {
  RayaRoutineOrganizationMemberTable as Member,
  RayaRoutineOrganizationTable as Team,
} from "@opencode-ai/core/kilocode/routine.sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppRuntime } from "@/effect/app-runtime"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { finish } from "@/kilocode/cli/finish"
import { KiloShutdown } from "@/kilocode/cli/shutdown"
import { Effect, Schema } from "effect"
import { Server } from "@/server/server"
import { RayaTask } from "@/kilocode/task"
import { Organization, Page } from "@/kilocode/task/organization"
import { Record as Delegation } from "@/kilocode/task/delegation"
import { ActivityPage } from "@/kilocode/task/info"
const root = process.env.RAYA_ORGANIZATION_PROFILE
if (!root) throw new Error("Owned organization profile missing")
const directory = { path: process.env.RAYA_ORGANIZATION_WORKSPACE! }
try {
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const worker = async (name: string, enabled = true) => {
    const response = await app.request("/kilocode/agent", {
      method: "POST",
      headers,
      body: JSON.stringify({ name, objective: `${name} work`, schedule: { kind: "manual" }, enabled }),
    })
    expect(response.status).toBe(200)
    return Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await response.json())
  }
  const chief = await worker("Chief")
  const books = await worker("Books", false)
  const other = await worker("Other")
  const create = await app.request("/kilocode/organization", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Website Builders",
      purpose: "Build client websites.",
      members: [
        { agentID: chief.id, role: "CEO" },
        { agentID: books.id, role: "Accounting", supervisorID: chief.id },
      ],
      delegations: [{ senderID: chief.id, recipientID: books.id }],
    }),
  })
  expect(create.status).toBe(200)
  const organization = Schema.decodeUnknownSync(Schema.toCodecJson(Organization))(await create.json())
  expect(organization).toMatchObject({ version: 1, revision: 1, archived: false })
  expect(organization.members.map((member) => member.position)).toEqual([0, 1])
  expect(organization.delegations).toEqual([{ senderID: chief.id, recipientID: books.id, position: 0 }])
  const route = `/kilocode/organization/${organization.id}`
  expect((await app.request(route, { headers })).status).toBe(200)
  expect((await app.request(`/kilocode/agent/${books.id}`, { method: "DELETE", headers })).status).toBe(400)
  const missing = await app.request(`/kilocode/agent/${chief.id}/delegate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "http_missing_org",
      senderID: chief.id,
      recipientID: books.id,
      objective: "Review the accounts.",
    }),
  })
  expect(missing.status).toBe(400)
  const reverse = await app.request(`/kilocode/agent/${books.id}/delegate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "http_reverse_org",
      senderID: books.id,
      recipientID: chief.id,
      organizationID: organization.id,
      organizationRevision: organization.revision,
      objective: "Approve the accounts.",
    }),
  })
  expect(reverse.status).toBe(400)
  const deadline = Date.now() + 60_000
  const delegated = await app.request(`/kilocode/agent/${chief.id}/delegate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "http_org",
      senderID: chief.id,
      recipientID: books.id,
      organizationID: organization.id,
      organizationRevision: organization.revision,
      objective: "Review the accounts.",
      expected: "A reconciled ledger.",
      context: "Use the approved finance workspace.",
      deadline,
      budget: 40,
    }),
  })
  expect(delegated.status).toBe(200)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(Delegation))(await delegated.json())).toMatchObject({
    state: "failed",
    organizationID: organization.id,
    organizationName: organization.name,
    organizationRevision: 1,
    expected: "A reconciled ledger.",
    context: "Use the approved finance workspace.",
    deadline,
    budget: 40,
  })
  const activity = Schema.decodeUnknownSync(Schema.toCodecJson(ActivityPage))(
    await (await app.request(`${route}/activity`, { headers })).json(),
  )
  expect(activity.items).toHaveLength(1)
  expect(activity.summary).toEqual({
    total: 1,
    active: 0,
    needsAttention: 1,
    uncertain: 0,
    recordedCost: 0,
    committedCost: 0,
    standaloneCost: 0,
    coordinatorCost: 0,
  })
  expect(activity.items[0]).toMatchObject({
    sender: { id: chief.id, name: "Chief", archived: false },
    recipient: { id: books.id, name: "Books", archived: false },
    organizationID: organization.id,
    organizationName: organization.name,
    objective: "Review the accounts.",
    expected: "A reconciled ledger.",
    context: "Use the approved finance workspace.",
    deadline,
    budget: 40,
    state: "failed",
  })
  expect((await app.request(`${route}/activity?cursor=invalid`, { headers })).status).toBe(400)
  expect(
    (await app.request("/kilocode/organization/org_00000000000000000000000000000000/activity", { headers })).status,
  ).toBe(404)

  const invalid = await app.request(route, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      expectedRevision: 1,
      members: [
        { agentID: chief.id, role: "CEO", supervisorID: books.id },
        { agentID: books.id, role: "Accounting", supervisorID: chief.id },
      ],
    }),
  })
  expect(invalid.status).toBe(400)
  const update = await app.request(route, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ expectedRevision: 1, name: "Website Operations", purpose: null }),
  })
  expect(update.status).toBe(200)
  const revised = Schema.decodeUnknownSync(Schema.toCodecJson(Organization))(await update.json())
  expect(revised).toMatchObject({ name: "Website Operations", revision: 2 })
  expect(revised.purpose).toBeUndefined()
  expect(revised.delegations).toEqual(organization.delegations)
  expect(
    (
      await app.request(`/kilocode/agent/${chief.id}/delegate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: "http_stale_org",
          senderID: chief.id,
          recipientID: books.id,
          organizationID: organization.id,
          organizationRevision: 1,
          objective: "Review the accounts again.",
        }),
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await app.request(route, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedRevision: 1, name: "Stale" }),
      })
    ).status,
  ).toBe(409)

  const second = await app.request("/kilocode/organization", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Other Org", members: [{ agentID: other.id, role: "Owner" }] }),
  })
  expect(second.status).toBe(200)
  const firstPage = Schema.decodeUnknownSync(Schema.toCodecJson(Page))(
    await (await app.request("/kilocode/organization?limit=1", { headers })).json(),
  )
  expect(firstPage.items).toHaveLength(1)
  expect(firstPage.next).toBeDefined()
  const secondPage = Schema.decodeUnknownSync(Schema.toCodecJson(Page))(
    await (
      await app.request(`/kilocode/organization?limit=1&cursor=${encodeURIComponent(firstPage.next!)}`, { headers })
    ).json(),
  )
  expect(secondPage.items).toHaveLength(1)
  expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(2)

  expect(
    (
      await app.request(route, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ expectedRevision: 1 }),
      })
    ).status,
  ).toBe(409)
  await AppRuntime.runPromise(
    Database.Service.use((database) =>
      Effect.gen(function* () {
        const db = database.db
        const saved = yield* db.select().from(Team).where(eq(Team.id, organization.id)).get()
        const extra = Array.from({ length: 49 }, (_, index) => ({
          organization_id: organization.id,
          agent_id: `corrupt_capacity_${index}`,
          role: "Saved corrupt reference",
          position: index + 2,
          supervisor_id: null,
          time_created: 1,
          time_updated: 1,
        }))
        yield* db.insert(Member).values(extra).run()
        const before = yield* db
          .select()
          .from(Member)
          .where(eq(Member.organization_id, organization.id))
          .orderBy(Member.position)
          .all()
        expect(before).toHaveLength(51)
        for (const [method, suffix, body] of [
          ["GET", "", undefined],
          ["PATCH", "", { expectedRevision: 2, name: "Must not replace" }],
          ["DELETE", "", { expectedRevision: 2 }],
          ["GET", "/activity", undefined],
          ["POST", "/assignment-proposal", { revision: 2, intent: "Must not propose" }],
        ] as const) {
          const response = yield* Effect.promise(async () =>
            app.request(route + suffix, {
              method,
              headers,
              ...(body ? { body: JSON.stringify(body) } : {}),
            }),
          )
          expect(response.status, yield* Effect.promise(() => response.clone().text())).toBe(400)
          expect(yield* db.select().from(Team).where(eq(Team.id, organization.id)).get()).toEqual(saved)
          expect(
            yield* db
              .select()
              .from(Member)
              .where(eq(Member.organization_id, organization.id))
              .orderBy(Member.position)
              .all(),
          ).toEqual(before)
          const workers = yield* Effect.promise(async () => (await app.request("/kilocode/agent", { headers })).json())
          expect(
            Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(RayaTask.Agent)))(workers).find(
              (item) => item.id === chief.id,
            )?.enabled,
          ).toBe(true)
        }
        yield* db
          .delete(Member)
          .where(
            and(
              eq(Member.organization_id, organization.id),
              inArray(
                Member.agent_id,
                extra.map((item) => item.agent_id),
              ),
            ),
          )
          .run()
      }),
    ),
  )
  const archived = await app.request(route, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedRevision: 2 }),
  })
  expect(archived.status).toBe(200)
  const paused = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(RayaTask.Agent)))(
    await (await app.request("/kilocode/agent", { headers })).json(),
  )
  expect(paused.find((item) => item.id === chief.id)?.enabled).toBe(false)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(Organization))(await archived.json())).toMatchObject({
    archived: true,
    revision: 3,
  })
  expect((await app.request("/kilocode/organization", { headers })).status).toBe(200)
  const archive = Schema.decodeUnknownSync(Schema.toCodecJson(Page))(
    await (await app.request("/kilocode/organization?archived=true", { headers })).json(),
  )
  expect(archive.items.map((item) => item.id)).toContain(organization.id)
  expect((await app.request(`/kilocode/agent/${books.id}`, { method: "DELETE", headers })).status).toBe(200)
  expect((await app.request(route, { headers })).status).toBe(200)

  const rows = await AppRuntime.runPromise(
    Database.Service.use((db) => db.db.all<{ name: string; file: string }>("PRAGMA database_list")),
  )
  expect(rows.find((row) => row.name === "main")?.file).toBe(path.join(root, "raya.db"))
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
await finish(
  [
    async () => {
      if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
      await KiloShutdown.run()
      await AppRuntime.dispose()
    },
  ],
  () =>
    Bun.write(
      path.join(root, "receipt.json"),
      JSON.stringify({ passed: true, pid: process.pid, physical: path.join(root, "raya.db") }),
    ).then(() => {}),
)
