import { Effect, Exit, Schema } from "effect"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import type { RayaGoal } from "@/kilocode/goal"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaChief } from "@/kilocode/chief"
import { TaskName } from "@/kilocode/tool/task-name"
import * as Tool from "@/tool/tool"

/** A planned child can leave a bounded note in its Chief's durable inbox. This does not wake the parent model. */
export function chiefMessageTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  const parameters = Schema.Struct({ text: Schema.String })
  type Metadata = { state: "delivered" | "unknown" | "refused"; receipt?: ChiefBranches.Note }
  return Tool.define<typeof parameters, Metadata, never>(
    "chief_message",
    Effect.succeed({
      description:
        "Save one short interim note to the parent Chief's durable inbox while this exact planned branch is running. The parent can read it with chief_inspect; this does not interrupt or wake the parent model.",
      parameters,
      execute: (input: typeof parameters.Type, ctx) =>
        Effect.gen(function* () {
          const refused = (reason: string) => ({
            title: "Chief note refused",
            output: reason,
            metadata: { state: "refused" as const },
          })
          if (!ctx.callID || !input.text.trim() || input.text.length > 1_500)
            return refused("A Chief note needs a stable call and 1 to 1,500 characters.")
          const child = yield* deps.sessions.get(ctx.sessionID)
          if (child.id !== ctx.sessionID || !child.parentID || ctx.agent === "auto")
            return refused("Only an admitted Chief child can send a note.")
          const parent = yield* deps.sessions.get(child.parentID)
          if (parent.id !== child.parentID) return refused("The parent session changed.")
          if (RayaChief.phase(parent.metadata) !== "task" && RayaChief.phase(parent.metadata) !== "goal")
            return refused("The parent Chief is no longer accepting branch notes.")
          const goal = yield* deps.goals.get(parent.id)
          const ledger = ChiefBranches.make(deps.storage)
          const plan = yield* ledger.read(parent.id)
          if (!plan || !ChiefBranches.matches(plan, goal)) return refused("The planned request changed.")
          const branch = plan.branches.find((item) => item.sessionID === child.id)
          if (
            !branch ||
            branch.state !== "admitted" ||
            branch.specialist !== ctx.agent ||
            !branch.callID ||
            !branch.messageID
          )
            return refused("This child is not the admitted running specialist.")
          const identity = TaskName.read(child.metadata?.[TaskName.key])
          if (
            !identity ||
            identity.provenance.parentSessionID !== parent.id ||
            identity.provenance.callID !== branch.callID ||
            identity.specialist !== branch.specialist
          )
            return refused("The child identity no longer matches its Chief task.")
          const rows = yield* deps.sessions.messages({ sessionID: child.id })
          const start = rows.findIndex((row) => row.info.role === "user" && row.info.id === branch.messageID)
          const end = rows.findIndex((row, index) => index > start && row.info.role === "user")
          const turn = rows.slice(start + 1, end < 0 ? undefined : end)
          if (
            start < 0 ||
            !turn.some(
              (row) =>
                row.info.role === "assistant" &&
                row.info.id === ctx.messageID &&
                row.parts.some(
                  (part) => part.type === "tool" && part.tool === "chief_message" && part.callID === ctx.callID,
                ),
            )
          )
            return refused("The note call is outside the admitted child input turn.")
          const id = `${ctx.messageID}:${ctx.callID}`
          const prior = plan.notes?.find((item) => item.id === id)
          if (prior && (prior.branchID !== branch.id || prior.text !== input.text.trim()))
            return refused("A Chief note call cannot be reused with different content.")
          if (!prior && (plan.notes ?? []).filter((item) => item.branchID === branch.id).length >= 8)
            return refused("This branch has reached its eight-note limit.")
          const request = {
            goalID: parent.id,
            goalCreatedAt: plan.goalCreatedAt,
            requestID: plan.requestID,
            branchID: branch.id,
            taskCallID: branch.callID,
            childSessionID: child.id,
            childMessageID: branch.messageID,
            senderMessageID: ctx.messageID,
            toolCallID: ctx.callID,
            text: input.text,
          }
          const saved = yield* ledger.note(request).pipe(Effect.exit)
          const current = Exit.isSuccess(saved)
            ? saved.value
            : (yield* ledger.read(parent.id).pipe(Effect.catch(() => Effect.succeed(undefined))))?.notes?.find(
                (item) => item.id === id,
              )
          if (!current)
            return {
              title: "Chief note outcome unknown",
              output: "The durable inbox outcome could not be confirmed. Do not resend this note automatically.",
              metadata: { state: "unknown" as const },
            }
          if (
            current.branchID !== branch.id ||
            current.childSessionID !== child.id ||
            current.childMessageID !== branch.messageID ||
            current.text !== input.text.trim()
          )
            return refused("A Chief note call has a conflicting saved receipt.")
          return {
            title: "Chief note saved",
            output: "Saved to the parent Chief's durable inbox. The parent can read it with chief_inspect.",
            metadata: { state: "delivered" as const, receipt: current },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
