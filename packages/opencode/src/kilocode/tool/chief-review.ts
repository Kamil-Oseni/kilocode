import { Effect, Schema } from "effect"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import type { RayaGoal } from "@/kilocode/goal"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"

/** Intentionally unregistered until the complete Chief fanout lifecycle is accepted. */
export function chiefReviewTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  const parameters = Schema.Struct({
    branch_id: Schema.String,
    assessment: Schema.String,
    evidence: Schema.Struct({ callID: Schema.String, messageID: Schema.String, partID: Schema.String }),
  })
  return Tool.define(
    "chief_review",
    Effect.succeed({
      description:
        "After inspecting a completed Auto Chief branch, accept its result only when the final reply satisfies the saved brief. Cite one exact completed child tool reference and record a concise assessment. This does not restart or edit the child.",
      parameters,
      execute: (input: typeof parameters.Type, ctx) =>
        Effect.gen(function* () {
          if (ctx.agent !== "auto") throw new Error("Only Auto Chief can review its branches")
          const parent = yield* deps.sessions.get(ctx.sessionID)
          if (RayaChief.phase(parent.metadata) !== "task" && RayaChief.phase(parent.metadata) !== "goal")
            throw new Error("Auto Chief can review branches only during its active task or goal phase")
          const goal = yield* deps.goals.get(ctx.sessionID)
          const branches = ChiefBranches.make(deps.storage, deps.sessions)
          const plan = yield* branches.read(ctx.sessionID)
          if (!plan || !ChiefBranches.matches(plan, goal))
            throw new Error("Auto Chief branch plan no longer matches the active request")
          const branch = plan.branches.find((item) => item.id === input.branch_id)
          if (!branch?.sessionID || !branch.callID || branch.state !== "completed")
            throw new Error("Only a completed, admitted Chief branch can be reviewed")
          const child = yield* deps.sessions.get(branch.sessionID)
          if (child.parentID !== ctx.sessionID) throw new Error("Auto Chief branch child lineage changed")
          const rows = yield* deps.sessions.messages({ sessionID: ctx.sessionID })
          const inspected = rows.some(
            (row) =>
              row.info.role === "assistant" &&
              row.parts.some(
                (part) =>
                  part.type === "tool" &&
                  part.tool === "chief_inspect" &&
                  part.state.status === "completed" &&
                  part.state.metadata?.requestID === plan.requestID &&
                  part.state.metadata?.goalCreatedAt === plan.goalCreatedAt &&
                  part.state.time.end >= branch.updatedAt,
              ),
          )
          if (!inspected) throw new Error("Inspect the completed branch before reviewing it")
          const saved = yield* branches.review({
            goalID: ctx.sessionID,
            goalCreatedAt: plan.goalCreatedAt,
            branchID: branch.id,
            callID: branch.callID,
            sessionID: branch.sessionID,
            evidence: input.evidence,
            assessment: input.assessment,
          })
          if (!saved.review) throw new Error("Auto Chief review receipt was not saved")
          return {
            title: `${branch.name} reviewed`,
            output: `Accepted ${branch.name} with saved child evidence.`,
            metadata: { branchID: branch.id, reviewedAt: saved.review.at },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
