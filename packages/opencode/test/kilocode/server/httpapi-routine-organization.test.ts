import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { Server } from "@/server/server"
import { RayaTask } from "@/kilocode/task"
import { Organization, Page } from "@/kilocode/task/organization"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("routine organization HTTP persists ordered graphs with optimistic archive lifecycle", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const worker = async (name: string) => {
    const response = await app.request("/kilocode/agent", {
      method: "POST",
      headers,
      body: JSON.stringify({ name, objective: `${name} work`, schedule: { kind: "manual" } }),
    })
    expect(response.status).toBe(200)
    return Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await response.json())
  }
  const chief = await worker("Chief")
  const books = await worker("Books")
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
    }),
  })
  expect(create.status).toBe(200)
  const organization = Schema.decodeUnknownSync(Schema.toCodecJson(Organization))(await create.json())
  expect(organization).toMatchObject({ version: 1, revision: 1, archived: false })
  expect(organization.members.map((member) => member.position)).toEqual([0, 1])
  const route = `/kilocode/organization/${organization.id}`
  expect((await app.request(route, { headers })).status).toBe(200)
  expect((await app.request(`/kilocode/agent/${books.id}`, { method: "DELETE", headers })).status).toBe(400)

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

  const archived = await app.request(route, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ expectedRevision: 2 }),
  })
  expect(archived.status).toBe(200)
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
}, 90_000)
