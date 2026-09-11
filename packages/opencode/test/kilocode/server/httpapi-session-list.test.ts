import { afterEach, expect, test } from "bun:test"
import { Server } from "@/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("the default session list omits routine execution sessions and keeps them readable", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const chat = await (
    await app.request("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Ordinary chat" }),
    })
  ).json()
  const work = await (
    await app.request("/session", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Accounts",
        metadata: {
          rayaRoutine: {
            version: 1,
            agentID: "agt_books",
            runID: "run_1",
            scheduleVersion: 1,
            trigger: { kind: "manual" },
          },
        },
      }),
    })
  ).json()
  expect(chat.id).toBeDefined()
  expect(work.id).toBeDefined()
  const listed = await (await app.request("/session?roots=true", { headers })).json()
  expect(listed.map((item: { id: string }) => item.id)).toContain(chat.id)
  expect(listed.map((item: { id: string }) => item.id)).not.toContain(work.id)
  expect((await (await app.request(`/session/${work.id}`, { headers })).json()).id).toBe(work.id)
  const only = await (await app.request("/session?roots=true&kind=routine", { headers })).json()
  expect(only.map((item: { id: string }) => item.id)).toContain(work.id)
  expect(only.map((item: { id: string }) => item.id)).not.toContain(chat.id)
  const all = await (await app.request("/session?roots=true&kind=all", { headers })).json()
  expect(all.map((item: { id: string }) => item.id)).toContain(chat.id)
  expect(all.map((item: { id: string }) => item.id)).toContain(work.id)
}, 30_000)
