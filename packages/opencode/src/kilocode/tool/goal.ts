// raya_change - Milestone A bounded model-facing goal tools
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaGoal } from "@/kilocode/goal"
import { Update } from "@/kilocode/goal/plan"
import type { Session } from "@/session/session"
import { RayaChief } from "@/kilocode/chief"
import { associate } from "@/kilocode/goal/turn"
import type { SessionRunState } from "@/session/run-state"

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

export function goalTools(
  goals: Goals,
  sessions?: Pick<Session.Interface, "get" | "setMetadata">,
  runs?: Pick<SessionRunState.Interface, "inspect">,
) {
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
          Effect.tap(() => (runs ? associate(goals, runs, ctx.sessionID) : Effect.void)),
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
        "Read the current persistent goal, status, usage, audit, blocked reason, continuation progress, and the exact IDs of completed tool calls eligible as completion evidence. Evidence comes from recorded goal inputs and delegated inputs linked by saved task metadata. Unrelated work in reused child sessions and older task results without input lineage are excluded. Task handoff reports and child summaries do not prove completion; cite the underlying work or verification results. Artifact metadata is a recorded snapshot, not a current check; completion rechecks recorded read/write/edit/patch revisions and rejects stale or unverifiable files, including recreated deleted paths. A fresh read can verify the current file without editing it; partial-read fingerprints do not prove full content review.",
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
      description: `Finish, block, pause, or resume the active goal. To mark complete, derive every concrete requirement from the full objective and submit a requirement-by-requirement audit. Cite only eligible callIDs from this goal session or its descendants (get_goal lists them). Task handoff reports and child summaries are not completion evidence; cite their underlying work or verification results. Never cite unrelated sessions; never reuse evidence or done-when text from another project. Shape: { "status": "complete", "audit": { "summary": "<one line>", "requirements": [ { "requirement": "<what was done>", "passed": true, "evidence": [ { "callID": "<a real completed work/verification call>", "summary": "<what it proved>" } ] } ] } } — a top-level "requirements" array is also accepted. Every required criterion and every claimed success must pass and cite one or more real completed work or verification tool calls by callID; a saved criterion explicitly marked required=false may instead be reported passed=false with an empty evidence list. Include every saved criterion exactly once, and provide at least one requirement supported by verified work. Criteria marked review=true require a separate goal-control acceptance: a valid audit pauses the goal ready for review instead of completing it. Do not resume it merely to bypass that review. If a criterion requires human judgment but is not classified, pause and request the needed review instead of claiming that judgment is verified. include messageID only when it is available. Successful command evidence must have exit code 0. Missing, failed, uncertain, goal-control-only, or invented evidence is rejected and leaves the goal active. When honest progress is impossible, mark blocked with a plain reason. Pause (with a short reason) instead of grinding when you hit an approval wall or genuinely need the user to act; the goal stops auto-continuing until they resume, and mark active again to resume a paused or blocked goal. You cannot clear a goal.`,
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
                  goal.review?.status === "pending" ? "Goal ready for review" : succeeded[goal.status],
                  goal.review?.status === "pending"
                    ? "Evidence is ready for review. The goal is paused until its reviewed acceptance is recorded through goal controls."
                    : goal.status === "complete"
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

  const plan = Tool.define(
    "update_goal_plan",
    Effect.succeed({
      description:
        "Save the active goal's work plan. Read get_goal first and provide its intent and plan revision (null when absent). Preserve the full objective. Tasks need stable IDs, descriptions, outputs, owners, verification instructions and dependencies. Independent tasks may run together; dependencies must be completed before a task is in_progress or completed. Statuses and owners are recorded plan claims, not worker control or completion evidence. Updating the plan does not complete, resume or delegate the goal.",
      parameters: Update,
      execute: (input: typeof Update.Type, ctx) =>
        goals.plan(ctx.sessionID, input).pipe(
          Effect.match({
            onFailure: (err) => result("Goal plan not saved", failure(err)),
            onSuccess: (goal) => result("Goal plan saved", JSON.stringify(goal.plan), goal.status),
          }),
        ),
    }),
  )
  return { create, get, update, plan }
}
