import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { Server } from "@/server/server"
import { RayaTask } from "@/kilocode/task"
import { Lineage, Record } from "@/kilocode/task/delegation"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("the shipped routine delegate route tracks a chief-to-accounting request", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const chief = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(
    await (
      await app.request("/kilocode/agent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Chief of Staff",
          role: "generalist",
          objective: "Coordinate Friday close.",
          access: "brief",
          enabled: true,
          schedule: { kind: "manual" },
        }),
      })
    ).json(),
  )
  const books = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(
    await (
      await app.request("/kilocode/agent", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Accounting",
          role: "accountant",
          objective: "Reconcile receipts.",
          capabilities: ["accounting"],
          access: "full",
          enabled: true,
          schedule: { kind: "manual" },
        }),
      })
    ).json(),
  )
  const send = {
    source: "dlg_friday",
    senderID: chief.id,
    recipientID: books.id,
    objective: "List missing Friday receipts.",
  }
  const admitted = await app.request(`/kilocode/agent/${chief.id}/delegate`, {
    method: "POST",
    headers,
    body: JSON.stringify(send),
  })
  expect(admitted.status).toBe(200)
  const row = Schema.decodeUnknownSync(Schema.toCodecJson(Record))(await admitted.json())
  expect(row.senderID).toBe(chief.id)
  expect(row.recipientID).toBe(books.id)
  expect(row.state).toBe("running")
  expect((await app.request(`/kilocode/agent/${chief.id}/delegate`, { method: "POST", headers, body: JSON.stringify(send) })).status).toBe(
    200,
  )
  expect(
    (
      await app.request(`/kilocode/agent/${chief.id}/delegate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...send, objective: "A different request" }),
      })
    ).status,
  ).toBe(409)
  const got = await app.request(`/kilocode/agent/${chief.id}/delegate/${row.id}`, { headers })
  expect(got.status).toBe(200)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(Record))(await got.json()).id).toBe(row.id)
  const roster = await (await app.request("/kilocode/agent", { headers })).json()
  const listed = Array.isArray(roster) ? roster : []
  expect(listed.find((item: { id: string }) => item.id === chief.id)?.objective).toBe("Coordinate Friday close.")
  expect(listed.find((item: { id: string }) => item.id === books.id)?.objective).toBe("Reconcile receipts.")
  const cancelled = await app.request(`/kilocode/agent/${chief.id}/delegate/${row.id}/cancel`, {
    method: "POST",
    headers,
  })
  expect(cancelled.status).toBe(200)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(Record))(await cancelled.json()).state).toBe("cancelled")
  expect(
    (
      await app.request(`/kilocode/agent/${chief.id}/delegate/${row.id}/cancel`, {
        method: "POST",
        headers,
      })
    ).status,
  ).toBe(200)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(Record))(await (await app.request(`/kilocode/agent/${chief.id}/delegate/${row.id}`, { headers })).json()).state).toBe(
    "cancelled",
  )
}, 60_000)

test("the shipped routine delegate chain returns stored parent and follow-on records", async () => {
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
  const chief = await spawn("Chief of Staff", "generalist", "Coordinate Friday close.")
  const books = await spawn("Accounting", "accountant", "Reconcile receipts.", ["accounting"])
  const legal = await spawn("Legal", "reviewer", "Review exceptions.")
  const extra = await spawn("Research", "generalist", "Gather sources.")
  const parent = Schema.decodeUnknownSync(Schema.toCodecJson(Record))(
    await (
      await app.request(`/kilocode/agent/${chief.id}/delegate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: "dlg_parent",
          senderID: chief.id,
          recipientID: books.id,
          objective: "List missing Friday receipts.",
        }),
      })
    ).json(),
  )
  const nested = await app.request(`/kilocode/agent/${books.id}/delegate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "dlg_child",
      senderID: books.id,
      recipientID: legal.id,
      parentID: parent.id,
      objective: "Name the missing travel receipts.",
    }),
  })
  expect(nested.status).toBe(200)
  const child = Schema.decodeUnknownSync(Schema.toCodecJson(Record))(await nested.json())
  expect(child.parentID).toBe(parent.id)
  const found = Schema.decodeUnknownSync(Schema.toCodecJson(Lineage))(
    await (await app.request(`/kilocode/agent/${chief.id}/delegate/${parent.id}/chain`, { headers })).json(),
  )
  expect(found.record.id).toBe(parent.id)
  expect(found.above).toEqual([])
  expect(found.below.map((item) => item.id)).toEqual([child.id])
  const fromChild = Schema.decodeUnknownSync(Schema.toCodecJson(Lineage))(
    await (await app.request(`/kilocode/agent/${books.id}/delegate/${child.id}/chain`, { headers })).json(),
  )
  expect(fromChild.above.map((item) => item.id)).toEqual([parent.id])
  expect(fromChild.record.id).toBe(child.id)
  expect((await app.request(`/kilocode/agent/${extra.id}/delegate/${parent.id}/chain`, { headers })).status).toBe(404)
}, 60_000)
