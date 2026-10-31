import { eq } from "drizzle-orm"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Option, Schema } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InputReceipt } from "@opencode-ai/core/kilocode/input-receipt"
import {
  RayaRoutineOrganizationTable as Organization,
  RayaRoutineOrganizationMemberTable as Member,
  RayaRoutineOrganizationDelegationTable as Route,
} from "@opencode-ai/core/kilocode/routine.sql"
import type { Session } from "@/session/session"
import type { MessageID, SessionID } from "@/session/schema"
import { gate } from "@/kilocode/session/input-gate"
import { Origin, Receipt, assignment, decode, fingerprint, same, type Reference, type Stage } from "./job-contract"
import { Invalid, invocation, owner, stage } from "./job-contract-store"
import { canonical } from "./output-scope"
import * as Owner from "./owner-scope"
import { kickoff, ownerContext, preserve } from "./request"

type Goal = { createdAt: number; intent?: string }
type Proof = { receipt: Receipt; sessionID: SessionID; check: Effect.Effect<void, unknown> }
/** The JSON-visible fields are informational. Only this module's native registry establishes a handle. */
export type Handle = { readonly ref: Reference; readonly stage: Stage; readonly senderID: string }
const handles = new WeakMap<Handle, Proof>()
const fail = () =>
  Effect.fail(new Invalid({ message: "The native owner request changed or cannot authorize this contract." }))

/** Resolve only a native in-process handle; deserialized model/API objects cannot supply capture authority. */
export const proof = (handle: Handle) =>
  Effect.suspend(() => {
    const value = handles.get(handle)
    return value ? Effect.succeed(value.receipt) : fail()
  })

/** Lock only admission, not child startup or execution. */
export function guard<A, E, R>(handle: Handle, operation: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => {
    const value = handles.get(handle)
    return value ? gate.withLock(value.sessionID)(value.check.pipe(Effect.andThen(operation))) : fail()
  })
}

/** Capture from the actual published native tool and sealed human input, never supplied Origin JSON. */
export function make(input: {
  database: Database.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  goal: (sessionID: SessionID) => Effect.Effect<Goal | undefined, unknown>
}) {
  const capture = Effect.fn("RoutineJobContract.capture")(function* (request: {
    sessionID: SessionID
    messageID: MessageID
    callID: string
    source: string
  }) {
    const db = input.database.db
    const session = yield* input.sessions.get(request.sessionID)
    if (session.metadata?.rayaRoutine !== undefined) return yield* fail()
    const rows = yield* input.sessions.messages({ sessionID: request.sessionID })
    const user = rows.findLast((row) => row.info.role === "user")
    const assistant = rows.find((row) => row.info.id === request.messageID)
    if (
      !user ||
      !InputReceipt.complete(user, request.sessionID, user.info.id) ||
      assistant?.info.role !== "assistant" ||
      assistant.info.parentID !== user.info.id ||
      assistant.info.sessionID !== request.sessionID
    )
      return yield* fail()
    const calls = assistant.parts.filter((part) => part.type === "tool" && part.callID === request.callID)
    const part = calls[0]
    if (
      calls.length !== 1 ||
      part?.type !== "tool" ||
      part.tool !== "assign_organization_work" ||
      part.messageID !== request.messageID ||
      part.sessionID !== request.sessionID
    )
      return yield* fail()
    const params = part.state.input
    const proposal = yield* decode(params.contract)
    const organizationID = yield* Schema.decodeUnknownEffect(Receipt.fields.organizationID)(params.organizationID)
    const revision = yield* Schema.decodeUnknownEffect(Receipt.fields.organizationRevision)(params.expectedRevision)
    const sender = yield* Schema.decodeUnknownEffect(Schema.String)(params.senderID)
    const text = user.parts.flatMap((item) => (item.type === "text" && !item.synthetic ? [item.text] : [])).join("\n")
    if (!text.trim()) return yield* fail()
    const key = kickoff(text)
      ? [request.sessionID, user.info.id, organizationID]
      : [request.sessionID, request.messageID, request.callID, organizationID]
    const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 48)
    if (request.source !== `organization-chat:${hash(JSON.stringify(key))}`) return yield* fail()
    yield* Owner.unmarked(text)
    const context = yield* Schema.decodeUnknownEffect(Schema.UndefinedOr(Schema.String))(params.context)
    yield* Owner.unmarked(context)
    const common = yield* preserve(context, ownerContext(text))
    const directory = yield* Owner.directory(text)
    const goal = yield* input.goal(request.sessionID)
    const fs = yield* Effect.serviceOption(FSUtil.Service)
    if (Option.isNone(fs)) return yield* fail()
    const stages = yield* Effect.forEach(proposal.stages, (item) =>
      Effect.gen(function* () {
        yield* Owner.unmarked(item.context)
        const outputs = yield* canonical(fs.value, item.outputs)
        yield* Owner.check(directory, outputs)
        return { ...item, outputs }
      }),
    )
    const pending = [{ id: proposal.entry, ancestors: new Set([sender]) }]
    while (pending.length) {
      const node = pending.pop()!
      const value = stages.find((item) => item.id === node.id)!
      if (node.ancestors.has(value.recipientID)) return yield* fail()
      const ancestors = new Set([...node.ancestors, value.recipientID])
      pending.push(...value.next.map((edge) => ({ id: edge.stageID, ancestors })))
    }
    const origin = yield* Schema.decodeUnknownEffect(Origin)({
      sessionID: request.sessionID,
      userID: user.info.id,
      messageID: request.messageID,
      partID: part.id,
      callID: part.callID,
      userSHA256: owner(user),
      toolSHA256: invocation(part),
      goal: goal ? { createdAt: goal.createdAt, intent: goal.intent } : null,
      directory: directory ?? null,
    })
    const value = {
      version: 1 as const,
      id: `rjc_${hash(request.source)}`,
      rootID: `rdl_${hash(request.source)}`,
      rootSource: request.source,
      organizationID,
      organizationRevision: revision,
      origin,
      context: common,
      proposal: { ...proposal, stages },
    }
    const receipt = yield* Schema.decodeUnknownEffect(Receipt)({ ...value, sha256: fingerprint(value) })
    // Every stage must fit the real worker context bound; no truncation or hidden later failure.
    yield* Effect.forEach(stages, (item) => stage(receipt, item.id), { discard: true })
    const entry = yield* stage(receipt, proposal.entry)
    const assigned = yield* assignment(proposal, params)
    if (!same(entry, { ...assigned, context: entry.context })) return yield* fail()
    const check = Effect.gen(function* () {
      const live = yield* input.sessions.get(request.sessionID)
      if (live.metadata?.rayaRoutine !== undefined) return yield* fail()
      const rows = yield* input.sessions.messages({ sessionID: request.sessionID })
      const latest = rows.findLast((row) => row.info.role === "user")
      const current = rows.find((row) => row.info.id === request.messageID)
      const call = current?.parts.find((item) => item.id === part.id)
      const stamp = yield* input.goal(request.sessionID)
      if (
        !latest ||
        latest.info.id !== user.info.id ||
        owner(latest) !== receipt.origin.userSHA256 ||
        !InputReceipt.complete(latest, request.sessionID, user.info.id) ||
        current?.info.role !== "assistant" ||
        current.info.parentID !== user.info.id ||
        call?.type !== "tool" ||
        invocation(call) !== receipt.origin.toolSHA256 ||
        !isDeepStrictEqual(stamp ? { createdAt: stamp.createdAt, intent: stamp.intent } : null, receipt.origin.goal)
      )
        return yield* fail()
      const organization = yield* db.select().from(Organization).where(eq(Organization.id, organizationID)).get()
      if (
        !organization ||
        organization.revision !== revision ||
        organization.archived_at !== null ||
        organization.stopping_at !== null ||
        organization.stopped_at !== null
      )
        return yield* fail()
      const members = yield* db.select().from(Member).where(eq(Member.organization_id, organizationID)).all()
      const routes = yield* db.select().from(Route).where(eq(Route.organization_id, organizationID)).all()
      const known = new Set(members.map((item) => item.agent_id))
      const pairs = [
        { from: sender, to: entry.recipientID },
        ...stages.flatMap((item) =>
          item.next.map((edge) => ({
            from: item.recipientID,
            to: stages.find((stage) => stage.id === edge.stageID)!.recipientID,
          })),
        ),
      ]
      if (
        pairs.some(
          (pair) =>
            pair.from === pair.to ||
            !known.has(pair.from) ||
            !known.has(pair.to) ||
            !routes.some((route) => route.sender_id === pair.from && route.recipient_id === pair.to),
        )
      )
        return yield* fail()
      return undefined
    })
    yield* check
    const handle: Handle = Object.freeze({
      ref: Object.freeze({ id: receipt.id, sha256: receipt.sha256, stageID: entry.id }),
      stage: structuredClone(entry),
      senderID: sender,
    })
    handles.set(handle, { receipt, sessionID: request.sessionID, check })
    return handle
  })
  return { capture }
}
