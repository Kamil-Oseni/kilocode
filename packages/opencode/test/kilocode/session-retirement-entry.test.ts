import { afterEach, expect, test } from "bun:test"
import { SessionRetirement } from "../../src/kilocode/session/retirement"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("actual public no-reply prompt owns its SQL writes and releases its producer ticket", async () => {
  await using dir = await tmpdir({
    config: {
      enabled_providers: ["retirement"],
      provider: {
        retirement: {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "test-only", baseURL: "http://127.0.0.1:1/v1" },
          models: { "no-inference": { name: "No inference", limit: { context: 8192, output: 1024 } } },
        },
      },
    },
  })
  const app = Server.Default().app
  const headers = { "x-kilo-directory": dir.path, "content-type": "application/json" }
  expect((await app.request("/config", { headers })).status).toBe(200)
  const created = await app.request("/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Producer retirement entry" }),
  })
  expect(created.status).toBe(200)
  const session: { id: string } = await created.json()
  const before = SessionRetirement.snapshot()
  const response = await app.request(`/session/${session.id}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: "build",
      model: { providerID: "retirement", modelID: "no-inference" },
      noReply: true,
      parts: [{ type: "text", text: "Retain this actual user message without model dispatch." }],
    }),
  })
  expect(response.status).toBe(200)
  const message: { info: { id: string; sessionID: string; role: string }; parts: { type: string; text?: string }[] } =
    await response.json()
  expect(message.info.sessionID).toBe(session.id)
  expect(message.info.role).toBe("user")
  const read = await app.request(`/session/${session.id}/message`, { headers })
  expect(read.status).toBe(200)
  const rows: (typeof message)[] = await read.json()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toEqual(message)
  expect(SessionRetirement.snapshot().accepted).toBe((before.accepted ?? 0) + 1)
  expect(SessionRetirement.snapshot().active).toBe(0)
  expect(SessionRetirement.snapshot().failures).toBe(before.failures ?? 0)
})
