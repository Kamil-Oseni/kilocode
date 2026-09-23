import { Effect, Schema } from "effect"
import type { Session } from "@/session/session"
import type { RayaGoal } from "@/kilocode/goal"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { RayaChief } from "@/kilocode/chief"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"

/** Intentionally unregistered until the bounded Chief review flow is complete. */
export function chiefInspectTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  return Tool.define(
    "chief_inspect",
    Effect.succeed({
      description:
        "Inspect saved Auto Chief branches, their actual completed replies and exact child tool evidence before reviewing results. This is read-only and does not start workers or accept work.",
      parameters: Schema.Struct({}),
      execute: (_input, ctx) =>
        Effect.gen(function* () {
          if (ctx.agent !== "auto") throw new Error("Only Auto Chief can inspect its branch plan")
          const parent = yield* deps.sessions.get(ctx.sessionID)
          if (RayaChief.phase(parent.metadata) !== "task" && RayaChief.phase(parent.metadata) !== "goal")
            throw new Error("Auto Chief branch inspection is unavailable in this phase")
          const goal = yield* deps.goals.get(ctx.sessionID)
          const plan = yield* ChiefBranches.make(deps.storage).read(ctx.sessionID)
          if (
            goal?.status !== "active" ||
            !plan ||
            goal.createdAt !== plan.goalCreatedAt ||
            goal.dispatch?.messageID !== plan.requestID
          )
            throw new Error("Auto Chief branch plan no longer matches the active request")
          const branches = []
          for (const item of plan.branches) {
            if (!item.sessionID) {
              branches.push({ id: item.id, name: item.name, specialist: item.specialist, state: item.state })
              continue
            }
            const child = yield* deps.sessions.get(item.sessionID)
            if (child.parentID !== ctx.sessionID) throw new Error("Auto Chief branch child lineage changed")
            const rows = yield* deps.sessions.messages({ sessionID: item.sessionID })
            const final = rows.findLastIndex(
              (row) =>
                row.info.role === "assistant" &&
                typeof row.info.time.completed === "number" &&
                row.parts.some((part) => part.type === "text" && part.text.trim().length > 0),
            )
            const report =
              final < 0
                ? undefined
                : rows[final]?.parts
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                    .trim()
                    .slice(0, 4_000)
            const evidence = rows
              .slice(0, final < 0 ? 0 : final + 1)
              .flatMap((row) =>
                row.parts.flatMap((part) =>
                  part.type === "tool" &&
                  part.state.status === "completed" &&
                  part.tool !== "task" &&
                  part.tool !== "chief_route"
                    ? [{ messageID: row.info.id, partID: part.id, callID: part.callID, tool: part.tool }]
                    : [],
                ),
              )
              .slice(0, 20)
            branches.push({
              id: item.id,
              name: item.name,
              specialist: item.specialist,
              access: item.access,
              state: item.state,
              reviewed: !!item.review,
              report,
              evidence,
            })
          }
          return {
            title: "Auto Chief branch results",
            output: JSON.stringify({ requestID: plan.requestID, branches }, null, 2),
            metadata: { goalCreatedAt: plan.goalCreatedAt, requestID: plan.requestID },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
