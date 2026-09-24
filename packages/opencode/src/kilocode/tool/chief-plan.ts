import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefPlan } from "@/kilocode/chief/plan"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import type { RayaGoal } from "@/kilocode/goal"
import * as Tool from "@/tool/tool"

const Parameters = Schema.Struct({ proposals: Schema.Array(ChiefPlan.Proposal) })
type Metadata = { goalCreatedAt?: number; requestID: string; revision: string }

export function chiefPlanTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  agents: Pick<Agent.Interface, "get" | "list">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  return Tool.define<typeof Parameters, Metadata, never>(
    "chief_plan",
    Effect.succeed({
      description:
        "Propose two or three independent Auto Chief branches. Each needs distinct scope, exact specialist, bounded brief, and justified authority. Ordinary requests currently allow read-only branches; an active goal may also allow edit branches. This records a plan but does not start workers.",
      parameters: Parameters,
      execute: (input: typeof Parameters.Type, ctx) =>
        Effect.gen(function* () {
          if (ctx.agent !== "auto") throw new Error("Only Auto Chief can save a branch plan")
          const session = yield* deps.sessions.get(ctx.sessionID)
          if (RayaChief.phase(session.metadata) !== "task")
            throw new Error("Auto Chief can plan branches only during the task phase")
          const request = RayaChief.request(session.metadata)
          if (!request) throw new Error("Auto Chief has no saved user request")
          const goal = yield* deps.goals.get(ctx.sessionID)
          const rows = yield* deps.sessions.messages({ sessionID: ctx.sessionID })
          const latest = rows.filter((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts)).at(-1)
          if (!latest || latest.info.role !== "user" || RayaChief.requestText(latest.parts) !== request)
            throw new Error("Saved Auto Chief request does not match the bound user message")
          const parent = yield* deps.agents.get(ctx.agent)
          const rules = Permission.merge(parent.permission, session.permission ?? [])
          const agents = yield* deps.agents.list()
          if (!goal || goal.status === "complete") {
            const ledger = ChiefRequestPlan.make(deps.storage, deps.sessions)
            const prior = yield* ChiefRequestPlan.active(deps.storage, ctx.sessionID)
            if (prior && prior.identity.requestID !== latest.info.id)
              yield* ledger.rotate({
                sessionID: ctx.sessionID,
                priorRequestID: prior.identity.requestID,
                nextRequestID: latest.info.id,
              })
            const saved = yield* ledger.start({
              sessionID: ctx.sessionID,
              requestID: latest.info.id,
              proposals: input.proposals,
              agents,
              parent: rules,
            })
            return {
              title: "Auto Chief branches planned",
              output: JSON.stringify({ requestID: saved.identity.requestID, branches: saved.branches }, null, 2),
              metadata: { requestID: saved.identity.requestID, revision: saved.identity.revision },
            }
          }
          if (goal.status !== "active" || goal.dispatch?.messageID !== latest.info.id)
            throw new Error("Auto Chief goal does not match the bound user request")
          const branches = ChiefPlan.validate({ request, proposals: input.proposals, agents, parent: rules })
          const saved = yield* ChiefBranches.make(deps.storage).start({
            goalID: ctx.sessionID,
            goalCreatedAt: goal.createdAt,
            requestID: latest.info.id,
            branches,
          })
          return {
            title: "Auto Chief branches planned",
            output: JSON.stringify({ requestID: saved.requestID, branches: saved.branches }, null, 2),
            metadata: { goalCreatedAt: saved.goalCreatedAt, requestID: saved.requestID, revision: saved.revision },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
