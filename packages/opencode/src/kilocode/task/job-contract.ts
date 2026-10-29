import { Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Criteria } from "@/kilocode/goal/criteria"
import * as Files from "./output-scope"
import { DEPTH, FAN, TREE } from "./limits"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import path from "node:path"

const ID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/))
const Text = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(8000))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Reference = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^rjc_[a-f0-9]{48}$/)),
  sha256: Hash,
  stageID: ID,
})
export type Reference = typeof Reference.Type
export const Origin = Schema.Struct({
  sessionID: SessionID,
  userID: MessageID,
  messageID: MessageID,
  partID: PartID,
  callID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  userSHA256: Hash,
  toolSHA256: Hash,
  goal: Schema.NullOr(Schema.Struct({ createdAt: Schema.Finite, intent: Schema.String.check(Schema.isMinLength(1)) })),
  directory: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
})
export type Origin = typeof Origin.Type
export const Stage = Schema.Struct({
  id: ID,
  recipientID: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  objective: Text,
  expected: Schema.optional(Text),
  context: Schema.optional(Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))),
  outputs: Files.Outputs,
  criteria: Criteria,
  next: Schema.Array(Schema.Struct({ stageID: ID, required: Schema.Boolean })).check(Schema.isMaxLength(FAN)),
})
export type Stage = typeof Stage.Type

/** Proposed work only: this schema never establishes owner authority or starts a worker. */
export const Proposal = Schema.Struct({
  version: Schema.Literal(1),
  entry: ID,
  stages: Schema.Array(Stage).check(Schema.isMinLength(1), Schema.isMaxLength(TREE)),
}).check(
  Schema.makeFilter((value) => {
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) return "Job contracts must fit within 64 KiB."
    const stages = new Map(value.stages.map((stage) => [stage.id, stage]))
    if (stages.size !== value.stages.length) return "Contract stage IDs must be unique."
    if (!stages.has(value.entry)) return "The contract entry must identify an existing stage."
    const parents = new Map<string, string>()
    for (const stage of value.stages) {
      if (new Set(stage.criteria.map((item) => item.id)).size !== stage.criteria.length)
        return `Criterion IDs must be unique in contract stage ${stage.id}.`
      if (new Set(stage.next.map((item) => item.stageID)).size !== stage.next.length)
        return `Next stages must be unique in contract stage ${stage.id}.`
      for (const next of stage.next) {
        if (!stages.has(next.stageID)) return `Contract stage ${stage.id} references missing stage ${next.stageID}.`
        if (next.stageID === value.entry || parents.has(next.stageID))
          return "Each nonentry contract stage must have exactly one predecessor."
        parents.set(next.stageID, stage.id)
      }
      if (value.stages.some((other) => other.id !== stage.id && Files.overlap(stage.outputs, other.outputs)))
        return `Contract stage ${stage.id} overlaps another stage's output files.`
    }
    const seen = new Set<string>()
    const pending = [{ id: value.entry, depth: 1 }]
    while (pending.length) {
      const node = pending.pop()!
      if (node.depth > DEPTH) return `Contract stages cannot exceed delegation depth ${DEPTH}.`
      if (seen.has(node.id)) continue
      seen.add(node.id)
      pending.push(...stages.get(node.id)!.next.map((item) => ({ id: item.stageID, depth: node.depth + 1 })))
    }
    if (seen.size !== stages.size) return "All contract stages must be reachable from the entry."
    return undefined
  }),
)
export type Proposal = typeof Proposal.Type

/** Stored proof data only; issue through native owner capture, never from model arguments. */
export const Receipt = Schema.Struct({
  version: Schema.Literal(1),
  id: Reference.fields.id,
  rootID: Schema.String.check(Schema.isPattern(/^rdl_[a-f0-9]{48}$/)),
  rootSource: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  organizationID: Schema.String.check(Schema.isPattern(/^org_[a-f0-9]{32}$/)),
  organizationRevision: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  origin: Origin,
  context: Schema.optional(Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(4000))),
  proposal: Proposal,
  sha256: Hash,
})
export type Receipt = typeof Receipt.Type

/** Canonicalize data identity only; filesystem, organization and owner authority need native proof. */
export function canonical(value: Proposal): Proposal {
  const stages = new Map(value.stages.map((stage) => [stage.id, stage]))
  return {
    version: 1,
    entry: value.entry,
    stages: [...stages.keys()].sort().map((id) => {
      const stage = stages.get(id)!
      const criteria = new Map(stage.criteria.map((item) => [item.id, item]))
      const next = new Map(stage.next.map((item) => [item.stageID, item]))
      return {
        ...stage,
        outputs: stage.outputs
          .map((file) => (process.platform === "win32" ? path.normalize(file).toLowerCase() : path.normalize(file)))
          .sort(),
        criteria: [...criteria.keys()].sort().map((key) => criteria.get(key)!),
        next: [...next.keys()].sort().map((key) => next.get(key)!),
      }
    }),
  }
}

export const fingerprint = (value: Omit<Receipt, "sha256">) =>
  digest({
    tool: "routine-job-contract-v1",
    state: {
      version: value.version,
      id: value.id,
      rootID: value.rootID,
      rootSource: value.rootSource,
      organizationID: value.organizationID,
      organizationRevision: value.organizationRevision,
      origin: value.origin,
      context: value.context,
      proposal: canonical(value.proposal),
    },
  })

/** Use this decoder at admission; excess host-origin fields must not be silently stripped. */
export const decode = (value: unknown) => Schema.decodeUnknownEffect(Proposal)(value, { onExcessProperty: "error" })

/** Match proposed child data; organization, owner, run and immutable receipt checks belong to admission. */
export function same(
  stage: Proposal["stages"][number],
  request: {
    recipientID: string
    objective: string
    expected?: string
    context?: string
    outputs?: Files.Outputs
    criteria?: Criteria
  },
) {
  if (
    stage.recipientID !== request.recipientID ||
    stage.objective !== request.objective ||
    stage.expected !== request.expected ||
    stage.context !== request.context ||
    request.outputs?.length !== stage.outputs.length
  )
    return false
  if (!stage.outputs.every((file) => Files.includes(request.outputs!, file))) return false
  if (!request.criteria || request.criteria.length !== stage.criteria.length) return false
  const criteria = new Map(request.criteria.map((item) => [item.id, item]))
  return (
    criteria.size === stage.criteria.length &&
    stage.criteria.every((item) => isDeepStrictEqual(criteria.get(item.id), item))
  )
}
