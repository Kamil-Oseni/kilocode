import { expect, test } from "bun:test"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"
import { OpenAIBinding, OpenAIImage, OpenAIReservation } from "@/kilocode/voice/openai-protocol"
import { SessionID } from "@/session/schema"
import path from "node:path"
import { mkdir, writeFile, rm, access } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { RayaGoal } from "@/kilocode/goal"

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
    expect(
      (
        await request("POST", `/session/${parent.id}/goal`, {
          objective: "Account for every Realtime response",
          budget: { chargeCosts: [{ currency: "USD", limit: 1, reservation: 0.6 }] },
        })
      ).status,
    ).toBe(200)
    const input = { parentSessionID: parent.id, providerCallID: crypto.randomUUID(), requestID: crypto.randomUUID() }
    const base = "/kilocode/voice/openai/session"
    const preflight = "/kilocode/voice/openai/reservation"
    const reserve = { parentSessionID: parent.id, requestID: input.requestID, model: "gpt-realtime-2.1" }
    expect((await request("POST", base, input, key, "")).status).toBe(401)
    expect(
      (await request("POST", base, input, key, `Basic ${Buffer.from("voice-test:wrong").toString("base64")}`)).status,
    ).toBe(401)
    expect((await request("POST", base, input, "")).status).toBe(401)
    expect((await request("POST", base, input)).status).toBe(409)
    expect((await request("POST", preflight, reserve, key, "")).status).toBe(401)
    expect((await request("POST", preflight, reserve, "")).status).toBe(401)
    const reserved = await request("POST", preflight, reserve)
    expect(reserved.status).toBe(200)
    expect(Schema.decodeUnknownSync(OpenAIReservation)(await reserved.json())).toEqual({
      requestID: input.requestID,
      model: "gpt-realtime-2.1",
      status: "reserved",
      amount: 0.6,
      currency: "USD",
    })
    expect((await request("POST", preflight, { ...reserve, model: "gpt-live-1" })).status).toBe(409)
    const started = await request("POST", base, input)
    expect(started.status).toBe(200)
    const binding = Schema.decodeUnknownSync(OpenAIBinding)(await started.json())
    expect(binding.parentSessionID).toBe(parent.id)
    expect(binding.model).toBe("gpt-realtime-2.1")
    expect(JSON.stringify(binding)).not.toContain(key)
    const rejected = { parentSessionID: parent.id, requestID: crypto.randomUUID(), model: "gpt-realtime-2.1" }
    expect((await request("POST", preflight, rejected)).status).toBe(200)
    const released = await request("POST", `${preflight}/release`, rejected)
    expect(released.status).toBe(200)
    expect(Schema.decodeUnknownSync(OpenAIReservation)(await released.json()).status).toBe("released")
    expect((await request("POST", `${preflight}/release`, rejected)).status).toBe(200)
    expect(
      (
        await request("POST", base, {
          parentSessionID: parent.id,
          providerCallID: crypto.randomUUID(),
          requestID: rejected.requestID,
        })
      ).status,
    ).toBe(409)
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
    const responseReserve = {
      parentSessionID: parent.id,
      requestID: "response_budget_1",
      model: "gpt-realtime-2.1" as const,
    }
    expect((await request("POST", preflight, responseReserve)).status).toBe(200)
    const rivalResponse = { ...responseReserve, requestID: "response_budget_rival" }
    expect((await request("POST", preflight, rivalResponse)).status).toBe(409)
    const usage = {
      generation: binding.generation,
      receipt: {
        id: "response_1",
        kind: "response",
        model: "gpt-realtime-2.1",
        status: "reported",
        tokens: {
          input: 4,
          output: 2,
          total: 6,
          cached: 0,
          inputText: 4,
          inputAudio: 0,
          inputImage: 0,
          cachedText: 0,
          cachedAudio: 0,
          cachedImage: 0,
          outputText: 2,
          outputAudio: 0,
        },
      },
      reservationID: responseReserve.requestID,
    }
    expect((await request("POST", `${route}/usage`, usage, key, "")).status).toBe(401)
    expect((await request("POST", `${route}/usage`, usage, "b".repeat(64))).status).toBe(401)
    expect((await request("POST", `${route}/usage`, { ...usage, generation: "stale" })).status).toBe(409)
    expect((await request("POST", `${route}/usage`, usage)).status).toBe(200)
    expect((await request("POST", `${route}/usage`, usage)).status).toBe(200)
    expect((await request("POST", preflight, rivalResponse)).status).toBe(200)
    expect((await request("POST", `${preflight}/release`, rivalResponse)).status).toBe(200)
    expect(
      (
        await request("POST", `${route}/usage`, {
          ...usage,
          reservationID: "response_budget_changed",
        })
      ).status,
    ).toBe(409)
    expect(
      (await request("GET", `${route}/usage?generation=${binding.generation}`, undefined, "b".repeat(64))).status,
    ).toBe(401)
    expect(await (await request("GET", `${route}/usage?generation=${binding.generation}`)).json()).toEqual({
      receipts: [usage.receipt],
    })
    const goal = Schema.decodeUnknownSync(RayaGoal.State)(
      await (await request("GET", `/session/${parent.id}/goal`)).json(),
    )
    expect(goal.charges).toEqual([
      {
        id: `openai-voice:${binding.id}:response:response_1`,
        kind: "gpt-live",
        provider: "OpenAI",
        service: "gpt-realtime-2.1",
        source: "openai-model-doc:2026-09-14",
        origin: { sessionID: parent.id, callID: binding.id },
        at: binding.createdAt,
        quantity: 6,
        unit: "tokens",
        coverage: "recorded",
        amount: 0.000064,
        currency: "USD",
      },
    ])
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
    const sibling = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(
      await (await request("POST", "/session", {})).json(),
    )
    const separateInput = {
      parentSessionID: sibling.id,
      providerCallID: crypto.randomUUID(),
      requestID: crypto.randomUUID(),
    }
    expect(
      (
        await request("POST", preflight, {
          parentSessionID: sibling.id,
          requestID: separateInput.requestID,
          model: "gpt-realtime-2.1",
        })
      ).status,
    ).toBe(200)
    const separate = Schema.decodeUnknownSync(OpenAIBinding)(await (await request("POST", base, separateInput)).json())
    const activeInput = {
      ...input,
      providerCallID: crypto.randomUUID(),
      requestID: crypto.randomUUID(),
    }
    const activeReserve = {
      parentSessionID: parent.id,
      requestID: activeInput.requestID,
      model: "gpt-realtime-2.1",
    }
    expect((await request("POST", preflight, activeReserve)).status).toBe(200)
    const active = Schema.decodeUnknownSync(OpenAIBinding)(await (await request("POST", base, activeInput)).json())
    const legacy = path.join(Global.Path.data, "storage", "raya_openai_voice")
    const owned = path.join(legacy, `legacy_${binding.id}.json`)
    const unrelated = path.join(legacy, `legacy_${separate.id}.json`)
    const corrupt = path.join(legacy, "corrupt_retention_test.json")
    await mkdir(legacy, { recursive: true })
    await writeFile(owned, JSON.stringify({ binding, images: { private: image.data } }))
    await writeFile(unrelated, JSON.stringify({ binding: separate }))
    await writeFile(corrupt, "invalid JSON")
    try {
      expect((await request("DELETE", `/session/${parent.id}`)).status).toBe(500)
      expect((await request("GET", `/session/${parent.id}`)).status).toBe(200)
      await rm(corrupt)
      expect((await request("DELETE", `/session/${parent.id}`)).status).toBe(200)
      expect((await request("GET", `/session/${parent.id}`)).status).toBe(404)
      expect((await request("GET", `${route}/usage?generation=${binding.generation}`)).status).toBe(404)
      expect((await request("POST", `${route}/usage`, usage)).status).toBe(404)
      expect((await request("POST", `${route}/images`, image)).status).toBe(404)
      expect((await request("POST", `${route}/calls`, call)).status).toBe(404)
      expect((await request("DELETE", `${base}/${active.id}?generation=${active.generation}`)).status).toBe(404)
      expect(
        await access(owned).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      expect(
        await access(unrelated).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
      expect((await request("GET", `${base}/${separate.id}/usage?generation=${separate.generation}`)).status).toBe(200)
      expect((await request("DELETE", `/session/${sibling.id}`)).status).toBe(200)
      expect(
        await access(unrelated).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await Promise.all([owned, unrelated, corrupt].map((file) => rm(file, { force: true })))
    }
  } finally {
    await app.dispose()
    await disposeAllInstances()
    await resetDatabase()
  }
}, 60_000)
