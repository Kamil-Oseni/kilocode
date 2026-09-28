import { http } from "../../server/httpapi-exercise/dsl"
import type { Scenario } from "../../server/httpapi-exercise/types"

const root = "/kilocode/voice/openai/session/{id}"

export const obligations: Scenario[] = [
  ...["obligations", "handoff/obligations", "handoff/retained-receipt", "obligations/{obligationID}"].map((path) =>
    http.protected
      .get(`${root}/${path}`, `voice.retained.${path}`)
      .at((ctx) => ({
        path: `${root}/${path}`.replace("{id}", "missing").replace("{obligationID}", "missing") + "?generation=missing",
        headers: ctx.headers(),
      }))
      .status(401),
  ),
  http.protected
    .post(`${root}/handoff/activate-retained`, "voice.retained.activate")
    .at((ctx) => ({
      path: `${root}/handoff/activate-retained`.replace("{id}", "missing"),
      headers: ctx.headers(),
      body: {
        version: 1,
        generation: "missing",
        requestID: "request_missing",
        candidateID: "candidate_missing",
        candidateGeneration: "generation_missing",
        readyID: "ready_missing",
        sourceRevision: 0,
        sourceHash: "a".repeat(64),
        manifestID: "manifest_missing",
        manifestHash: "a".repeat(64),
      },
    }))
    .status(401),
  http.protected
    .post(`${root}/obligations/{obligationID}/delivery`, "voice.retained.delivery")
    .at((ctx) => ({
      path: `${root}/obligations/missing/delivery`.replace("{id}", "missing"),
      headers: ctx.headers(),
      body: {
        action: "offer",
        version: 1,
        generation: "missing",
        offerID: "offer_missing",
        providerCallID: "provider_missing",
        itemID: "item_missing",
        resultHash: "a".repeat(64),
        deliveryEpoch: 1,
      },
    }))
    .status(401),
  http.protected
    .post(`${root}/obligations/{obligationID}/cancel`, "voice.retained.cancel")
    .at((ctx) => ({
      path: `${root}/obligations/missing/cancel`.replace("{id}", "missing"),
      headers: ctx.headers(),
      body: { generation: "missing" },
    }))
    .status(401),
]
