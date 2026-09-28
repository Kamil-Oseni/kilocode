import { expect, test } from "bun:test"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import * as Obligations from "@/kilocode/voice/openai-obligations"
import {
  OpenAIBinding,
  OpenAIHandoffContext,
  OpenAIHandoffReceipt,
  OpenAIHandoffRearmReceipt,
} from "@/kilocode/voice/openai-protocol"
import { SessionID } from "@/session/schema"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

test.each([false, true])(
  "handoff HTTP routes separate capabilities and reject stripped fields (retained=%s)",
  async (retained) => {
    await using dir = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const app = HttpRouter.toWebHandler(
      HttpApiServer.routes.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              KILO_SERVER_PASSWORD: "handoff-password",
              KILO_SERVER_USERNAME: "handoff-test",
              KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
            }),
          ),
        ),
      ),
      { disableLogger: true },
    )
    const auth = `Basic ${Buffer.from("handoff-test:handoff-password").toString("base64")}`
    const key = "a".repeat(64)
    const target = "b".repeat(64)
    const base = "/kilocode/voice/openai/session"
    const request = (
      method: string,
      route: string,
      body?: unknown,
      secret = key,
      destination?: string,
      authorization = auth,
    ) =>
      app.handler(
        new Request(`http://localhost${route}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-kilo-directory": dir.path,
            ...(authorization ? { authorization } : {}),
            ...(secret ? { "x-raya-voice-key": secret } : {}),
            ...(destination ? { "x-raya-voice-target-key": destination } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        HttpApiServer.context,
      )
    try {
      const parent = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(
        await (await request("POST", "/session", {})).json(),
      )
      const input = { parentSessionID: parent.id, providerCallID: "source-provider", requestID: "source-reservation" }
      expect(
        (
          await request("POST", "/kilocode/voice/openai/reservation", {
            parentSessionID: parent.id,
            requestID: input.requestID,
            model: "gpt-realtime-2.1",
          })
        ).status,
      ).toBe(200)
      const source = Schema.decodeUnknownSync(OpenAIBinding)(await (await request("POST", base, input)).json())
      const preparing = {
        version: 1,
        generation: source.generation,
        requestID: "handoff-request",
        providerCallID: "target-provider",
        reservationID: "target-reservation",
      }
      const path = `${base}/${source.id}/handoff/candidate`
      expect(
        (
          await request(
            "POST",
            "/kilocode/voice/openai/reservation",
            { parentSessionID: parent.id, requestID: preparing.reservationID, model: "gpt-realtime-2.1" },
            target,
          )
        ).status,
      ).toBe(200)
      expect((await request("POST", path, preparing, key, target, "")).status).toBe(401)
      expect((await request("POST", path, preparing, target, key)).status).toBe(401)
      expect((await request("POST", path, preparing, key, key)).status).toBe(401)
      for (const invalid of [
        { ...preparing, version: 2 },
        { ...preparing, phase: "active" },
        { ...preparing, requestID: "bad\n" },
      ])
        expect((await request("POST", path, invalid, key, target)).status).toBe(400)
      const response = await request("POST", path, preparing, key, target)
      expect(response.status).toBe(200)
      const candidate = Schema.decodeUnknownSync(OpenAIBinding)(await response.json())
      expect(candidate.status).toBe("active")
      expect(candidate.handoff?.phase).toBe("candidate")
      expect(await (await request("POST", path, preparing, key, target)).json()).toEqual(candidate)
      const context = `${base}/${candidate.id}/handoff/context?generation=${candidate.generation}`
      expect((await request("GET", context)).status).toBe(401)
      const checkpoint = Schema.decodeUnknownSync(OpenAIHandoffContext)(
        await (await request("GET", context, undefined, target)).json(),
      )
      const ready = {
        version: 1,
        generation: candidate.generation,
        readyID: "prefill-ack",
        sourceRevision: checkpoint.sourceRevision,
        sourceHash: checkpoint.sourceHash,
      }
      expect(
        (
          await request(
            "POST",
            `${base}/${candidate.id}/handoff/ready`,
            { ...ready, deadline: Date.now() + 999999 },
            target,
          )
        ).status,
      ).toBe(400)
      expect((await request("POST", `${base}/${candidate.id}/handoff/ready`, ready, target)).status).toBe(200)
      const rearm = { ...ready, priorReadyID: ready.readyID, readyID: "prefill-second" }
      const rearming = `${base}/${candidate.id}/handoff/rearm`
      expect((await request("POST", rearming, rearm)).status).toBe(401)
      for (const invalid of [
        { ...rearm, version: 2 },
        { ...rearm, deadline: 99 },
        { ...rearm, priorReadyID: "bad\n" },
      ])
        expect((await request("POST", rearming, invalid, target)).status).toBe(400)
      const rearmed = await request("POST", rearming, rearm, target)
      expect(rearmed.status).toBe(200)
      const confirmation = Schema.decodeUnknownSync(OpenAIHandoffRearmReceipt)(await rearmed.json())
      expect(await (await request("POST", rearming, rearm, target)).json()).toEqual(confirmation)
      expect((await request("POST", rearming, { ...rearm, sourceRevision: 1 }, target)).status).toBe(409)
      expect(
        (
          await request(
            "POST",
            `${base}/${candidate.id}/calls`,
            {
              generation: candidate.generation,
              callID: "premature",
              function: "raya_work",
              arguments: { request: "Never execute" },
            },
            target,
          )
        ).status,
      ).toBe(409)
      const activate = {
        ...ready,
        readyID: rearm.readyID,
        generation: source.generation,
        requestID: preparing.requestID,
        candidateID: candidate.id,
        candidateGeneration: candidate.generation,
      }
      const manifesting = `${base}/${candidate.id}/handoff/obligations?generation=${candidate.generation}`
      expect((await request("GET", manifesting)).status).toBe(401)
      const manifest = Schema.decodeUnknownSync(Obligations.Manifest)(
        await (await request("GET", manifesting, undefined, target)).json(),
      )
      expect(manifest.references).toEqual([])
      expect(await (await request("GET", manifesting, undefined, target)).json()).toEqual(manifest)
      const transfer = { ...activate, manifestID: manifest.manifestID, manifestHash: manifest.hash }
      const transferring = `${base}/${source.id}/handoff/activate-retained`
      expect((await request("POST", transferring, transfer, target)).status).toBe(401)
      for (const invalid of [
        { ...transfer, version: 2 },
        { ...transfer, owner: "caller" },
        { ...transfer, manifestID: "bad\n" },
      ])
        expect((await request("POST", transferring, invalid)).status).toBe(400)
      expect((await request("POST", transferring, { ...transfer, manifestHash: "f".repeat(64) })).status).toBe(409)
      const route = retained ? transferring : `${base}/${source.id}/handoff/activate`
      const payload = retained ? transfer : activate
      const activated = await request("POST", route, payload)
      expect(activated.status).toBe(200)
      const value = await activated.json()
      const proof = retained
        ? Schema.decodeUnknownSync(Obligations.TransferReceipt)(value)
        : Schema.decodeUnknownSync(OpenAIHandoffReceipt)(value)
      const receipt = "activation" in proof ? proof.activation : proof
      expect(await (await request("POST", route, payload)).json()).toEqual(proof)
      expect(
        await (await request("GET", `${base}/${source.id}/handoff/receipt?generation=${source.generation}`)).json(),
      ).toEqual(receipt)
      if (retained) {
        const recorded = `${base}/${source.id}/handoff/retained-receipt?generation=${source.generation}`
        expect((await request("GET", recorded, undefined, target)).status).toBe(401)
        expect(await (await request("GET", recorded)).json()).toEqual(proof)
        expect((await request("POST", transferring, { ...transfer, manifestID: "different" })).status).toBe(409)
      }
      const obligation = `${base}/${candidate.id}/obligations/missing`
      const registry = `${base}/${candidate.id}/obligations?generation=${candidate.generation}`
      expect((await request("GET", registry)).status).toBe(401)
      expect(
        Schema.decodeUnknownSync(Obligations.Registry)(await (await request("GET", registry, undefined, target)).json())
          .references,
      ).toEqual([])
      expect((await request("GET", `${obligation}?generation=${candidate.generation}`, undefined, target)).status).toBe(
        404,
      )
      const offer = {
        action: "offer",
        version: 1,
        generation: candidate.generation,
        offerID: "presentation",
        providerCallID: preparing.providerCallID,
        itemID: "result-item",
        resultHash: "a".repeat(64),
        deliveryEpoch: 1,
      }
      expect((await request("POST", `${obligation}/delivery`, { ...offer, execution: "caller" }, target)).status).toBe(
        400,
      )
      expect((await request("POST", `${obligation}/delivery`, offer, target)).status).toBe(404)
      expect(
        (await request("POST", `${obligation}/cancel`, { generation: candidate.generation, all: true }, target)).status,
      ).toBe(400)
      expect((await request("POST", `${obligation}/cancel`, { generation: candidate.generation }, target)).status).toBe(
        404,
      )
      expect(
        (
          await request("POST", `${base}/${source.id}/calls`, {
            generation: source.generation,
            callID: "retired",
            function: "raya_work",
            arguments: { request: "Never execute" },
          })
        ).status,
      ).toBe(409)
      expect((await request("DELETE", `${base}/${source.id}?generation=${source.generation}`)).status).toBe(200)
      expect(
        await (await request("GET", `${base}/${source.id}/handoff/receipt?generation=${source.generation}`)).json(),
      ).toEqual(receipt)
      const messages = await request("GET", `/session/${parent.id}/message`)
      expect(messages.status).toBe(200)
      expect(await messages.json()).toEqual([])
    } finally {
      await app.dispose()
      await disposeAllInstances()
      resetDatabase()
    }
  },
  60_000,
)
