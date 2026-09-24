import { Effect, Schema } from "effect"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefEdits } from "@/kilocode/chief/edits"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { ChiefRequestReview } from "@/kilocode/chief/request-review"
import type { RayaGoal } from "@/kilocode/goal"
import type { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"

type Metadata = { branchID: string; requestID: string; goalCreatedAt?: number; reviewedAt?: number }

export function chiefReviewTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  const parameters = Schema.Struct({
    branch_id: Schema.String,
    assessment: Schema.String,
    digest: Schema.optional(Schema.String),
    inspect: Schema.optional(Schema.Struct({ messageID: Schema.String, partID: Schema.String, callID: Schema.String })),
    evidence: Schema.Struct({ callID: Schema.String, messageID: Schema.String, partID: Schema.String }),
  })
  return Tool.define<typeof parameters, Metadata, never>(
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
          const request = yield* ChiefRequestPlan.active(deps.storage, ctx.sessionID)
          if (request) {
            if (!input.inspect) throw new Error("Chief request review needs the exact inspection tool reference")
            const plan = yield* ChiefRequestPlan.make(deps.storage, deps.sessions).load(ctx.sessionID)
            const branch = plan?.branches.find((item) => item.id === input.branch_id)
            if (!plan || !branch?.callID || !branch.sessionID || !branch.messageID)
              throw new Error("Chief request branch has no exact admitted child")
            const saved = yield* ChiefRequestReview.make(deps.storage, deps.sessions).review({
              sessionID: ctx.sessionID,
              requestID: plan.identity.requestID,
              revision: plan.identity.revision,
              branchID: branch.id,
              callID: branch.callID,
              childID: branch.sessionID,
              messageID: branch.messageID,
              inspect: { ...input.inspect, messageID: MessageID.make(input.inspect.messageID) },
              evidence: { ...input.evidence, messageID: MessageID.make(input.evidence.messageID) },
              assessment: input.assessment,
            })
            return {
              title: `${branch.name} reviewed`,
              output: `Accepted ${branch.name} with saved child evidence.`,
              metadata: { branchID: branch.id, requestID: plan.identity.requestID, reviewedAt: saved.review?.at },
            }
          }
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
                  (branch.access !== "edit" ||
                    (part.state.metadata?.digests as Record<string, string> | undefined)?.[branch.id] ===
                      input.digest) &&
                  part.state.time.end >= branch.updatedAt,
              ),
          )
          if (!inspected) throw new Error("Inspect the completed branch before reviewing it")
          if (branch.access === "edit") {
            if (branch.worktree?.phase !== "ready") throw new Error("Auto Chief edit worktree is not ready")
            const edits = yield* Effect.tryPromise(() =>
              ChiefEdits.preview({
                directory: branch.worktree!.directory,
                baseCommit: branch.worktree!.baseCommit,
                maxFiles: 20,
                maxBytes: 24 * 1024,
              }),
            )
            if (!edits.digest || edits.digest !== input.digest)
              throw new Error("Auto Chief edit changed after inspection or cannot be reviewed completely")
          }
          const saved = yield* branches.review({
            goalID: ctx.sessionID,
            goalCreatedAt: plan.goalCreatedAt,
            branchID: branch.id,
            callID: branch.callID,
            sessionID: branch.sessionID,
            evidence: input.evidence,
            digest: input.digest,
            assessment: input.assessment,
          })
          if (!saved.review) throw new Error("Auto Chief review receipt was not saved")
          return {
            title: `${branch.name} reviewed`,
            output: `Accepted ${branch.name} with saved child evidence.`,
            metadata: {
              branchID: branch.id,
              requestID: plan.requestID,
              goalCreatedAt: plan.goalCreatedAt,
              reviewedAt: saved.review.at,
            },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
