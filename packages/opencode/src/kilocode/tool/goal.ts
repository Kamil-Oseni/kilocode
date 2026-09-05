// raya_change - Milestone A bounded model-facing goal tools
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaGoal } from "@/kilocode/goal"
import type { Session } from "@/session/session"
import { RayaChief } from "@/kilocode/chief"

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

export function goalTools(goals: Goals, sessions?: Pick<Session.Interface, "get" | "setMetadata">) {
  const phase = Effect.fn("RayaGoalTool.phase")(function* (
    sessionID: Parameters<Goals["get"]>[0],
    value: RayaChief.Phase,
  ) {
    if (!sessions) return
    const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
    yield* sessions
      .setMetadata({
        sessionID,
        metadata: { ...session.metadata, [RayaChief.phaseKey]: value },
      })
      .pipe(Effect.orDie)
  }) // raya_change - goal tool outcomes deterministically release Auto's final synthesis step

  const create = Tool.define(
    "create_goal",
    Effect.succeed({
      description:
        "Create one persistent goal for this session only when none exists. After creating it, perform concrete work in the same turn; never stop after merely creating or planning the goal.",
      parameters: RayaGoal.Create,
      execute: (input: typeof RayaGoal.Create.Type, ctx) =>
        goals.create(ctx.sessionID, input.objective, ctx.messageID).pipe(
          // raya_change - preserve discard checkpoint for tool-created goals
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
          if (!goal) {
            yield* phase(ctx.sessionID, "done")
            return result("No goal", "No goal is armed for this session.")
          }
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
      description: `Finish, block, pause, or resume the active goal. To mark complete, derive every concrete requirement from the full objective and submit a requirement-by-requirement audit. Cite only eligible callIDs from this session (get_goal lists them); never reuse evidence or done-when text from another project. Shape: { "status": "complete", "audit": { "summary": "<one line>", "requirements": [ { "requirement": "<what was done>", "passed": true, "evidence": [ { "callID": "<a real completed work/verification call>", "summary": "<what it proved>" } ] } ] } } — a top-level "requirements" array is also accepted. Every requirement must pass and cite one or more real completed work or verification tool calls by callID; include messageID only when it is available. Successful command evidence must have exit code 0. Missing, failed, uncertain, goal-control-only, or invented evidence is rejected and leaves the goal active. When honest progress is impossible, mark blocked with a plain reason. Pause (with a short reason) instead of grinding when you hit an approval wall or genuinely need the user to act; the goal stops auto-continuing until they resume, and mark active again to resume a paused or blocked goal. You cannot clear a goal.`,
      parameters: RayaGoal.ModelUpdate,
      execute: (input: RayaGoal.ModelUpdate, ctx) =>
        Effect.gen(function* () {
          const rejected: Record<RayaGoal.ModelUpdate["status"], string> = {
            complete: "Completion audit rejected",
            blocked: "Goal not blocked",
            paused: "Goal not paused",
            active: "Goal not resumed",
          }
          const succeeded: Record<RayaGoal.Status, string> = {
            complete: "Goal complete",
            blocked: "Goal blocked",
            paused: "Goal paused",
            active: "Goal resumed",
          }
          const output = yield* goals.update(ctx.sessionID, input).pipe(
            Effect.match({
              onFailure: (err) => result(rejected[input.status], `${failure(err)} The goal remains active.`, "active"),
              onSuccess: (goal) =>
                result(
                  succeeded[goal.status],
                  goal.status === "complete"
                    ? "The requirement-by-requirement completion audit passed against persisted tool evidence."
                    : goal.status === "blocked"
                      ? `Goal blocked: ${goal.blockedReason}`
                      : goal.status === "paused"
                        ? "Goal paused. It will not auto-continue until it is resumed."
                        : "Goal resumed.",
                  goal.status,
                ),
            }),
          )
          yield* phase(ctx.sessionID, "done")
          return output
        }),
    }),
  )

  return { create, get, update }
}
