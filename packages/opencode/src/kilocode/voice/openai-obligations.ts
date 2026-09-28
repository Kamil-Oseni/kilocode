import { Schema } from "effect"
import { MessageID, SessionID } from "@/session/schema"
import { OpenAICall } from "./openai-protocol"

const ID = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/),
  Schema.makeFilter((value) => value.trim() === value),
)
const Hash = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
  Schema.makeFilter((value) => value.trim() === value),
)
const Provider = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^\S+$/),
  Schema.makeFilter((value) => value.trim() === value),
)
const Epoch = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const Reference = Schema.Struct({
  version: Schema.Literal(1),
  id: ID,
  originID: ID,
  originGeneration: ID,
  callID: ID,
  receiptID: ID,
  messageID: MessageID,
  parentSessionID: SessionID,
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32768)),
  createdAt: Time,
  deadline: Schema.optional(Time),
})
export const OfferInput = Schema.Struct({
  version: Schema.Literal(1),
  generation: ID,
  offerID: ID,
  providerCallID: Provider,
  itemID: ID,
  responseID: Schema.optional(ID),
  resultHash: Hash,
  deliveryEpoch: Epoch,
})
export const Offer = Schema.Struct({
  version: Schema.Literal(1),
  offerID: ID,
  targetID: ID,
  targetGeneration: ID,
  providerCallID: Provider,
  itemID: ID,
  responseID: Schema.optional(ID),
  resultHash: Hash,
  deliveryEpoch: Epoch,
  offeredAt: Time,
})
export const AckInput = Schema.Struct({
  version: Schema.Literal(1),
  generation: ID,
  ackID: ID,
  offerID: ID,
  phase: Schema.Literals(["accepted", "generated", "played", "omitted"]),
  eventID: ID,
  providerCallID: Provider,
  itemID: ID,
  responseID: Schema.optional(ID),
  resultHash: Hash,
  deliveryEpoch: Epoch,
})
export const DeliveryInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("offer"), ...OfferInput.fields }),
  Schema.Struct({ action: Schema.Literal("ack"), ...AckInput.fields }),
])
export const AckReceipt = Schema.Struct({
  ...AckInput.fields,
  targetID: ID,
  reference: Reference,
  acknowledgedAt: Time,
})
export const Delivery = Schema.Struct({
  version: Schema.Literal(1),
  reference: Reference,
  epoch: Epoch,
  phase: Schema.Literals(["pending", "offered", "accepted", "generated", "played", "omitted"]),
  offer: Schema.optional(Offer),
  acks: Schema.Array(AckReceipt).check(Schema.isMaxLength(16)),
}).check(
  Schema.makeFilter((value) => {
    if ((value.phase === "pending") !== (value.offer === undefined)) return "Delivery offer does not match its phase"
    if (
      (value.phase === "pending" && value.epoch !== 0) ||
      (value.offer && (value.epoch !== value.offer.deliveryEpoch || value.epoch < 1))
    )
      return "Delivery epoch does not match its offer"
    if (value.phase === "pending" && value.acks.length) return "Pending delivery cannot have acknowledgements"
    const phases = value.acks.map((ack) => ack.phase)
    if (value.phase === "offered" && phases.length) return "Offered delivery cannot have acknowledgements"
    if (
      phases.length > 3 ||
      (phases.length === 1 && phases[0] !== "accepted" && phases[0] !== "omitted") ||
      (phases.length >= 2 && (phases[0] !== "accepted" || (phases[1] !== "generated" && phases[1] !== "omitted"))) ||
      (phases.length === 3 && (phases[1] !== "generated" || (phases[2] !== "played" && phases[2] !== "omitted")))
    )
      return "Delivery acknowledgements must advance monotonically"
    if (new Set(value.acks.map((ack) => ack.ackID)).size !== value.acks.length)
      return "Delivery acknowledgement identities repeat"
    const generated = value.acks.find((ack) => ack.phase === "generated")
    if (
      generated &&
      (!generated.responseID || (value.offer?.responseID && generated.responseID !== value.offer.responseID))
    )
      return "Generated delivery requires an exact response identity"
    if (
      value.acks.some(
        (ack) =>
          !value.offer ||
          ack.deliveryEpoch !== value.epoch ||
          ack.offerID !== value.offer.offerID ||
          ack.targetID !== value.offer.targetID ||
          ack.generation !== value.offer.targetGeneration ||
          ack.providerCallID !== value.offer.providerCallID ||
          ack.itemID !== value.offer.itemID ||
          ack.responseID !==
            (ack.phase === "generated" || ack.phase === "played" || (ack.phase === "omitted" && generated)
              ? generated?.responseID
              : value.offer.responseID) ||
          ack.resultHash !== value.offer.resultHash ||
          JSON.stringify(ack.reference) !== JSON.stringify(value.reference),
      )
    )
      return "Delivery acknowledgements must match their offer"
    if (value.phase !== "pending" && value.phase !== "offered" && value.acks.at(-1)?.phase !== value.phase)
      return "Delivery phase must match its last acknowledgement"
    return undefined
  }),
)
export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  manifestID: ID,
  hash: Hash,
  sourceID: ID,
  sourceGeneration: ID,
  candidateID: ID,
  candidateGeneration: ID,
  references: Schema.Array(Reference).check(Schema.isMaxLength(64)),
})
export const Registry = Schema.Struct({
  version: Schema.Literal(1),
  references: Schema.Array(Reference).check(Schema.isMaxLength(64)),
})
export const TransferReceipt = Schema.Struct({
  version: Schema.Literal(1),
  manifest: Manifest,
  activation: Schema.Struct({
    version: Schema.Literal(1),
    requestID: ID,
    sourceID: ID,
    sourceGeneration: ID,
    candidateID: ID,
    candidateGeneration: ID,
    readyID: ID,
    sourceRevision: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    sourceHash: Hash,
    activatedAt: Time,
  }),
})
export const OfferReceipt = Schema.Struct({ version: Schema.Literal(1), reference: Reference, offer: Offer })
export const DeliveryReceipt = Schema.Union([OfferReceipt, AckReceipt])
export const Observation = Schema.Struct({
  version: Schema.Literal(1),
  reference: Reference,
  delivery: Delivery,
  receipt: OpenAICall,
  resultHash: Schema.optional(Hash),
})

/** Privileged payloads and private records reject stripped fields and string coercion. */
export function strict<S extends Schema.Top>(schema: S, input: unknown): input is S["Type"] {
  if (!Schema.is(schema)(input)) return false
  if (!input || typeof input !== "object" || Array.isArray(input)) return true
  const fields = "fields" in schema ? schema.fields : undefined
  if (!fields || typeof fields !== "object") return false
  return Object.keys(input).every((key) => Object.hasOwn(fields, key))
}

export function validDelivery(input: unknown): input is typeof Delivery.Type {
  return (
    strict(Delivery, input) &&
    strict(Reference, input.reference) &&
    (!input.offer || strict(Offer, input.offer)) &&
    input.acks.every((ack) => strict(AckReceipt, ack) && strict(Reference, ack.reference))
  )
}

export function validInput(input: unknown): input is typeof DeliveryInput.Type {
  return DeliveryInput.members.some((schema) => strict(schema, input))
}

export function validTransfer(input: unknown): input is typeof TransferReceipt.Type {
  return (
    strict(TransferReceipt, input) &&
    strict(Manifest, input.manifest) &&
    input.manifest.references.every((reference) => strict(Reference, reference)) &&
    strict(TransferReceipt.fields.activation, input.activation) &&
    input.manifest.sourceID === input.activation.sourceID &&
    input.manifest.sourceGeneration === input.activation.sourceGeneration &&
    input.manifest.candidateID === input.activation.candidateID &&
    input.manifest.candidateGeneration === input.activation.candidateGeneration
  )
}
