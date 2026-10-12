import { afterEach, expect, test } from "bun:test"
import { Server } from "@/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// Positive durable worker writes are covered by task-projection.test.ts with a
// physical SQLite selection. Default HTTP's shared unit preload uses :memory:,
// which intentionally cannot admit routine authority publication.
test("routine report HTTP validates ordinary conversations and missing destinations", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/session", { method: "POST", headers, body: "{}" })
  expect(created.status).toBe(200)
  const session = await created.json()
  const list = await app.request(`/kilocode/agent-reports?sessionID=${encodeURIComponent(session.id)}`, { headers })
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual([])
  const assigned = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Report here",
      objective: "Review jobs",
      schedule: { kind: "manual" },
      reportSessionID: "ses_missing_report",
    }),
  })
  expect(assigned.status).toBe(400)
  const missing = await app.request("/kilocode/agent-reports?sessionID=ses_missing_report", { headers })
  expect(missing.status).toBe(400)
}, 30_000)
