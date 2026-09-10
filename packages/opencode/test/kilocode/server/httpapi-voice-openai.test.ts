import { expect, test } from "bun:test"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { OpenAIBinding, OpenAIImage } from "@/kilocode/voice/openai-protocol"
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
    const image = {
      generation: binding.generation,
      id: "image-one",
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6p8AAAAASUVORK5CYII=",
    }
    expect((await request("POST", `${route}/images`, image, key, "")).status).toBe(401)
    expect((await request("POST", `${route}/images`, image, "b".repeat(64))).status).toBe(401)
    expect((await request("POST", `${route}/images`, { ...image, generation: "stale" })).status).toBe(409)
    expect((await request("POST", `${route}/images`, { ...image, data: "invalid" })).status).toBe(400)
    const staged = await request("POST", `${route}/images`, image)
    expect(staged.status).toBe(200)
    const receipt = Schema.decodeUnknownSync(OpenAIImage)(await staged.json())
    expect(receipt.id).toBe(image.id)
    expect(receipt.bytes).toBe(Buffer.from(image.data, "base64").length)
    expect(JSON.stringify(receipt)).not.toContain(image.data)
    const messages = await request("GET", `/session/${parent.id}/message`)
    expect(messages.status).toBe(200)
    expect(await messages.json()).toEqual([])
    const usage = {
      generation: binding.generation,
      receipt: {
        id: "response_1",
        kind: "response",
        model: "gpt-realtime-2.1",
        status: "reported",
        tokens: { input: 4, output: 2, total: 6 },
      },
    }
    expect((await request("POST", `${route}/usage`, usage, key, "")).status).toBe(401)
    expect((await request("POST", `${route}/usage`, usage, "b".repeat(64))).status).toBe(401)
    expect((await request("POST", `${route}/usage`, { ...usage, generation: "stale" })).status).toBe(409)
    expect((await request("POST", `${route}/usage`, usage)).status).toBe(200)
    expect((await request("POST", `${route}/usage`, usage)).status).toBe(200)
    expect(
      (await request("GET", `${route}/usage?generation=${binding.generation}`, undefined, "b".repeat(64))).status,
    ).toBe(401)
    expect(await (await request("GET", `${route}/usage?generation=${binding.generation}`)).json()).toEqual({
      receipts: [usage.receipt],
    })
    expect(
      (
        await request("POST", `${route}/usage`, {
          ...usage,
          receipt: { ...usage.receipt, tokens: { input: 4, output: 2, total: 9 } },
        })
      ).status,
    ).toBe(400)
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
    expect((await request("POST", `${route}/images`, image)).status).toBe(409)
  } finally {
    await app.dispose()
    await disposeAllInstances()
    await resetDatabase()
  }
}, 60_000)
