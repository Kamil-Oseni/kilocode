import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { Server } from "@/server/server"
import { RayaTask } from "@/kilocode/task"
import { Item, Page, Record } from "@/kilocode/task/inbox"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("the shipped routine inbox requires a roster worker and keeps follow-ups idempotent", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  expect((await app.request("/kilocode/agent-inbox", { headers })).status).toBe(200)
  expect(await (await app.request("/kilocode/agent-inbox", { headers })).json()).toEqual([])
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Accounts",
      role: "accountant",
      objective: "Review accounts",
      capabilities: ["accounting"],
      enabled: false,
      schedule: { kind: "manual" },
    }),
  })
  expect(created.status).toBe(200)
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const listed = await app.request("/kilocode/agent-inbox", { headers })
  expect(listed.status).toBe(200)
  const items = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(Item)))(await listed.json())
  expect(items).toHaveLength(1)
  expect(items[0].agentID).toBe(agent.id)
  expect(items[0].conversationID.startsWith("rcv_")).toBe(true)
  expect(items[0].unread).toBe(0)
  expect(items[0].state).toBe("paused")
  expect(items[0].latest).toBeUndefined()
  const route = `/kilocode/agent/${agent.id}/inbox`
  expect((await app.request(route, { headers })).status).toBe(200)
  expect((await app.request(`/kilocode/agent/missing/inbox`, { headers })).status).toBe(404)
  const send = {
    source: "user_1",
    body: "Why did expenses increase on that Friday report?",
  }
  const admitted = await app.request(route, { method: "POST", headers, body: JSON.stringify(send) })
  expect(admitted.status).toBe(200)
  const message = Schema.decodeUnknownSync(Schema.toCodecJson(Record))(await admitted.json())
  expect(message.kind).toBe("user")
  expect(message.agentID).toBe(agent.id)
  expect((await app.request(route, { method: "POST", headers, body: JSON.stringify(send) })).status).toBe(200)
  expect(
    (
      await app.request(route, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...send, body: "A different follow-up" }),
      })
    ).status,
  ).toBe(409)
  expect((await app.request(route, { method: "POST", headers, body: JSON.stringify({ source: "user_2", body: "   " }) })).status).toBe(
    400,
  )
  const page = Schema.decodeUnknownSync(Schema.toCodecJson(Page))(await (await app.request(route, { headers })).json())
  expect(page.messages).toHaveLength(1)
  expect(page.messages[0].id).toBe(message.id)
  expect(message.sessionID).toBeDefined()
  const history = await (await app.request(`/kilocode/agent/${agent.id}/runs`, { headers })).json()
  expect(Array.isArray(history)).toBe(true)
  expect(history).toHaveLength(1)
  expect(history[0].sessionID).toBe(message.sessionID)
  expect(
    (await (await app.request(`/kilocode/agent/${agent.id}/runs`, { headers })).json()),
  ).toHaveLength(1)
  const roster = await (await app.request("/kilocode/agent", { headers })).json()
  const worker = Array.isArray(roster) ? roster.find((item: { id: string }) => item.id === agent.id) : undefined
  expect(worker?.objective).toBe("Review accounts")
  expect(worker?.enabled).toBe(false)
  const draft = await app.request(`${route}/draft`, {
    method: "POST",
    headers,
    body: JSON.stringify({ draft: "Ask for the travel breakdown" }),
  })
  expect(draft.status).toBe(200)
  expect(await draft.json()).toEqual({ draft: "Ask for the travel breakdown" })
  expect(
    Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(Item)))(
      await (await app.request("/kilocode/agent-inbox", { headers })).json(),
    )[0].draft,
  ).toBe("Ask for the travel breakdown")
  const read = await app.request(`${route}/read`, {
    method: "POST",
    headers,
    body: JSON.stringify({ at: message.time }),
  })
  expect(read.status).toBe(200)
  expect(await read.json()).toEqual({ at: message.time })
  expect(
    (
      await app.request(`${route}/read`, {
        method: "POST",
        headers,
        body: JSON.stringify({ at: 0 }),
      })
    ).status,
  ).toBe(200)
  expect(await (await app.request(`${route}/read`, { method: "POST", headers, body: JSON.stringify({ at: 0 }) })).json()).toEqual({
    at: message.time,
  })
}, 30_000)

test("renamed workers keep conversation identity and archived inbox stays readable", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const spawn = async (name: string, role: string, objective: string, capabilities?: string[]) =>
    Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(
      await (
        await app.request("/kilocode/agent", {
          method: "POST",
          headers,
          body: JSON.stringify({
            name,
            role,
            objective,
            ...(capabilities ? { capabilities } : {}),
            access: "full",
            enabled: true,
            schedule: { kind: "manual" },
          }),
        })
      ).json(),
    )
  const books = await spawn("Books", "accountant", "Review accounts.", ["accounting"])
  const route = `/kilocode/agent/${books.id}/inbox`
  expect((await app.request(route, { headers })).status).toBe(200)
  const renamed = await app.request(`/kilocode/agent/${books.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Accounting" }),
  })
  expect(renamed.status).toBe(200)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await renamed.json()).name).toBe("Accounting")
  const listed = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(Item)))(
    await (await app.request("/kilocode/agent-inbox", { headers })).json(),
  )
  const row = listed.find((item) => item.agentID === books.id)
  expect(row?.name).toBe("Accounting")
  expect(row?.agentID).toBe(books.id)
  expect((await app.request(`/kilocode/agent/${books.id}`, { method: "DELETE", headers })).status).toBe(200)
  expect(
    Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(Item)))(
      await (await app.request("/kilocode/agent-inbox", { headers })).json(),
    ).some((item) => item.agentID === books.id),
  ).toBe(false)
  expect((await app.request(route, { headers })).status).toBe(200)
  expect(
    (
      await app.request(route, {
        method: "POST",
        headers,
        body: JSON.stringify({ source: "user_late", body: "Still there?" }),
      })
    ).status,
  ).toBe(404)
  const chief = await spawn("Chief of Staff", "generalist", "Coordinate Friday close.")
  const extra = await spawn("Legal", "reviewer", "Review exceptions.")
  const asked = await app.request(`/kilocode/agent/${chief.id}/delegate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "dlg_held_archive",
      senderID: chief.id,
      recipientID: extra.id,
      objective: "List missing Friday receipts.",
    }),
  })
  expect(asked.status).toBe(200)
  const blocked = await app.request(`/kilocode/agent/${extra.id}`, { method: "DELETE", headers })
  expect(blocked.status).toBe(400)
  expect(await blocked.json()).toMatchObject({
    message: expect.stringMatching(/unfinished runs|outstanding delegated requests/),
  })
}, 60_000)

test("routine inbox HTTP pages refuse a limit above 50", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Accounts",
      role: "accountant",
      objective: "Review accounts",
      capabilities: ["accounting"],
      enabled: false,
      schedule: { kind: "manual" },
    }),
  })
  expect(created.status).toBe(200)
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const route = `/kilocode/agent/${agent.id}/inbox`
  expect((await app.request(`${route}?limit=51`, { headers })).status).toBe(400)
  expect((await app.request(`${route}?limit=0`, { headers })).status).toBe(400)
  const page = Schema.decodeUnknownSync(Schema.toCodecJson(Page))(await (await app.request(route, { headers })).json())
  expect(page.messages).toEqual([])
}, 60_000)
