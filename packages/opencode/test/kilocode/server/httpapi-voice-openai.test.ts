import { expect, test } from "bun:test"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { OpenAIBinding } from "@/kilocode/voice/openai-protocol"
import { SessionID } from "@/session/schema"

test("the shipped OpenAI voice routes require both configured server auth and the binding capability", async () => {
  await using dir = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  const app = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KILO_SERVER_PASSWORD: "voice-test-password",
            KILO_SERVER_USERNAME: "voice-test",
            KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  const auth = `Basic ${Buffer.from("voice-test:voice-test-password").toString("base64")}`
  const key = "a".repeat(64)
  const request = (
    method: string,
    route: string,
    body?: unknown,
    secret: string | undefined = key,
    authorization: string | undefined = auth,
  ) =>
    app.handler(
      new Request(`http://localhost${route}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-kilo-directory": dir.path,
          ...(secret ? { "x-raya-voice-key": secret } : {}),
          ...(authorization ? { authorization } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      HttpApiServer.context,
    )
  try {
    const created = await request("POST", "/session", {})
    expect(created.status).toBe(200)
    const parent = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(await created.json())
    const input = { parentSessionID: parent.id, providerCallID: crypto.randomUUID(), requestID: crypto.randomUUID() }
    const base = "/kilocode/voice/openai/session"
    expect((await request("POST", base, input, key, "")).status).toBe(401)
    expect(
      (await request("POST", base, input, key, `Basic ${Buffer.from("voice-test:wrong").toString("base64")}`)).status,
    ).toBe(401)
    expect((await request("POST", base, input, "")).status).toBe(401)
    const started = await request("POST", base, input)
    expect(started.status).toBe(200)
    const binding = Schema.decodeUnknownSync(OpenAIBinding)(await started.json())
    expect(binding.parentSessionID).toBe(parent.id)
    expect(binding.model).toBe("gpt-realtime-2.1")
    expect(JSON.stringify(binding)).not.toContain(key)
    const route = `${base}/${binding.id}`
    const call = {
      generation: binding.generation,
      callID: "call_test",
      function: "raya_work",
      arguments: { request: "Do not dispatch without capability" },
    }
    expect((await request("POST", `${route}/calls`, call, "b".repeat(64))).status).toBe(401)
    expect((await request("POST", `${route}/calls`, { ...call, function: "arbitrary_tool" })).status).toBe(400)
    expect(
      (await request("POST", `${route}/calls`, { ...call, arguments: { request: "x".repeat(8001) } })).status,
    ).toBe(400)
    expect((await request("GET", `${route}/calls/missing?generation=${binding.generation}`)).status).toBe(404)
    expect((await request("POST", `${route}/calls/missing/cancel`, { generation: binding.generation })).status).toBe(
      404,
    )
    expect((await request("DELETE", `${route}?generation=stale`)).status).toBe(409)
    const closed = await request("DELETE", `${route}?generation=${binding.generation}`)
    expect(closed.status).toBe(200)
    expect(Schema.decodeUnknownSync(OpenAIBinding)(await closed.json()).status).toBe("closed")
    expect((await request("POST", `${route}/calls`, call)).status).toBe(409)
  } finally {
    await app.dispose()
    await disposeAllInstances()
    await resetDatabase()
  }
}, 60_000)
