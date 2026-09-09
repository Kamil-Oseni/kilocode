import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { Server } from "@/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("review routes return a typed conflict for stale revision preconditions", async () => {
  await using directory = await tmpdir({ git: true })
  const headers = { "content-type": "application/json", "x-kilo-directory": directory.path }
  const app = Server.Default().app
  const created = await app.request("/session", { method: "POST", headers, body: "{}" })
  expect(created.status).toBe(200)
  const session = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(await created.json())
  for (const action of ["keep_changes", "discard_changes"]) {
    const response = await app.request(`/session/${session.id}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected: { "stale.ts": "0".repeat(64) } }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ _tag: "ReviewConflict" })
  }
  const body = JSON.stringify({ requestID: "http-retry-a", expected: {} })
  for (const action of ["keep_changes", "keep_changes", "discard_changes"]) {
    const response = await app.request(`/session/${session.id}/${action}`, { method: "POST", headers, body })
    expect(response.status).toBe(action === "keep_changes" ? 200 : 409)
  }
}, 30_000)
