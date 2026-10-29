import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { Effect, Schema } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type * as Tool from "@/tool/tool"
import { RayaChief } from "../chief"
import { ContextLimit, ownerContext } from "./request"
import { gate } from "../session/input-gate"

export const key = "raya.assignment.owner-limit"
const Proof = Schema.Struct({
  version: Schema.Literal(1),
  reason: Schema.Literal("owner-context-limit"),
  sessionID: SessionID,
  userID: MessageID,
  messageID: MessageID,
  callID: Schema.String,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
export class OwnerLimit extends Schema.TaggedErrorClass<OwnerLimit>()("RayaAssignment.OwnerLimit", {
  message: Schema.String,
  proof: Proof,
}) {}

/** Only the actual preservation boundary can classify an irreducible owner request. */
export function classify<E>(
  error: E,
  ctx: Pick<Tool.Context, "sessionID" | "messageID" | "callID">,
  user: MessageID | undefined,
  owner: string | undefined,
) {
  if (!(error instanceof ContextLimit) || !user || !ctx.callID || !owner || ownerContext(owner).length <= 4000)
    return error
  return new OwnerLimit({
    message: error.message,
    proof: {
      version: 1,
      reason: "owner-context-limit",
      sessionID: ctx.sessionID,
      userID: user,
      messageID: ctx.messageID,
      callID: ctx.callID,
      sha256: digest(owner),
    },
  })
}

/** Refuse only this rejected original assignment; ordinary repairable failures retain their workflow. */
export function current(
  messages: readonly MessageV2.WithParts[],
  session: Pick<Session.Info, "id" | "parentID" | "metadata">,
  userID: MessageID,
) {
  if (
    session.parentID ||
    session.metadata?.rayaRoutine !== undefined ||
    session.metadata?.["raya.goal.open"] === true ||
    RayaChief.phase(session.metadata) !== "route"
  )
    return undefined
  const user = messages.findLast((row) => row.info.role === "user")
  if (
    user?.info.role !== "user" ||
    user.info.id !== userID ||
    user.info.sessionID !== session.id ||
    user.info.agent !== "auto" ||
    user.info.format?.type === "json_schema"
  )
    return undefined
  const owner = user.parts
    .filter((part) => part.type === "text" && !part.synthetic)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
  if (ownerContext(owner).length <= 4000 || RayaChief.request(session.metadata) !== owner.trim()) return undefined
  const all = messages
    .filter((row) => row.info.role === "assistant" && row.info.parentID === userID && row.info.sessionID === session.id)
    .flatMap((row) =>
      row.parts.filter(
        (part) => part.type === "tool" && part.messageID === row.info.id && part.sessionID === session.id,
      ),
    )
  const rows = messages.filter(
    (row) =>
      row.info.role === "assistant" &&
      row.info.parentID === userID &&
      row.info.sessionID === session.id &&
      row.info.agent === "auto" &&
      !row.info.error &&
      !row.info.summary,
  )
  const parts = rows.flatMap((row) =>
    row.parts.filter((part) => part.type === "tool" && part.messageID === row.info.id && part.sessionID === session.id),
  )
  if (all.some((part) => part.type === "tool" && !["inspect_routines", "assign_organization_work"].includes(part.tool)))
    return undefined
  if (
    all.some(
      (part) =>
        part.type === "tool" &&
        (["pending", "running"].includes(part.state.status) ||
          (part.tool === "assign_organization_work" &&
            part.state.status === "completed" &&
            (part.state.metadata.requestStatus === "complete" ||
              typeof part.state.metadata.delegationID === "string"))),
    )
  )
    return undefined
  const failures = parts.flatMap((part) => {
    if (
      part.type !== "tool" ||
      part.tool !== "assign_organization_work" ||
      part.state.status !== "completed" ||
      part.state.metadata.requestStatus !== "unresolved"
    )
      return []
    const proof = Schema.decodeUnknownOption(Proof)(part.state.metadata[key])
    if (proof._tag !== "Some") return []
    const saved = proof.value
    if (
      saved.sessionID !== session.id ||
      saved.userID !== userID ||
      saved.messageID !== part.messageID ||
      saved.callID !== part.callID ||
      saved.sha256 !== digest(owner) ||
      parts.filter((item) => item.type === "tool" && item.messageID === part.messageID && item.callID === part.callID)
        .length !== 1
    )
      return []
    return [{ proof: saved, part: part.id, length: ownerContext(owner).length }]
  })
  return failures.at(-1)
}

/** Publish a factual native refusal before another model retry can invent worker progress. */
export function finish(
  sessions: Pick<Session.Interface, "get" | "messages" | "updateMessage" | "updatePart">,
  sessionID: SessionID,
  userID: MessageID,
) {
  return Effect.gen(function* () {
    const rows = yield* sessions.messages({ sessionID, limit: 129 })
    if (rows.length > 128 || rows.some((row) => row.parts.length > 256)) return false
    const session = yield* sessions.get(sessionID)
    const refusal = current(rows, session, userID)
    if (!refusal) return false
    const source = rows.find(
      (row) =>
        row.info.id === refusal.proof.messageID &&
        row.info.role === "assistant" &&
        row.info.parentID === userID &&
        row.info.agent === "auto",
    )
    if (source?.info.role !== "assistant") return false
    const latest = yield* sessions.messages({ sessionID, limit: 129 })
    const target = yield* sessions.get(sessionID)
    if (!isDeepStrictEqual(refusal, current(latest, target, userID))) return false
    const text = `This team job was not started. Preserving the original request requires ${refusal.length} characters of worker context, exceeding the 4000-character limit. I did not truncate it; retrying it unchanged cannot start the job. A shorter new request is needed.`
    if (
      latest.some(
        (row) =>
          row.info.role === "assistant" &&
          row.info.parentID === userID &&
          row.parts.some((part) => part.type === "text" && part.metadata?.[key] === refusal.part),
      )
    )
      return true
    const at = Date.now()
    const id = MessageID.ascending()
    yield* sessions.updateMessage({
      ...source.info,
      id,
      finish: "stop",
      error: undefined,
      time: { created: at, completed: at },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: id,
      sessionID,
      type: "text",
      text,
      metadata: { [key]: refusal.part },
    })
    return true
  }).pipe(gate.withLock(sessionID))
}
