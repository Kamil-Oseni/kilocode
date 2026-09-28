import { expect, test } from "bun:test"
import * as Obligations from "../../src/speech/openai-obligation"

const ref = {
  version: 1 as const,
  id: "obligation",
  originID: "source",
  originGeneration: "generation",
  callID: "call",
  receiptID: "receipt",
  messageID: "msg_original",
  parentSessionID: "ses_original",
  directory: "C:\\private",
  createdAt: 100,
}
const receipt = {
  id: ref.receiptID,
  callID: ref.callID,
  messageID: ref.messageID,
  parentSessionID: ref.parentSessionID,
  createdAt: 100,
  updatedAt: 200,
  status: "completed" as const,
  result: { text: "Done", assistantMessageID: "msg_result", evidence: [] },
}
const digest = "a".repeat(64)
const offer = {
  version: 1 as const,
  offerID: "offer",
  targetID: "target",
  targetGeneration: "new_generation",
  providerCallID: "provider",
  itemID: "item",
  resultHash: digest,
  deliveryEpoch: 1,
  offeredAt: 200,
}
const accepted = {
  version: 1 as const,
  generation: offer.targetGeneration,
  ackID: "ack",
  offerID: offer.offerID,
  phase: "accepted" as const,
  eventID: "event",
  providerCallID: offer.providerCallID,
  itemID: offer.itemID,
  resultHash: digest,
  deliveryEpoch: 1,
  targetID: offer.targetID,
  reference: ref,
  acknowledgedAt: 201,
}
const observation = {
  version: 1,
  reference: ref,
  delivery: { version: 1, reference: ref, epoch: 0, phase: "pending", acks: [] },
  receipt,
  resultHash: digest,
}

test("registry rejects overflow, duplicate references and private extra fields", () => {
  expect(Obligations.registry({ version: 1, references: [ref] })).toEqual([ref])
  expect(() => Obligations.registry({ version: 1, references: [ref, ref] })).toThrow()
  expect(() =>
    Obligations.registry({
      version: 1,
      references: Array.from({ length: 65 }, (_, index) => ({ ...ref, id: `ref_${index}` })),
    }),
  ).toThrow()
  expect(() => Obligations.registry({ version: 1, references: [{ ...ref, secret: "hidden" }] })).toThrow()
  expect(() => Obligations.registry({ version: 1, references: [{ ...ref, id: "obligation\n" }] })).toThrow()
})

test("observation binds original admission and canonical hash without model-text hashing", () => {
  expect(Obligations.observation(observation, ref).resultHash).toBe(digest)
  expect(() =>
    Obligations.observation({ ...observation, receipt: { ...receipt, messageID: "msg_changed" } }, ref),
  ).toThrow()
  expect(() =>
    Obligations.observation({ ...observation, reference: { ...ref, originGeneration: "changed" } }, ref),
  ).toThrow()
  expect(() => Obligations.observation({ ...observation, resultHash: undefined }, ref)).toThrow()
  expect(() => Obligations.observation({ ...observation, reference: { ...ref, deadline: 900 } }, ref)).toThrow()
  expect(() => Obligations.observation({ ...observation, receipt: { ...receipt, status: "running" } }, ref)).toThrow()
})

test("delivery history refuses changed targets, out-of-order acknowledgements and inferred playback", () => {
  const value = {
    ...observation,
    delivery: { version: 1, reference: ref, epoch: 1, phase: "accepted", offer, acks: [accepted] },
  }
  expect(Obligations.observation(value, ref).delivery.phase).toBe("accepted")
  expect(() =>
    Obligations.observation(
      { ...value, delivery: { ...value.delivery, acks: [{ ...accepted, targetID: "other" }] } },
      ref,
    ),
  ).toThrow()
  expect(() =>
    Obligations.observation(
      { ...value, delivery: { ...value.delivery, phase: "generated", acks: [{ ...accepted, phase: "generated" }] } },
      ref,
    ),
  ).toThrow()
  expect(() =>
    Obligations.observation(
      {
        ...value,
        delivery: {
          ...value.delivery,
          phase: "played",
          acks: [accepted, { ...accepted, ackID: "played", phase: "played", responseID: "response" }],
        },
      },
      ref,
    ),
  ).toThrow()
  const generated = { ...accepted, ackID: "generated", phase: "generated", responseID: "response" }
  expect(
    Obligations.observation(
      { ...value, delivery: { ...value.delivery, phase: "generated", acks: [accepted, generated] } },
      ref,
    ).delivery.phase,
  ).toBe("generated")
  expect(() =>
    Obligations.observation(
      {
        ...value,
        delivery: { ...value.delivery, phase: "generated", acks: [accepted, { ...generated, responseID: undefined }] },
      },
      ref,
    ),
  ).toThrow()
})

test("offer and acknowledgement echo all submitted presentation identities", () => {
  const body = {
    action: "offer",
    version: 1,
    generation: offer.targetGeneration,
    offerID: offer.offerID,
    providerCallID: offer.providerCallID,
    itemID: offer.itemID,
    resultHash: digest,
    deliveryEpoch: 1,
  }
  expect(Obligations.offer({ version: 1, reference: ref, offer }, ref, body, "target").offer.targetID).toBe("target")
  expect(() => Obligations.offer({ version: 1, reference: ref, offer }, ref, body, "other")).toThrow()
  expect(() =>
    Obligations.offer(
      { version: 1, reference: ref, offer: { ...offer, responseID: "unexpected" } },
      ref,
      body,
      "target",
    ),
  ).toThrow()
  expect(() =>
    Obligations.offer(
      { version: 1, reference: ref, offer: { ...offer, providerCallID: "provider\n" } },
      ref,
      body,
      "target",
    ),
  ).toThrow()
  expect(() =>
    Obligations.offer(
      { version: 1, reference: ref, offer: { ...offer, resultHash: "b".repeat(64) } },
      ref,
      body,
      "target",
    ),
  ).toThrow()
  const { reference: _reference, targetID: _target, acknowledgedAt: _time, ...fields } = accepted
  expect(Obligations.acknowledgement(accepted, ref, { action: "ack", ...fields }, "target").eventID).toBe("event")
  expect(() =>
    Obligations.acknowledgement({ ...accepted, eventID: "wrong" }, ref, { action: "ack", ...fields }, "target"),
  ).toThrow()
})

test("transfer receipt rejects mismatched authority and duplicate manifests", () => {
  const manifest = {
    version: 1,
    manifestID: "manifest",
    hash: digest,
    sourceID: "source",
    sourceGeneration: "generation",
    candidateID: "target",
    candidateGeneration: "new_generation",
    references: [ref],
  }
  const activation = {
    version: 1,
    requestID: "request",
    sourceID: "source",
    sourceGeneration: "generation",
    candidateID: "target",
    candidateGeneration: "new_generation",
    readyID: "ready",
    sourceRevision: 1,
    sourceHash: digest,
    activatedAt: 200,
  }
  expect(Obligations.transfer({ version: 1, manifest, activation }).manifest.references).toEqual([ref])
  expect(() =>
    Obligations.transfer({ version: 1, manifest, activation: { ...activation, candidateGeneration: "wrong" } }),
  ).toThrow()
  expect(() => Obligations.manifest({ ...manifest, references: [ref, ref] })).toThrow()
})

test("model envelope excludes provenance and stays within UTF8 budget without splitting Unicode", () => {
  const text = "🎻".repeat(6000)
  const output = Obligations.envelope({ ...receipt, result: { ...receipt.result, text } })
  expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(16384)
  const value = JSON.parse(output)
  expect(value.truncated).toBe(true)
  expect(text.startsWith(value.text)).toBe(true)
  expect(value.text).not.toContain("\ufffd")
  expect(Object.keys(value)).toEqual(["status", "text", "truncated", "note"])
  expect(output).not.toContain("msg_original")
  expect(output).not.toContain("C:\\private")
  expect(JSON.parse(Obligations.envelope(receipt))).toEqual({ status: "completed", text: "Done" })
  expect(() => Obligations.envelope({ ...receipt, secret: "credential" })).toThrow()
})
