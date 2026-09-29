import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { Server } from "@/server/server"
import { RayaTask } from "@/kilocode/task"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("versioned routine event route returns a snapshot and rejects invalid replay cursors", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/kilocode/agent", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Worker", objective: "Work", schedule: { kind: "manual" } }),
  })
  expect(created.status).toBe(200)
  const agent = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await created.json())
  const url = `/kilocode/agent/${agent.id}/events`
  const snapshot = await app.request(url, { headers })
  expect(snapshot.status).toBe(200)
  expect(Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.EventPage))(await snapshot.json())).toEqual({
    version: 1,
    cursor: 0,
    runs: [],
    events: [],
  })
  expect((await app.request(`${url}?after=0`, { headers })).status).toBe(200)
  for (const after of ["-1", "1", "nope", "1.5"]) {
    const result = await app.request(`${url}?after=${after}`, { headers })
    expect(result.status).toBe(400)
  }
})
