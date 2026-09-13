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

test("aggregate routine histories return every active worker through one HTTP request", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const ids: string[] = []
  for (const name of ["Books", "Chief"]) {
    const response = await app.request("/kilocode/agent", {
      method: "POST",
      headers,
      body: JSON.stringify({ name, objective: `${name} work`, schedule: { kind: "manual" } }),
    })
    expect(response.status).toBe(200)
    ids.push(Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Agent))(await response.json()).id)
  }

  const response = await app.request("/kilocode/agent-runs", { headers })
  expect(response.status).toBe(200)
  const histories = Schema.decodeUnknownSync(Schema.toCodecJson(RayaTask.Histories))(await response.json())
  expect(histories.failed).toEqual([])
  expect(histories.items.map((item) => item.agentID)).toEqual(ids)
  expect(histories.items.every((item) => item.runs.length === 0)).toBe(true)
})
