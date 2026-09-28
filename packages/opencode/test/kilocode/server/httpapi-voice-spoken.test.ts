import { expect, test } from "bun:test"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { OpenAIBinding } from "@/kilocode/voice/openai-protocol"
import { SessionID } from "@/session/schema"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

test("spoken history routes fence publication and recover only the new binding's parent without replay", async () => {
  await using dir = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  const app = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KILO_SERVER_PASSWORD: "spoken-test-password",
            KILO_SERVER_USERNAME: "spoken-test",
            KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  const auth = `Basic ${Buffer.from("spoken-test:spoken-test-password").toString("base64")}`
  const key = "a".repeat(64)
  const rival = "b".repeat(64)
  const base = "/kilocode/voice/openai/session"
  const request = (method: string, route: string, body?: unknown, secret = key, authorization = auth) =>
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
  const start = async (parent: string, secret = key) => {
    const input = { parentSessionID: parent, providerCallID: crypto.randomUUID(), requestID: crypto.randomUUID() }
    expect(
      (
        await request(
          "POST",
          "/kilocode/voice/openai/reservation",
          { parentSessionID: parent, requestID: input.requestID, model: "gpt-realtime-2.1" },
          secret,
        )
      ).status,
    ).toBe(200)
    const result = await request("POST", base, input, secret)
    expect(result.status).toBe(200)
    return Schema.decodeUnknownSync(OpenAIBinding)(await result.json())
  }
  try {
    const created = await request("POST", "/session", {})
    expect(created.status).toBe(200)
    const parent = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(await created.json())
    const old = await start(parent.id)
    const route = `${base}/${old.id}/spoken`
    const snapshot = {
      version: 1,
      generation: old.generation,
      providerCallID: old.providerCallID,
      revision: 1,
      items: [
        { id: "user_one", previous: null, role: "user", state: "final", text: "Learn violin" },
        { id: "assistant_one", previous: "user_one", role: "assistant", state: "omitted" },
        { id: "user_two", previous: "assistant_one", role: "user", state: "final", text: "Practice daily" },
      ],
    }
    expect((await request("POST", route, snapshot, key, "")).status).toBe(401)
    expect((await request("POST", route, snapshot, "")).status).toBe(401)
    expect((await request("POST", route, snapshot, rival)).status).toBe(401)
    expect((await request("POST", route, { ...snapshot, generation: "stale" })).status).toBe(409)
    expect((await request("POST", route, { ...snapshot, providerCallID: "another_call" })).status).toBe(409)
    expect((await request("POST", route, { ...snapshot, version: 2 })).status).toBe(400)
    expect((await request("POST", route, { ...snapshot, updatedAt: Date.now() })).status).toBe(400)
    const saved = await request("POST", route, snapshot)
    expect(saved.status).toBe(200)
    const receipt = await saved.json()
    const duplicate = await request("POST", route, snapshot)
    expect(duplicate.status).toBe(200)
    expect(await duplicate.json()).toEqual(receipt)
    expect(
      (await request("POST", route, { ...snapshot, items: [{ ...snapshot.items[0], text: "Conflicting text" }] }))
        .status,
    ).toBe(409)
    expect((await request("DELETE", `${base}/${old.id}?generation=${old.generation}`)).status).toBe(200)
    expect((await request("POST", route, { ...snapshot, revision: 2 })).status).toBe(409)

    const fresh = await start(parent.id, rival)
    const context = `${base}/${fresh.id}/context?generation=${fresh.generation}`
    expect((await request("GET", context, undefined, key)).status).toBe(401)
    expect((await request("GET", context, undefined, rival, "")).status).toBe(401)
    expect((await request("GET", `${base}/${fresh.id}/context?generation=stale`, undefined, rival)).status).toBe(409)
    const recovered = await request("GET", context, undefined, rival)
    expect(recovered.status).toBe(200)
    const history = await recovered.json()
    expect(history.version).toBe(1)
    expect(history.items.map((item: { text: string }) => item.text)).toEqual(["Learn violin", "Practice daily"])
    expect(JSON.stringify(history)).not.toContain(key)
    expect(JSON.stringify(history)).not.toContain(old.providerCallID)
    const messages = await request("GET", `/session/${parent.id}/message`)
    expect(await messages.json()).toEqual([])

    const sibling = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(
      await (await request("POST", "/session", {})).json(),
    )
    const separate = await start(sibling.id, rival)
    const unrelated = await request(
      "GET",
      `${base}/${separate.id}/context?generation=${separate.generation}`,
      undefined,
      rival,
    )
    expect(unrelated.status).toBe(200)
    expect((await unrelated.json()).items).toEqual([])
    expect((await request("DELETE", `/session/${parent.id}`)).status).toBe(200)
    expect((await request("GET", context, undefined, rival)).status).toBe(404)
    expect(
      (await request("GET", `${base}/${separate.id}/context?generation=${separate.generation}`, undefined, rival))
        .status,
    ).toBe(200)
    expect((await request("DELETE", `/session/${sibling.id}`)).status).toBe(200)
  } finally {
    await app.dispose()
    await disposeAllInstances()
    await resetDatabase()
  }
}, 60_000)
