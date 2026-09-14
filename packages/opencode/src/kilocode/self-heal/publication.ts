import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import type { Storage as Store } from "@/storage/storage"

const Text = Schema.String.check(Schema.isMinLength(1))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Time = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Source = Schema.Struct({
  sessionID: Text,
  messageID: Text,
  partID: Text,
  callID: Text,
  summary: Text,
  record: Schema.Struct({ version: Schema.Literal(1), digest: Hash, at: Time }),
})
const Requirement = Schema.Struct({
  requirement: Text,
  passed: Schema.Literal(true),
  evidence: Schema.Array(Source).check(Schema.isMinLength(1)),
})
const Verification = Schema.Struct({
  sessionID: Text,
  goalRevision: Text,
  summary: Text,
  verifiedAt: Time,
  reviewedAt: Time,
  requirements: Schema.Array(Requirement).check(Schema.isMinLength(1)),
})
export const Publish = Schema.Struct({
  installationID: Schema.String.check(Schema.isUUID()),
  verification: Verification,
})
export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  itemID: Text,
  installationID: Schema.String.check(Schema.isUUID()),
  goalRevision: Text,
  evidence: Schema.Struct({ summary: Text, artifact: Text, at: Time }),
  verification: Verification,
  createdAt: Time,
})

export class Conflict extends Schema.TaggedErrorClass<Conflict>()("SelfHeal.PublicationConflict", {
  message: Schema.String,
}) {}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const equal = (one: unknown, two: unknown) => JSON.stringify(one) === JSON.stringify(two)

export function publications(storage: Pick<Store.Interface, "read" | "create" | "update" | "list">) {
  const decode = Schema.decodeUnknownEffect(Receipt)
  const prefix = (itemID: string) => ["raya", "self-heal", "publication", hash(itemID)]
  const key = (itemID: string, input: typeof Publish.Type) => [
    ...prefix(itemID),
    hash(JSON.stringify([input.installationID, input.verification.goalRevision])),
  ]
  const list = Effect.fn("SelfHeal.publication.list")(function* (itemID: string) {
    const keys = yield* storage.list(prefix(itemID)).pipe(Effect.orDie)
    const receipts = yield* Effect.forEach(keys, (path) =>
      storage.read<unknown>(path).pipe(Effect.flatMap(decode), Effect.orDie),
    )
    return receipts.toSorted((one, two) => one.createdAt - two.createdAt)
  })
  const publish = Effect.fn("SelfHeal.publication.publish")(function* (itemID: string, input: typeof Publish.Type) {
    const item = ["raya", "self-heal", "item", itemID]
    yield* storage.read<unknown>(item)
    const artifact = `self-heal-verification:${input.installationID}:${input.verification.goalRevision}`
    const sources = input.verification.requirements
      .map(
        (requirement) =>
          `${requirement.requirement}: ${requirement.evidence.map((evidence) => `${evidence.summary} (${evidence.sessionID}/${evidence.messageID}/${evidence.callID})`).join("; ")}`,
      )
      .join(" | ")
    const evidence = {
      summary: `${input.verification.summary} Verification session ${input.verification.sessionID}. ${sources}`,
      artifact,
      at: input.verification.reviewedAt,
    }
    const receipt: typeof Receipt.Type = {
      version: 1,
      itemID,
      installationID: input.installationID,
      goalRevision: input.verification.goalRevision,
      evidence,
      verification: input.verification,
      createdAt: Date.now(),
    }
    const path = key(itemID, input)
    const created = yield* storage.create(path, receipt).pipe(Effect.orDie)
    const retained = created ? receipt : yield* storage.read<unknown>(path).pipe(Effect.flatMap(decode), Effect.orDie)
    if (!equal({ ...retained, createdAt: 0 }, { ...receipt, createdAt: 0 }))
      return yield* new Conflict({ message: "A different verification publication already owns this identity." })
    yield* storage.update<{ evidence: Array<typeof evidence>; updatedAt: number }>(item, (current) => {
      const found = current.evidence.find((entry) => entry.artifact === artifact)
      if (found) {
        if (!equal(found, evidence)) throw new Error("The retained verification evidence conflicts with its receipt.")
        return
      }
      current.evidence = [...current.evidence, evidence].slice(-50)
      current.updatedAt = Date.now()
    })
    return retained
  })
  return { list, publish }
}
