import { z } from "zod"

const id = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,128}$/)
  .refine((value) => value.trim() === value)
const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .refine((value) => value.trim() === value)
const time = z.number().finite().nonnegative()
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const provider = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S+$/)
  .refine((value) => value.trim() === value)
const reference = z
  .object({
    version: z.literal(1),
    id,
    originID: id,
    originGeneration: id,
    callID: id,
    receiptID: id,
    messageID: z.string().startsWith("msg"),
    parentSessionID: z.string().startsWith("ses"),
    directory: z.string().min(1).max(32768),
    createdAt: time,
    deadline: time.optional(),
  })
  .strict()
const proposal = z
  .object({
    version: z.literal(1),
    offerID: id,
    targetID: id,
    targetGeneration: id,
    providerCallID: provider,
    itemID: id,
    responseID: id.optional(),
    resultHash: hash,
    deliveryEpoch: epoch,
    offeredAt: time,
  })
  .strict()
const ack = z
  .object({
    version: z.literal(1),
    generation: id,
    ackID: id,
    offerID: id,
    phase: z.enum(["accepted", "generated", "played", "omitted"]),
    eventID: id,
    providerCallID: provider,
    itemID: id,
    responseID: id.optional(),
    resultHash: hash,
    deliveryEpoch: epoch,
    targetID: id,
    reference,
    acknowledgedAt: time,
  })
  .strict()
const list = z
  .array(reference)
  .max(64)
  .refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length)
const manifestSchema = z
  .object({
    version: z.literal(1),
    manifestID: id,
    hash,
    sourceID: id,
    sourceGeneration: id,
    candidateID: id,
    candidateGeneration: id,
    references: list,
  })
  .strict()
  .refine((value) => value.sourceID !== value.candidateID && value.sourceGeneration !== value.candidateGeneration)
const call = z
  .object({
    id,
    callID: id,
    messageID: z.string().startsWith("msg"),
    parentSessionID: z.string().startsWith("ses"),
    status: z.enum(["accepted", "running", "completed", "failed", "cancelled", "unknown"]),
    createdAt: time,
    updatedAt: time,
    images: z
      .array(
        z
          .object({
            id,
            mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
            bytes: z.number().int().min(1).max(262144),
            sha256: hash,
          })
          .strict(),
      )
      .max(4)
      .optional(),
    result: z
      .object({
        text: z.string().max(12000),
        assistantMessageID: z.string().startsWith("msg"),
        evidence: z
          .array(
            z
              .object({
                messageID: z.string().startsWith("msg"),
                partID: z.string().startsWith("prt"),
                tool: z.string().max(128),
                status: z.enum(["pending", "running", "completed", "error"]),
              })
              .strict(),
          )
          .max(64),
      })
      .strict()
      .optional(),
    error: z
      .object({ code: z.string().max(64), message: z.string().max(500) })
      .strict()
      .optional(),
  })
  .strict()
const delivery = z
  .object({
    version: z.literal(1),
    reference,
    epoch,
    phase: z.enum(["pending", "offered", "accepted", "generated", "played", "omitted"]),
    offer: proposal.optional(),
    acks: z.array(ack).max(3),
  })
  .strict()
const observationSchema = z
  .object({ version: z.literal(1), reference, delivery, receipt: call, resultHash: hash.optional() })
  .strict()
const offerSchema = z.object({ version: z.literal(1), reference, offer: proposal }).strict()
const transferSchema = z
  .object({
    version: z.literal(1),
    manifest: manifestSchema,
    activation: z
      .object({
        version: z.literal(1),
        requestID: id,
        sourceID: id,
        sourceGeneration: id,
        candidateID: id,
        candidateGeneration: id,
        readyID: id,
        sourceRevision: epoch,
        sourceHash: hash,
        activatedAt: time,
      })
      .strict(),
  })
  .strict()

export type Reference = z.infer<typeof reference>
export type Manifest = z.infer<typeof manifestSchema>
export type Observation = z.infer<typeof observationSchema>
export type OfferReceipt = z.infer<typeof offerSchema>
type AckReceipt = z.infer<typeof ack>
type TransferReceipt = z.infer<typeof transferSchema>

function matches(value: Record<string, unknown>, expected: Record<string, unknown>) {
  return Object.entries(expected).every(([key, field]) => value[key] === field)
}

function identical(value: Reference, expected: Reference) {
  return matches(value, expected) && matches(expected, value)
}

function require(condition: boolean) {
  if (!condition) throw new Error("Voice retained work receipt does not match its authority")
}

export function registry(value: unknown): Reference[] {
  return z
    .object({ version: z.literal(1), references: list })
    .strict()
    .parse(value).references
}

export function manifest(value: unknown): Manifest {
  return manifestSchema.parse(value)
}

export function transfer(value: unknown): TransferReceipt {
  const result = transferSchema.parse(value)
  for (const key of ["sourceID", "sourceGeneration", "candidateID", "candidateGeneration"] as const)
    require(result.manifest[key] === result.activation[key])
  return result
}

export function observation(value: unknown, ref: Reference): Observation {
  const result = observationSchema.parse(value)
  require(identical(result.reference, ref) && identical(result.delivery.reference, ref))
  require(
    matches(result.receipt, {
      id: ref.receiptID,
      callID: ref.callID,
      messageID: ref.messageID,
      parentSessionID: ref.parentSessionID,
      createdAt: ref.createdAt,
    }),
  )
  const state = result.delivery
  history(state, ref)
  const terminal = result.receipt.status !== "accepted" && result.receipt.status !== "running"
  require(terminal === !!result.resultHash)
  require(!state.offer || state.offer.resultHash === result.resultHash)
  return result
}

function history(state: z.infer<typeof delivery>, ref: Reference) {
  require((state.phase === "pending") === !state.offer)
  require(
    state.phase === "pending"
      ? state.epoch === 0 && !state.acks.length
      : state.epoch > 0 && state.epoch === state.offer!.deliveryEpoch,
  )
  require(state.phase !== "offered" || !state.acks.length)
  const phases = state.acks.map((value) => value.phase)
  require(!phases.length || phases[0] === "accepted" || phases[0] === "omitted")
  require(phases.length < 2 || (phases[0] === "accepted" && (phases[1] === "generated" || phases[1] === "omitted")))
  require(phases.length < 3 || (phases[1] === "generated" && (phases[2] === "played" || phases[2] === "omitted")))
  require(new Set(state.acks.map((value) => value.ackID)).size === state.acks.length)
  identities(state, ref)
  require(state.phase === "pending" || state.phase === "offered" || state.acks.at(-1)?.phase === state.phase)
}

function identities(state: z.infer<typeof delivery>, ref: Reference) {
  const generated = state.acks.find((value) => value.phase === "generated")
  require(
    !generated ||
      (!!generated.responseID && (!state.offer?.responseID || generated.responseID === state.offer.responseID)),
  )
  for (const value of state.acks) {
    const offer = state.offer!
    require(
      identical(value.reference, ref) &&
        matches(value, {
          offerID: offer.offerID,
          targetID: offer.targetID,
          generation: offer.targetGeneration,
          providerCallID: offer.providerCallID,
          itemID: offer.itemID,
          resultHash: offer.resultHash,
          deliveryEpoch: state.epoch,
          responseID:
            value.phase === "generated" || value.phase === "played" || (value.phase === "omitted" && generated)
              ? generated?.responseID
              : offer.responseID,
        }),
    )
  }
}

export function offer(value: unknown, ref: Reference, body: Record<string, unknown>, target: string): OfferReceipt {
  const result = offerSchema.parse(value)
  require(identical(result.reference, ref) && result.offer.targetID === target)
  const { action: _action, generation, ...fields } = body
  require(matches(result.offer, { ...fields, responseID: body.responseID, targetGeneration: generation }))
  require(result.offer.deliveryEpoch > 0)
  return result
}

export function acknowledgement(
  value: unknown,
  ref: Reference,
  body: Record<string, unknown>,
  target: string,
): AckReceipt {
  const result = ack.parse(value)
  const { action: _action, ...fields } = body
  require(
    identical(result.reference, ref) &&
      matches(result, { ...fields, responseID: body.responseID }) &&
      result.targetID === target,
  )
  require((result.phase !== "generated" && result.phase !== "played") || !!result.responseID)
  return result
}

/** Only bounded user-facing result text crosses into the successor model session. */
export function envelope(value: unknown): string {
  const receipt = call.parse(value)
  const points = Array.from(receipt.result?.text ?? receipt.error?.message ?? "")
  const render = (length: number) =>
    JSON.stringify({
      status: receipt.status,
      text: points.slice(0, length).join(""),
      ...(length < points.length ? { truncated: true, note: "Full result remains in the conversation." } : {}),
    })
  const full = render(points.length)
  if (Buffer.byteLength(full, "utf8") <= 16384) return full
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(render(middle), "utf8") <= 16384) {
      low = middle
      continue
    }
    high = middle - 1
  }
  return render(low)
}
