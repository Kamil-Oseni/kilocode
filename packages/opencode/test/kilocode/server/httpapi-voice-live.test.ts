import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { OpenAIBinding, OpenAICall } from "@/kilocode/voice/openai-protocol"
import { LiveDuration } from "@/kilocode/voice/live-protocol"
import { SessionID } from "@/session/schema"

test("the shipped Live voice routes keep duration and delegation behind auth and parent ownership", async () => {
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
  const context = (generation: string, delegation: string, sequence: number, text = "Please summarize the current file") => ({
    generation,
    context: {
      version: 1 as const,
      delegation,
      offset: sequence * 900,
      fragments: [
        {
          id: `frag_${sequence}`,
          speaker: "user" as const,
          text,
          start: 0,
          end: 900,
          sequence,
        },
      ],
      incomplete: true as const,
      omitted: false,
    },
  })
  try {
    const created = await request("POST", "/session", {})
    expect(created.status).toBe(200)
    const parent = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(await created.json())
    const sibling = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(
      await (await request("POST", "/session", {})).json(),
    )
    const openai = "/kilocode/voice/openai/session"
    const live = "/kilocode/voice/live/session"
    const input = {
      parentSessionID: parent.id,
      providerCallID: crypto.randomUUID(),
      requestID: crypto.randomUUID(),
      model: "gpt-live-1" as const,
    }
    expect((await request("POST", openai, input, key, "")).status).toBe(401)
    expect((await request("POST", openai, input, "")).status).toBe(401)
    const started = await request("POST", openai, input)
    expect(started.status).toBe(200)
    const binding = Schema.decodeUnknownSync(OpenAIBinding)(await started.json())
    expect(binding.model).toBe("gpt-live-1")
    expect(binding.parentSessionID).toBe(parent.id)
    expect(JSON.stringify(binding)).not.toContain(key)
    const calls = `${live}/${binding.id}/calls`
    const duration = `${live}/${binding.id}/duration`
    const receipt = { id: "evt_duration_1", model: "gpt-live-1" as const, seconds: 4.5 }
    const meter = { generation: binding.generation, receipt }
    const first = context(binding.generation, "dlg_1", 1)
    expect((await request("POST", calls, first, key, "")).status).toBe(401)
    expect((await request("POST", calls, first, "b".repeat(64))).status).toBe(401)
    expect((await request("POST", calls, context("stale_generation_1", "dlg_1", 1))).status).toBe(409)
    expect((await request("POST", calls, { ...first, context: { ...first.context, fragments: [] } })).status).toBe(400)
    expect(
      (
        await request("POST", calls, {
          ...first,
          context: {
            ...first.context,
            fragments: [
              {
                id: "frag_1",
                speaker: "assistant",
                text: "Generated speech",
                start: 0,
                end: 900,
                sequence: 1,
              },
            ],
          },
        })
      ).status,
    ).toBe(400)
    const admitted = await request("POST", calls, first)
    expect(admitted.status).toBe(200)
    const call = Schema.decodeUnknownSync(OpenAICall)(await admitted.json())
    expect(call.callID).toBe(`liv_${createHash("sha256").update("dlg_1").digest("hex").slice(0, 48)}`)
    expect(call.parentSessionID).toBe(parent.id)
    expect(JSON.stringify(call)).not.toContain(key)
    const retry = await request("POST", calls, context(binding.generation, "dlg_1", 1))
    expect(retry.status).toBe(200)
    expect(Schema.decodeUnknownSync(OpenAICall)(await retry.json()).id).toBe(call.id)
    expect((await request("POST", calls, context(binding.generation, "dlg_2", 1))).status).toBe(409)
    expect((await request("POST", duration, meter, key, "")).status).toBe(401)
    expect((await request("POST", duration, meter, "b".repeat(64))).status).toBe(401)
    expect((await request("POST", duration, { ...meter, generation: "stale_generation_1" })).status).toBe(409)
    expect((await request("POST", duration, { ...meter, receipt: { ...receipt, seconds: -1 } })).status).toBe(400)
    expect((await request("POST", duration, { ...meter, receipt: { ...receipt, seconds: 86401 } })).status).toBe(400)
    expect((await request("POST", duration, { ...meter, receipt: { ...receipt, model: "gpt-realtime-2.1" } })).status).toBe(
      400,
    )
    const closed = await request("DELETE", `${openai}/${binding.id}?generation=${binding.generation}`)
    expect(closed.status).toBe(200)
    expect(Schema.decodeUnknownSync(OpenAIBinding)(await closed.json()).status).toBe("closed")
    expect((await request("POST", calls, context(binding.generation, "dlg_3", 2))).status).toBe(409)
    const saved = await request("POST", duration, meter)
    expect(saved.status).toBe(200)
    expect(Schema.decodeUnknownSync(LiveDuration)(await saved.json())).toEqual(receipt)
    const same = await request("POST", duration, meter)
    expect(same.status).toBe(200)
    expect(Schema.decodeUnknownSync(LiveDuration)(await same.json())).toEqual(receipt)
    expect((await request("POST", duration, { ...meter, receipt: { ...receipt, seconds: 9 } })).status).toBe(409)
    const realtime = Schema.decodeUnknownSync(OpenAIBinding)(
      await (
        await request("POST", openai, {
          parentSessionID: sibling.id,
          providerCallID: crypto.randomUUID(),
          requestID: crypto.randomUUID(),
        })
      ).json(),
    )
    expect(realtime.model).toBe("gpt-realtime-2.1")
    expect(
      (
        await request("POST", `${live}/${realtime.id}/duration`, {
          generation: realtime.generation,
          receipt,
        })
      ).status,
    ).toBe(409)
    const other = Schema.decodeUnknownSync(OpenAIBinding)(
      await (
        await request("POST", openai, {
          parentSessionID: sibling.id,
          providerCallID: crypto.randomUUID(),
          requestID: crypto.randomUUID(),
          model: "gpt-live-1",
        })
      ).json(),
    )
    expect((await request("DELETE", `/session/${parent.id}`)).status).toBe(200)
    expect((await request("GET", `/session/${parent.id}`)).status).toBe(404)
    expect((await request("POST", duration, meter)).status).toBe(404)
    expect((await request("POST", calls, context(binding.generation, "dlg_4", 3))).status).toBe(404)
    expect((await request("DELETE", `${openai}/${other.id}?generation=${other.generation}`)).status).toBe(200)
    const kept = { id: "evt_duration_2", model: "gpt-live-1" as const, seconds: 1 }
    const late = await request("POST", `${live}/${other.id}/duration`, {
      generation: other.generation,
      receipt: kept,
    })
    expect(late.status).toBe(200)
    const retained = Schema.decodeUnknownSync(LiveDuration)(await late.json())
    expect(retained).toEqual(kept)
    expect(JSON.stringify(retained)).not.toContain(key)
  } finally {
    await app.dispose()
    await disposeAllInstances()
    await resetDatabase()
  }
}, 60_000)
