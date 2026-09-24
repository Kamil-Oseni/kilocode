import { Effect, Schema } from "effect"
import type { Session } from "@/session/session"
import type { RayaGoal } from "@/kilocode/goal"
import { ChiefBranches } from "@/kilocode/chief/branches"
import { ChiefEdits } from "@/kilocode/chief/edits"
import { ChiefRequestPlan } from "@/kilocode/chief/request-plan"
import { ChiefRequestReview } from "@/kilocode/chief/request-review"
import { RayaChief } from "@/kilocode/chief"
import type { Storage } from "@/storage/storage"
import * as Tool from "@/tool/tool"

type Metadata = {
  requestID: string
  goalCreatedAt?: number
  requestRevision?: string
  digests?: Record<string, string>
}

export function chiefInspectTool(deps: {
  storage: Storage.Interface
  sessions: Pick<Session.Interface, "get" | "messages">
  goals: Pick<ReturnType<typeof RayaGoal.make>, "get">
}) {
  return Tool.define<Schema.Struct<{}>, Metadata, never>(
    "chief_inspect",
    Effect.succeed({
      description:
        "Inspect saved Auto Chief branches, their actual completed replies and exact child tool evidence before reviewing results. Reconcile a provably stopped admitting backend as unknown; never replay its child.",
      parameters: Schema.Struct({}),
      execute: (_input, ctx) =>
        Effect.gen(function* () {
          if (ctx.agent !== "auto") throw new Error("Only Auto Chief can inspect its branch plan")
          const parent = yield* deps.sessions.get(ctx.sessionID)
          if (RayaChief.phase(parent.metadata) !== "task" && RayaChief.phase(parent.metadata) !== "goal")
            throw new Error("Auto Chief branch inspection is unavailable in this phase")
          const request = yield* ChiefRequestPlan.active(deps.storage, ctx.sessionID)
          if (request) {
            const view = yield* ChiefRequestReview.make(deps.storage, deps.sessions).inspect(ctx.sessionID)
            return {
              title: "Auto Chief branch results",
              output: JSON.stringify(view),
              metadata: { requestID: view.identity.requestID, requestRevision: view.identity.revision },
            }
          }
          const goal = yield* deps.goals.get(ctx.sessionID)
          const ledger = ChiefBranches.make(deps.storage, deps.sessions)
          const plan = yield* ledger.read(ctx.sessionID)
          if (!plan || !ChiefBranches.matches(plan, goal))
            throw new Error("Auto Chief branch plan no longer matches the active request")
          const current = yield* ledger.reconcile(ctx.sessionID, plan.goalCreatedAt, plan.revision)
          const branches = []
          const digests: Record<string, string> = {}
          for (const item of current.branches) {
            const edits =
              item.access === "edit" && item.worktree?.phase === "ready"
                ? yield* Effect.tryPromise(() =>
                    ChiefEdits.preview({
                      directory: item.worktree!.directory,
                      baseCommit: item.worktree!.baseCommit,
                      maxFiles: 20,
                      maxBytes: 24 * 1024,
                    }),
                  )
                : undefined
            if (edits?.digest) digests[item.id] = edits.digest
            if (!item.sessionID) {
              branches.push({
                id: item.id,
                name: item.name,
                specialist: item.specialist,
                access: item.access,
                scope: item.scope,
                independence: item.independence,
                authority: item.authority,
                state: item.state,
                notes: (current.notes ?? []).filter((note) => note.branchID === item.id),
                edits,
              })
              continue
            }
            const child = yield* deps.sessions.get(item.sessionID)
            if (child.parentID !== ctx.sessionID) throw new Error("Auto Chief branch child lineage changed")
            const rows = yield* deps.sessions.messages({ sessionID: item.sessionID })
            const turn = ChiefBranches.turn(rows, item.messageID)
            const report = turn?.reply.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
              .trim()
              .slice(0, 4_000)
            const evidence = (turn?.rows ?? [])
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
              scope: item.scope,
              independence: item.independence,
              authority: item.authority,
              state: item.state,
              notes: (current.notes ?? []).filter((note) => note.branchID === item.id),
              callID: item.callID,
              reviewed: !!item.review,
              edits,
              integration: item.worktree?.integration?.phase,
              report,
              evidence,
            })
          }
          return {
            title: "Auto Chief branch results",
            output: JSON.stringify({ requestID: plan.requestID, branches }, null, 2),
            metadata: { goalCreatedAt: plan.goalCreatedAt, requestID: plan.requestID, digests },
          }
        }).pipe(Effect.orDie),
    }),
  )
}
