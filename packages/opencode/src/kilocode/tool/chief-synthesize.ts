import { Effect, Schema } from "effect"
import { RayaChief } from "@/kilocode/chief"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { ChiefRequestReview } from "@/kilocode/chief/request-review"
import type { RayaGoal } from "@/kilocode/goal"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import { mutation } from "@/kilocode/goal/mutation"
import { gate } from "@/kilocode/session/input-gate"
import * as Tool from "@/tool/tool"

type Metadata = { requestID: string; goalCreatedAt?: number; requestRevision?: string }

export function chiefSynthesizeTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages" | "setMetadata">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  const parameters = Schema.Struct({
    summary: Schema.String,
    findings: Schema.Array(Schema.Struct({ branch_id: Schema.String, conclusion: Schema.String })),
  })
  const finish = Effect.fn("ChiefSynthesize.finish")(function* (ctx: Tool.Context) {
    const sessionID = ctx.sessionID
    const session = yield* deps.sessions.get(sessionID)
    if (RayaChief.phase(session.metadata) !== "task" && RayaChief.phase(session.metadata) !== "goal") return
    const request = RayaChief.request(session.metadata)
    if (ctx.callID && request) {
      yield* ChiefVerification.synthesis({
        storage: deps.storage,
        sessions: deps.sessions,
        goals: deps.goals,
        sessionID,
        messageID: ctx.messageID,
        callID: ctx.callID,
        request,
      })
      return
    }
    // Unbound legacy callers cannot mint a runtime observation or release synthesis.
    const user = (yield* deps.sessions.messages({ sessionID })).findLast(
      (row) => row.info.role === "user" && !!RayaChief.requestText(row.parts),
    )
    yield* mutation(
      deps.storage,
      sessionID,
      Effect.gen(function* () {
        const current = yield* deps.sessions.get(sessionID)
        const latest = (yield* deps.sessions.messages({ sessionID })).findLast(
          (row) => row.info.role === "user" && !!RayaChief.requestText(row.parts),
        )
        if (
          RayaChief.phase(current.metadata) !== RayaChief.phase(session.metadata) ||
          RayaChief.request(current.metadata) !== request ||
          latest?.info.id !== user?.info.id
        )
          throw new Error("Chief synthesis generation changed")
        yield* deps.sessions.setMetadata({
          sessionID,
          metadata: { ...current.metadata, [RayaChief.phaseKey]: "verify" },
        })
      }),
    ).pipe(gate.withLock(sessionID))
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
            yield* finish(ctx)
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
          yield* finish(ctx)
          return {
            title: "Chief branch synthesis saved",
            output: JSON.stringify({ summary: saved.summary, findings: saved.findings }, null, 2),
            metadata: { goalCreatedAt: plan.goalCreatedAt, requestID: plan.requestID },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
