import { Effect, Schema } from "effect"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { ChiefRequestReview } from "@/kilocode/chief/request-review"
import type { RayaGoal } from "@/kilocode/goal"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"

type Metadata = { requestID: string; goalCreatedAt?: number; requestRevision?: string }

export function chiefSynthesizeTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  const parameters = Schema.Struct({
    summary: Schema.String,
    findings: Schema.Array(Schema.Struct({ branch_id: Schema.String, conclusion: Schema.String })),
  })
  return Tool.define<typeof parameters, Metadata, never>(
    "chief_synthesize",
    Effect.succeed({
      description:
        "After inspecting and reviewing every completed Chief branch, save one concise conclusion for each branch and a combined summary. Missing or failed work cannot be synthesized. This does not complete the goal.",
      parameters,
      execute: (input: typeof parameters.Type, ctx) =>
        Effect.gen(function* () {
          if (ctx.agent !== "auto") throw new Error("Only Auto Chief can synthesize its branches")
          const parent = yield* deps.sessions.get(ctx.sessionID)
          if (RayaChief.phase(parent.metadata) !== "task" && RayaChief.phase(parent.metadata) !== "goal")
            throw new Error("Auto Chief synthesis is unavailable in this phase")
          const request = yield* ChiefRequestPlan.active(deps.storage, ctx.sessionID)
          if (request) {
            const saved = yield* ChiefRequestReview.make(deps.storage, deps.sessions).synthesize({
              sessionID: ctx.sessionID,
              requestID: request.identity.requestID,
              revision: request.identity.revision,
              summary: input.summary,
              findings: input.findings.map((item) => ({ branchID: item.branch_id, conclusion: item.conclusion })),
            })
            return {
              title: "Chief branch synthesis saved",
              output: JSON.stringify({ summary: saved.summary, findings: saved.findings }, null, 2),
              metadata: { requestID: request.identity.requestID, requestRevision: request.identity.revision },
            }
          }
          const goal = yield* deps.goals.get(ctx.sessionID)
          const branches = ChiefBranches.make(deps.storage)
          const plan = yield* branches.read(ctx.sessionID)
          if (!plan || !ChiefBranches.matches(plan, goal))
            throw new Error("Auto Chief branch plan no longer matches the active request")
          const saved = yield* branches.synthesize({
            goalID: ctx.sessionID,
            goalCreatedAt: plan.goalCreatedAt,
            summary: input.summary,
            findings: input.findings.map((item) => ({ branchID: item.branch_id, conclusion: item.conclusion })),
          })
          return {
            title: "Chief branch synthesis saved",
            output: JSON.stringify({ summary: saved.summary, findings: saved.findings }, null, 2),
            metadata: { goalCreatedAt: plan.goalCreatedAt, requestID: plan.requestID },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
