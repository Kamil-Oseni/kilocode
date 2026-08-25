// raya_change - Milestone A bounded model-facing goal tools
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaGoal } from "@/kilocode/goal"

type Goals = ReturnType<typeof RayaGoal.make>
type Metadata = { status?: RayaGoal.Status }

const result = (title: string, output: string, status?: RayaGoal.Status): Tool.ExecuteResult<Metadata> => ({
  title,
  metadata: status ? { status } : {},
  output,
})

const failure = (err: unknown) => {
  if (err instanceof RayaGoal.AuditError) return err.message
  if (err instanceof RayaGoal.ExistsError) return "A goal is already armed for this session. Get or clear it first."
  if (err instanceof RayaGoal.NotFoundError) return "No goal is armed for this session."
  return err instanceof Error ? err.message : String(err)
}

export function goalTools(goals: Goals) {
  const create = Tool.define(
    "create_goal",
    Effect.succeed({
      description:
        "Create one persistent goal for this session only when none exists. After creating it, perform concrete work in the same turn; never stop after merely creating or planning the goal.",
      parameters: RayaGoal.Create,
      execute: (input: typeof RayaGoal.Create.Type, ctx) =>
        goals.create(ctx.sessionID, input.objective).pipe(
          Effect.match({
            onFailure: (err) => result("Goal not created", failure(err)),
            onSuccess: (goal) => result("Goal armed", `Persistent goal armed: ${goal.objective}`, goal.status),
          }),
        ),
    }),
  )

  const get = Tool.define(
    "get_goal",
    Effect.succeed({
      description:
        "Read the current persistent goal, status, usage, audit, blocked reason, continuation progress, and the exact IDs of completed tool calls eligible as completion evidence.",
      parameters: Schema.Struct({}),
      execute: (_input: {}, ctx) =>
        Effect.gen(function* () {
          const goal = yield* goals.get(ctx.sessionID)
          if (!goal) return result("No goal", "No goal is armed for this session.")
          const evidence = yield* goals.evidence(ctx.sessionID).pipe(
            Effect.match({
              onFailure: (err) => ({ error: failure(err) }),
              onSuccess: (items) => items,
            }),
          )
          return result("Current goal", JSON.stringify({ goal, eligibleEvidence: evidence }, null, 2), goal.status)
        }),
    }),
  )

  const update = Tool.define(
    "update_goal",
    Effect.succeed({
      description: `Finish or block the active goal. To mark complete, derive every concrete requirement from the full objective and submit a requirement-by-requirement audit. Every requirement must pass and cite one or more real completed work or verification tool calls by callID; include messageID only when it is available. Successful command evidence must have exit code 0. Missing, failed, uncertain, goal-control-only, or invented evidence is rejected and leaves the goal active. When honest progress is impossible, mark blocked with a plain reason. You cannot pause, resume, or clear a goal.`,
      parameters: RayaGoal.ModelUpdate,
      execute: (input: RayaGoal.ModelUpdate, ctx) =>
        goals.update(ctx.sessionID, input).pipe(
          Effect.match({
            onFailure: (err) =>
              result(
                input.status === "complete" ? "Completion audit rejected" : "Goal not blocked",
                `${failure(err)} The goal remains active.`,
                "active",
              ),
            onSuccess: (goal) =>
              result(
                goal.status === "complete" ? "Goal complete" : "Goal blocked",
                goal.status === "complete"
                  ? "The requirement-by-requirement completion audit passed against persisted tool evidence."
                  : `Goal blocked: ${goal.blockedReason}`,
                goal.status,
              ),
          }),
        ),
    }),
  )

  return { create, get, update }
}
