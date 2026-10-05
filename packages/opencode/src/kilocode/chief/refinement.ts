import { Effect, Schema } from "effect"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"
import type { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import type * as Tool from "@/tool/tool"
import { ChiefBranches } from "./branches"
import { ChiefRequestPlan } from "./request-plan"
import { RayaChief } from "."
import { TaskName } from "../tool/task-name"
import { gate } from "../session/input-gate"
import { Refusal } from "../session/tool-refusal"

/** A legacy classification may change only before this request has admitted any child. */
export namespace ChiefRefinement {
  export const key = "raya.chief.refinement"
  const declined = "raya.chief.access-refusals"
  const Proof = Schema.Struct({
    version: Schema.Literal(1),
    sessionID: Schema.String,
    userID: Schema.String,
    messageID: Schema.String,
    partID: Schema.String,
    callID: Schema.String,
    access: RayaChief.Access,
    selectedAgent: Schema.String,
    contract: Schema.String,
    resumeID: Schema.optional(Schema.String),
  })
  const Proofs = Schema.Array(Proof).check(Schema.isMaxLength(16))
  function proofs(metadata: Record<string, unknown> | undefined) {
    const value = metadata?.[declined] === undefined ? [] : metadata[declined]
    if (!Schema.is(Proofs)(value)) throw new Error("Chief capability refusal proof is unreadable")
    return value
  }
  export function decline(input: {
    sessions: Pick<Session.Interface, "get" | "messages" | "setMetadata">
    ctx: Tool.Context
    access: RayaChief.Access
    agent: string
    contract: string
    resume?: string
  }) {
    return Effect.gen(function* () {
      const session = yield* input.sessions.get(input.ctx.sessionID)
      const decision = RayaChief.follow(session.metadata)
      if (!decision || decision.access !== undefined || RayaChief.phase(session.metadata) !== "task") return
      const rows = yield* input.sessions.messages({ sessionID: session.id })
      const user = rows.findLast((row) => row.info.role === "user")
      const message = rows.find((row) => row.info.id === input.ctx.messageID)
      const part = message?.parts.find((part) => part.type === "tool" && part.callID === input.ctx.callID)
      if (
        !input.ctx.callID ||
        input.ctx.agent !== "auto" ||
        fingerprint(session.metadata) !== input.contract ||
        user?.info.role !== "user" ||
        user.info.agent !== "auto" ||
        RayaChief.requestText(user.parts) !== decision.request ||
        message?.info.role !== "assistant" ||
        message.info.agent !== "auto" ||
        message.info.parentID !== user.info.id ||
        part?.type !== "tool" ||
        part.tool !== "task" ||
        part.state.status !== "running" ||
        part.state.input.access !== input.access ||
        part.state.input.task_id !== input.resume ||
        part.state.input.branch_id !== undefined
      )
        throw new Error("Chief capability refusal invocation changed")
      if (input.resume) {
        const resumed = yield* input.sessions
          .get(SessionID.make(input.resume))
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
        if (resumed) throw new Error("Missing Chief resume proof changed")
      }
      const prior = proofs(session.metadata).filter((proof) => proof.userID === user.info.id)
      if (prior.length >= 16) throw new Error("Chief capability refusal proof limit reached")
      yield* input.sessions.setMetadata({
        sessionID: session.id,
        metadata: {
          ...session.metadata,
          [declined]: [
            ...prior,
            {
              version: 1,
              sessionID: session.id,
              userID: user.info.id,
              messageID: message.info.id,
              partID: part.id,
              callID: input.ctx.callID,
              access: input.access,
              selectedAgent: input.agent,
              contract: input.contract,
              ...(input.resume ? { resumeID: input.resume } : {}),
            },
          ],
        },
      })
    }).pipe(gate.withLock(input.ctx.sessionID))
  }
  export const fingerprint = (metadata: Record<string, unknown> | undefined) =>
    digest({
      tool: "chief-contract",
      state: { request: RayaChief.request(metadata), decision: RayaChief.history(metadata).at(-1) ?? null },
    })

  export function check(input: {
    session: Session.Info
    sessions: Pick<Session.Interface, "get" | "messages" | "children">
    storage: Storage.Interface
    ctx: Tool.Context
    access: RayaChief.Access
  }) {
    return Effect.gen(function* () {
      const session = input.session
      const decision = RayaChief.follow(session.metadata)
      const rows = yield* input.sessions.messages({ sessionID: session.id })
      const user = rows.findLast((row) => row.info.role === "user")
      const message = rows.find((row) => row.info.id === input.ctx.messageID)
      const call = message?.parts.find((part) => part.type === "tool" && part.callID === input.ctx.callID)
      if (
        session.parentID ||
        input.ctx.agent !== "auto" ||
        !input.ctx.callID ||
        RayaChief.phase(session.metadata) !== "task" ||
        !decision ||
        decision.access !== undefined ||
        decision.direct ||
        decision.needs_plan ||
        user?.info.role !== "user" ||
        user.info.agent !== "auto" ||
        RayaChief.requestText(user.parts) !== decision.request ||
        message?.info.role !== "assistant" ||
        message.info.agent !== "auto" ||
        message.info.parentID !== user.info.id ||
        call?.type !== "tool" ||
        call.tool !== "chief_route" ||
        call.state.status !== "running" ||
        call.state.input.access !== input.access
      )
        throw new Error("Chief classification refinement requires the current pre-child invocation")
      const tasks = rows
        .slice(rows.indexOf(user) + 1)
        .flatMap((row) => row.parts)
        .filter((part) => part.type === "tool" && part.tool === "task")
      const saved = proofs(session.metadata)
      if (
        !tasks.length ||
        tasks.some(
          (part) =>
            part.type !== "tool" ||
            part.state.status !== "error" ||
            ![
              Refusal.access,
              Refusal.resume,
              "The selected specialist cannot perform the requested work class",
            ].includes(part.state.error) ||
            part.state.input.access !== input.access ||
            (part.state.error === Refusal.resume) !== (typeof part.state.input.task_id === "string") ||
            part.state.input.branch_id !== undefined ||
            part.state.metadata?.sessionId !== undefined ||
            !saved.some(
              (proof) =>
                proof.sessionID === session.id &&
                proof.userID === user.info.id &&
                proof.messageID === part.messageID &&
                proof.partID === part.id &&
                proof.callID === part.callID &&
                proof.access === input.access &&
                proof.resumeID === part.state.input.task_id &&
                proof.selectedAgent === decision.agent &&
                proof.contract === fingerprint(session.metadata),
            ),
        )
      )
        throw new Error("Chief classification refinement requires only a settled pre-child capability refusal")
      if (
        !tasks.some(
          (part) =>
            part.type === "tool" &&
            part.state.status === "error" &&
            [Refusal.access, "The selected specialist cannot perform the requested work class"].includes(
              part.state.error,
            ) &&
            part.state.input.task_id === undefined,
        )
      )
        throw new Error("Chief classification refinement requires a fresh capability refusal")
      for (const part of tasks) {
        if (part.type !== "tool" || part.state.status !== "error" || part.state.error !== Refusal.resume) continue
        const id = part.state.input.task_id
        if (typeof id !== "string") throw new Error("Missing Chief resume proof changed")
        const resumed = yield* input.sessions
          .get(SessionID.make(id))
          .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
        if (resumed) throw new Error("Missing Chief resume proof changed")
      }
      if (
        rows
          .slice(rows.indexOf(user) + 1)
          .some((row) => row.parts.some((part) => part.type === "tool" && part.tool === "chief_plan"))
      )
        throw new Error("Planned Chief work cannot be reclassified")
      if (
        (yield* ChiefRequestPlan.active(input.storage, session.id)) ||
        (yield* ChiefBranches.make(input.storage).read(session.id))
      )
        throw new Error("Saved Chief work cannot be reclassified")
      const children = yield* input.sessions.children(session.id)
      for (const child of children) {
        const identity = TaskName.read(child.metadata?.[TaskName.key])
        const parent = identity && rows.find((row) => row.info.id === identity.provenance.parentMessageID)
        if (!parent || parent.info.time.created >= user.info.time.created)
          throw new Error("Existing or unknown Chief child prevents reclassification")
      }
      return {
        version: 1 as const,
        userID: user.info.id,
        messageID: message.info.id,
        callID: input.ctx.callID,
        access: input.access,
        previous: fingerprint(session.metadata),
        refusals: tasks.map((part) => ({ messageID: part.messageID, partID: part.id })),
      }
    })
  }
}
