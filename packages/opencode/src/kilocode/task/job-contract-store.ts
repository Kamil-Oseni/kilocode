import { eq } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { Database } from "@opencode-ai/core/database/database"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"
import {
  RayaRoutineJobContractTable as Contract,
  RayaRoutineDelegationTable as Delegation,
  RayaRoutineOrganizationTable as Organization,
} from "@opencode-ai/core/kilocode/routine.sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Receipt, Reference, canonical, decode, fingerprint, same, type Stage } from "./job-contract"
import { Outputs } from "./output-scope"
import { Criteria } from "@/kilocode/goal/criteria"
import * as Owner from "./owner-scope"
import { kickoff, ownerContext, preserve } from "./request"

type Row = typeof Delegation.$inferSelect
type Frame = { agentID: string; runID: string; sessionID?: SessionID; contract?: Reference }
type Current = {
  run: { id: string; agentID: string; sessionID?: SessionID; contract?: Reference }
  goal: { routine?: Frame }
  session: { id: SessionID; metadata?: Record<string, unknown> }
  snapshot: Frame & { version: number }
}
type Sessions = Pick<Session.Interface, "get"> & Partial<Pick<Session.Interface, "findMessage" | "messages">>
export class Invalid extends Schema.TaggedErrorClass<Invalid>()("RoutineJobContract.Invalid", {
  message: Schema.String,
}) {}
const fail = (message = "Routine job contract evidence is missing, invalid or changed.") =>
  Effect.fail(new Invalid({ message }))
const protect = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.catchCause((cause) => (Cause.hasInterrupts(cause) ? Effect.failCause(cause).pipe(Effect.orDie) : fail())),
  )
const parse = (raw: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => new Invalid({ message: "Routine job contract contains invalid JSON." }),
  })
const marker = Schema.Struct({
  version: Schema.Literals([1, 2, 3]),
  agentID: Schema.String,
  runID: Schema.String,
  delegationID: Schema.optional(Schema.String),
  organizationID: Schema.optional(Schema.String),
  organizationRevision: Schema.optional(Schema.Number),
  contract: Schema.optional(Reference),
})

/** Stable input identities; tool status and output can legitimately change after admission. */
export const owner = (row: SessionV1.WithParts) => digest({ tool: "routine-job-owner-v1", state: row })
export const invocation = (part: SessionV1.ToolPart) =>
  digest({
    tool: "routine-job-invocation-v1",
    state: {
      sessionID: part.sessionID,
      messageID: part.messageID,
      partID: part.id,
      callID: part.callID,
      tool: part.tool,
      input: part.state.input,
    },
  })

/** Compile only the common owner context and this stage's frozen context. */
export const stage = Effect.fn("RoutineJobContract.stage")(function* (receipt: Receipt, id: string) {
  const value = receipt.proposal.stages.find((item) => item.id === id)
  if (!value) return yield* fail("The requested stage is not in this job contract.")
  yield* Owner.unmarked(receipt.context)
  yield* Owner.unmarked(value.context)
  yield* Owner.check(receipt.origin.directory ?? undefined, value.outputs)
  const text = yield* preserve(receipt.context, value.context)
  const context = yield* Owner.context(receipt.origin.directory ?? undefined, text)
  return { ...value, context }
})

export type View = {
  receipt: Receipt
  ref: Reference
  stage: Stage
  next: Stage[]
  required: Stage[]
  incoming: Row
  check: Effect.Effect<void, Invalid>
}

/** Read-side proof only. This service cannot mint origin receipts, launch tasks or grant permissions. */
export function make(input: { database: Database.Interface; sessions: Sessions }) {
  const db = input.database.db
  const find = (sessionID: SessionID, id: string) =>
    input.sessions.findMessage
      ? input.sessions.findMessage(sessionID, (row) => row.info.id === id).pipe(Effect.map(Option.getOrUndefined))
      : input.sessions.messages
        ? input.sessions.messages({ sessionID }).pipe(Effect.map((rows) => rows.find((row) => row.info.id === id)))
        : fail()
  const source = Effect.fn("RoutineJobContract.source")(function* (receipt: Receipt, root: Row) {
    const origin = receipt.origin
    const session = yield* input.sessions.get(origin.sessionID)
    if (session.metadata?.rayaRoutine !== undefined) return yield* fail()
    const user = yield* find(origin.sessionID, origin.userID)
    const assistant = yield* find(origin.sessionID, origin.messageID)
    if (
      !user ||
      !InputReceipt.complete(user, origin.sessionID, origin.userID) ||
      !user.parts.some((part) => part.type === "text" && !part.synthetic && part.text.trim()) ||
      owner(user) !== origin.userSHA256 ||
      assistant?.info.role !== "assistant" ||
      assistant.info.parentID !== origin.userID ||
      assistant.info.sessionID !== origin.sessionID
    )
      return yield* fail()
    const part = assistant.parts.find((item) => item.id === origin.partID)
    if (
      part?.type !== "tool" ||
      part.tool !== "assign_organization_work" ||
      part.callID !== origin.callID ||
      part.sessionID !== origin.sessionID ||
      part.messageID !== origin.messageID ||
      invocation(part) !== origin.toolSHA256 ||
      part.state.input.organizationID !== receipt.organizationID ||
      part.state.input.expectedRevision !== receipt.organizationRevision
    )
      return yield* fail()
    const text = user.parts.flatMap((item) => (item.type === "text" && !item.synthetic ? [item.text] : [])).join("\n")
    const directory = yield* Owner.directory(text)
    if ((directory ?? null) !== origin.directory) return yield* fail()
    const proposal = yield* decode(part.state.input.contract)
    if (!isDeepStrictEqual(canonical(proposal), canonical(receipt.proposal))) return yield* fail()
    const context = yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String))(part.state.input.context)
    yield* Owner.unmarked(context)
    const common = yield* preserve(context, ownerContext(text))
    if (common !== receipt.context) return yield* fail()
    const key = kickoff(text)
      ? [origin.sessionID, origin.userID, receipt.organizationID]
      : [origin.sessionID, origin.messageID, origin.callID, receipt.organizationID]
    const expected = `organization-chat:${createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 48)}`
    if (expected !== receipt.rootSource) return yield* fail()
    const entry = yield* stage(receipt, receipt.proposal.entry)
    const request = part.state.input
    if (request.senderID !== root.sender_id) return yield* fail()
    if (
      !same(entry, {
        recipientID: yield* Schema.decodeUnknownEffect(Schema.String)(request.recipientID),
        objective: yield* Schema.decodeUnknownEffect(Schema.String)(request.objective),
        expected: yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String))(request.expected),
        outputs: yield* Schema.decodeUnknownEffect(Outputs)(request.outputs),
        criteria: yield* Schema.decodeUnknownEffect(Criteria)(request.criteria),
        context: entry.context,
      })
    )
      return yield* fail()
    return undefined
  })
  const load = Effect.fn("RoutineJobContract.load")(function* (ref: Reference) {
    yield* Schema.decodeUnknownEffect(Reference)(ref, { onExcessProperty: "error" })
    const saved = yield* db.select().from(Contract).where(eq(Contract.id, ref.id)).get()
    if (!saved) return yield* fail()
    const receipt = yield* Schema.decodeUnknownEffect(Receipt)(
      {
        version: saved.version,
        id: saved.id,
        rootID: saved.root_id,
        rootSource: saved.root_source,
        organizationID: saved.organization_id,
        organizationRevision: saved.organization_revision,
        origin: yield* parse(saved.origin),
        proposal: yield* parse(saved.proposal),
        context: saved.context ?? undefined,
        sha256: saved.sha256,
      },
      { onExcessProperty: "error" },
    )
    if (receipt.sha256 !== ref.sha256 || fingerprint(receipt) !== ref.sha256) return yield* fail()
    const root = yield* db.select().from(Delegation).where(eq(Delegation.id, receipt.rootID)).get()
    if (
      !root ||
      root.source !== receipt.rootSource ||
      root.parent_id !== null ||
      root.parent_run_id !== null ||
      root.id !== `rdl_${createHash("sha256").update(root.source).digest("hex").slice(0, 48)}` ||
      root.organization_id !== receipt.organizationID ||
      root.organization_revision !== receipt.organizationRevision ||
      root.contract_id !== receipt.id ||
      root.contract_sha256 !== receipt.sha256 ||
      root.stage_id !== receipt.proposal.entry ||
      root.state === "failed" ||
      root.state === "cancelled"
    )
      return yield* fail()
    yield* matches(receipt, root)
    yield* stage(receipt, ref.stageID)
    const organization = yield* db.select().from(Organization).where(eq(Organization.id, receipt.organizationID)).get()
    if (
      !organization ||
      organization.revision !== receipt.organizationRevision ||
      organization.archived_at !== null ||
      organization.stopping_at !== null ||
      organization.stopped_at !== null
    )
      return yield* fail()
    yield* source(receipt, root)
    return receipt
  })
  const read = (ref: Reference) =>
    protect(
      Effect.gen(function* () {
        const receipt = yield* load(ref)
        return {
          receipt,
          check: protect(
            load(ref).pipe(Effect.flatMap((value) => (isDeepStrictEqual(value, receipt) ? Effect.void : fail()))),
          ),
        }
      }),
    )
  const matches = Effect.fn("RoutineJobContract.matches")(function* (receipt: Receipt, row: Row) {
    if (
      row.contract_id !== receipt.id ||
      row.contract_sha256 !== receipt.sha256 ||
      row.organization_id !== receipt.organizationID ||
      row.organization_revision !== receipt.organizationRevision ||
      !row.stage_id
    )
      return yield* fail()
    const value = yield* stage(receipt, row.stage_id)
    const outputs = row.outputs === null ? undefined : yield* parse(row.outputs)
    const criteria = row.criteria === null ? undefined : yield* parse(row.criteria)
    if (
      !same(value, {
        recipientID: row.recipient_id,
        objective: row.objective,
        expected: row.expected ?? undefined,
        context: row.context ?? undefined,
        outputs: yield* Schema.decodeUnknownEffect(Outputs)(outputs),
        criteria: yield* Schema.decodeUnknownEffect(Criteria)(criteria),
      })
    )
      return yield* fail()
    return value
  })
  const current = (value: Current) =>
    protect(
      Effect.gen(function* () {
        const identity = yield* Schema.decodeUnknownEffect(marker)(value.session.metadata?.rayaRoutine)
        const rows = yield* db.select().from(Delegation).where(eq(Delegation.session_id, value.session.id)).all()
        if (rows.length > 1) return yield* fail()
        const incoming = rows[0]
        const refs = [value.run.contract, value.goal.routine?.contract, identity.contract, value.snapshot.contract]
        const tracked =
          refs.some((item) => item !== undefined) || identity.version === 3 || value.snapshot.version === 3
        if (!incoming) {
          if (tracked || identity.delegationID) return yield* fail()
          return undefined
        }
        if (
          incoming.id !== identity.delegationID ||
          incoming.child_run_id !== value.run.id ||
          incoming.recipient_id !== value.run.agentID ||
          value.run.sessionID !== value.session.id ||
          identity.agentID !== value.run.agentID ||
          identity.runID !== value.run.id ||
          value.snapshot.runID !== value.run.id ||
          value.snapshot.agentID !== value.run.agentID ||
          value.snapshot.sessionID !== value.session.id ||
          value.goal.routine?.runID !== value.run.id ||
          value.goal.routine.agentID !== value.run.agentID ||
          value.goal.routine.sessionID !== value.session.id ||
          incoming.organization_id !== (identity.organizationID ?? null) ||
          incoming.organization_revision !== (identity.organizationRevision ?? null)
        )
          return yield* fail()
        const pointers = [incoming.contract_id, incoming.contract_sha256, incoming.stage_id]
        if (
          pointers.every((item) => item === null) &&
          !tracked &&
          [1, 2].includes(identity.version) &&
          [1, 2].includes(value.snapshot.version)
        )
          return undefined
        if (
          pointers.some((item) => typeof item !== "string") ||
          refs.some((item) => item === undefined) ||
          identity.version !== 3 ||
          value.snapshot.version !== 3 ||
          !["running", "needs_input"].includes(incoming.state)
        )
          return yield* fail()
        const ref = yield* Schema.decodeUnknownEffect(Reference)({
          id: incoming.contract_id,
          sha256: incoming.contract_sha256,
          stageID: incoming.stage_id,
        })
        if (refs.some((item) => !isDeepStrictEqual(item, ref))) return yield* fail()
        const proof = yield* read(ref)
        const own = yield* matches(proof.receipt, incoming)
        const next = yield* Effect.forEach(own.next, (edge) => stage(proof.receipt, edge.stageID))
        const required = next.filter((item) => own.next.some((edge) => edge.stageID === item.id && edge.required))
        const check = protect(
          Effect.gen(function* () {
            yield* proof.check
            const fresh = yield* db.select().from(Delegation).where(eq(Delegation.id, incoming.id)).get()
            if (!isDeepStrictEqual(fresh, incoming)) return yield* fail()
            return undefined
          }),
        )
        return { receipt: proof.receipt, ref, stage: own, next, required, incoming, check } satisfies View
      }),
    )
  const child = (view: View, row: Row) =>
    protect(
      Effect.gen(function* () {
        yield* view.check
        if (
          row.parent_id !== view.incoming.id ||
          row.parent_run_id !== view.incoming.child_run_id ||
          row.sender_id !== view.incoming.recipient_id ||
          !view.next.some((item) => item.id === row.stage_id)
        )
          return yield* fail()
        return yield* matches(view.receipt, row)
      }),
    )
  return { read, current, child }
}
