// raya_change - Milestone A bounded model-facing goal tools
import { Effect, Option, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaGoal } from "@/kilocode/goal"
import { Update } from "@/kilocode/goal/plan"
import { owned } from "@/kilocode/goal/completion-schema"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { BackgroundJob } from "@/background/job"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { example } from "@/kilocode/task-resume"
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
  const recovery = Effect.fn("RayaGoalTool.recovery")(function* (ctx: Tool.Context, rejected = false) {
    if (ctx.agent !== "auto") return undefined
    const sessions = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
    const storage = Option.getOrUndefined(yield* Effect.serviceOption(Storage.Service))
    if (!sessions || !storage) return undefined
    const worker = yield* ChiefVerification.retained({
      sessions,
      storage,
      background: Option.getOrUndefined(yield* Effect.serviceOption(BackgroundJob.Service)),
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      agent: ctx.agent,
      planned: false,
    }).pipe(Effect.orDie)
    if (!worker) return undefined
    const goal = yield* goals.get(ctx.sessionID)
    const correction = rejected || worker.correction
    const exact = goal?.criteria?.some((criterion) => criterion.check?.kind === "byte-equality")
    return {
      task_id: worker.taskID,
      example: example(
        worker.taskID,
        correction
          ? exact
            ? "Correct the rejected completion audit in this same worker. Re-read the authorized source and saved target, preserve exact bytes including whether a final newline exists; do not add or remove one. Correct any mismatch and verify the actual saved result before claiming completion. For each byte-equality criterion, cite both current source and target successful Read callIDs together in that criterion's evidence array; a source citation under another criterion does not count. If the files already match, correct the audit citations without rewriting the files."
            : "Correct the rejected completion audit in this same assigned objective. Perform the missing authorized work and verify the actual results before claiming completion."
          : undefined,
      ),
    }
  })

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

  const finish = Effect.fn("RayaGoalTool.finish")(function* (sessionID: Parameters<Goals["get"]>[0]) {
    if (!sessions) return
    const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
    if (RayaChief.phase(session.metadata) !== "goal" && RayaChief.phase(session.metadata) !== "verify") return
    yield* phase(sessionID, "done")
  })

  const create = Tool.define(
    "create_goal",
    Effect.succeed({
      description:
        "Create one persistent goal for this session only when none exists. After creating it, perform concrete work in the same turn; never stop after merely creating or planning the goal.",
      parameters: RayaGoal.Create,
      execute: (input: typeof RayaGoal.Create.Type, ctx) =>
        goals.create(ctx.sessionID, input.objective, ctx.messageID, undefined, undefined, undefined, input.budget).pipe(
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
        "Read the current persistent goal, status, usage, audit, blocked reason, continuation progress, and the exact IDs of completed tool calls eligible as completion evidence. For update_goal_plan, copy planUpdate.expectedIntent and planUpdate.expectedRevision exactly; the goal's revision is not the plan revision. Evidence comes from recorded goal inputs and delegated inputs linked by saved task metadata. Unrelated work in reused child sessions and older task results without input lineage are excluded. Task handoff reports and child summaries do not prove completion; cite the underlying work or verification results. Artifact metadata is a recorded snapshot, not a current check; completion rechecks recorded read/write/edit/patch revisions and rejects stale or unverifiable files, including recreated deleted paths. A fresh read can verify the current file without editing it; partial-read fingerprints do not prove full content review.",
      parameters: Schema.Struct({}),
      execute: (_input: {}, ctx) =>
        Effect.gen(function* () {
          const goal = yield* goals.get(ctx.sessionID)
          if (!goal) {
            yield* phase(ctx.sessionID, "done")
            return result("No goal", "No goal is armed for this session.")
          }
          if (goal.status === "complete") yield* finish(ctx.sessionID)
          if (goal.status !== "complete" && sessions) {
            const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
            if (RayaChief.phase(session.metadata) === "verify") yield* phase(ctx.sessionID, "goal")
          }
          const evidence = yield* goals.evidence(ctx.sessionID).pipe(
            Effect.match({
              onFailure: (err) => ({ error: failure(err) }),
              onSuccess: (items) => items,
            }),
          )
          const resumed = yield* recovery(ctx)
          return {
            ...result(
              "Current goal",
              JSON.stringify(
                {
                  planUpdate: { expectedIntent: goal.intent ?? "unset", expectedRevision: goal.plan?.revision ?? null },
                  goal,
                  eligibleEvidence: evidence,
                  recovery: resumed,
                },
                null,
                2,
              ),
              goal.status,
            ),
            metadata: { status: goal.status, [GoalGate.key]: GoalGate.observation(goal, ctx.sessionID, ctx.messageID) },
          }
        }),
    }),
  )

  const update = Tool.define(
    "update_goal",
    Effect.succeed({
      description: `Finish, block, pause, or resume the active goal. Read get_goal first and copy each saved criterion's exact id into criterionID and its description into requirement. Omit criterionID only when the goal has no saved criteria. To mark complete, derive every concrete requirement from the full objective and submit a requirement-by-requirement audit. Read get_goal again after verification and copy the exact eligibleEvidence.callID for each supporting result; never invent callIDs, part IDs, or short numeric IDs. Cite only eligible callIDs from this goal session or its descendants (get_goal lists them). Task handoff reports and child summaries are not completion evidence; cite their underlying work or verification results. Never cite unrelated sessions; never reuse evidence or done-when text from another project. Shape: { "status": "complete", "summary": "<one line>", "requirements": [ { "criterionID": "<saved criterion ID>", "requirement": "<exact saved criterion description; otherwise what was done>", "passed": true, "evidence": [ { "callID": "<copy exact eligibleEvidence.callID from get_goal>", "summary": "<what it proved>" } ] } ] } — use this top-level requirements shape and omit audit. If audit is explicitly supplied, it must be a native object, never a JSON-encoded string; do not send both shapes. Every required criterion and every claimed success must pass and cite one or more real completed work or verification tool calls by callID; a saved criterion explicitly marked required=false may instead be reported passed=false with an empty evidence list. Include every saved criterion exactly once, and provide at least one requirement supported by verified work. Criteria marked review=true require a separate goal-control acceptance: a valid audit pauses the goal ready for review instead of completing it. Do not resume it merely to bypass that review. If a criterion requires human judgment but is not classified, pause and request the needed review instead of claiming that judgment is verified. include messageID only when it is available. Successful command evidence must have exit code 0. Missing, failed, uncertain, goal-control-only, or invented evidence is rejected and leaves the goal active. When honest progress is impossible, mark blocked with a plain reason. Pause (with a short reason) instead of grinding when you hit an approval wall or genuinely need the user to act; the goal stops auto-continuing until they resume, and mark active again to resume a paused or blocked goal. You cannot clear a goal.`,
      parameters: RayaGoal.ModelUpdate,
      jsonSchema: GoalGate.owned(owned(ToolJsonSchema.fromSchema(RayaGoal.ModelUpdate), goals.get), goals.get),
      execute: (input: RayaGoal.ModelUpdate, ctx) =>
        Effect.gen(function* () {
          const current = yield* goals.get(ctx.sessionID)
          if (current?.completion === "reply")
            return result(
              "Reply directly",
              "This worker conversation records the assistant's written reply automatically. Answer the message directly without update_goal.",
              current.status,
            )
          if (current?.status === "complete") {
            yield* finish(ctx.sessionID)
            return result(
              "Goal already complete",
              "The prior goal is complete. Handle the current user request directly without updating or reopening that goal. Do not ask about the completed goal unless the user explicitly requests a change to it.",
              current.status,
            )
          }
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
            Effect.tap(() => phase(ctx.sessionID, "done")),
            Effect.match({
              onFailure: (err) =>
                result(
                  rejected[input.status],
                  `${failure(err)} The goal status remains ${current?.status ?? "unarmed"}.`,
                  current?.status,
                ),
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
          if (output.title !== "Completion audit rejected") return output
          const resumed = yield* recovery(ctx, true)
          return resumed ? { ...output, output: `${output.output}\n${resumed.example}` } : output
        }),
    }),
  )

  const plan = Tool.define(
    "update_goal_plan",
    Effect.succeed({
      description:
        "Save the active goal's work plan. Read get_goal first and copy its planUpdate.expectedIntent and planUpdate.expectedRevision exactly. The goal's revision is not the plan revision; expectedRevision is null when goal.plan is absent. Preserve the full objective. Tasks need stable IDs, descriptions, outputs, owners, verification instructions and dependencies. Independent tasks may run together; dependencies must be completed before a task is in_progress or completed. Statuses and owners are recorded plan claims, not worker control or completion evidence. Updating the plan does not complete, resume or delegate the goal.",
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
