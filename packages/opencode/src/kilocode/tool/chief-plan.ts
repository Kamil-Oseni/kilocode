import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import type { Session } from "@/session/session"
import type { Storage } from "@/storage/storage"
import { RayaChief } from "@/kilocode/chief"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefPlan } from "@/kilocode/chief/plan"
import type { RayaGoal } from "@/kilocode/goal"
import * as Tool from "@/tool/tool"

const Parameters = Schema.Struct({ proposals: Schema.Array(ChiefPlan.Proposal) })
type Metadata = { goalCreatedAt: number; requestID: string }

/** Kept out of the tool registry until the full fanout and synthesis lifecycle is accepted. */
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
        "Propose two or three independent Auto Chief branches. Each proposal needs a distinct scope, exact specialist, bounded brief, and read or edit authority. The request and goal identities come from saved state; this tool only records a plan and does not start workers.",
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
          if (goal?.status !== "active" || !goal.dispatch?.messageID)
            throw new Error("Auto Chief needs an active goal bound to a user request")
          const rows = yield* deps.sessions.messages({ sessionID: ctx.sessionID })
          const user = rows.filter((row) => row.info.role === "user").at(-1)
          if (user?.info.id !== goal.dispatch.messageID || RayaChief.requestText(user.parts) !== request)
            throw new Error("Saved Auto Chief request does not match the bound user message")
          const parent = yield* deps.agents.get(ctx.agent)
          const rules = Permission.merge(parent.permission, session.permission ?? [])
          const agents = yield* deps.agents.list()
          const branches = ChiefPlan.validate({ request, proposals: input.proposals, agents, parent: rules })
          const saved = yield* ChiefBranches.make(deps.storage).start({
            goalID: ctx.sessionID,
            goalCreatedAt: goal.createdAt,
            requestID: user.info.id,
            branches,
          })
          return {
            title: "Auto Chief branches planned",
            output: JSON.stringify({ requestID: saved.requestID, branches: saved.branches }, null, 2),
            metadata: { goalCreatedAt: saved.goalCreatedAt, requestID: saved.requestID },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
