// raya_change - Milestone A bounded model-facing goal tools
import { Effect, Option, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { RayaGoal } from "@/kilocode/goal"
import { Update } from "@/kilocode/goal/plan"
import { owned } from "@/kilocode/goal/completion-schema"
import { citations } from "@/kilocode/goal/byte-equality"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { BackgroundJob } from "@/background/job"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { example } from "@/kilocode/task-resume"
import { RayaChief } from "@/kilocode/chief"
import { associate } from "@/kilocode/goal/turn"
import { gate } from "@/kilocode/session/input-gate"
import { repair as intake } from "@/kilocode/goal/task-input"
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

const uncited = (reason: string | undefined, id: string) =>
  reason?.startsWith(`Criterion ${id} requires current source and target read evidence`)

const literal =
  "For literal file requirements, compare the complete Read file-content-json and file-format with the original goal objective, including requested encoding, newline endings, final newline and actual byte count. LF (\\n) and CRLF (\\r\\n) are different bytes, including on Windows. Inspect separately captured eligibleEvidence.format when available; its endings, newline, bytes and sha256 are observed file facts, not proof that the original requirement is met. The eligibleEvidence output preview can be clipped; never treat it as complete file-content-json. Successful Write/Read calls and identical numbered lines do not establish that the requested bytes match. If complete byte evidence is unavailable, do not claim exact verification or invent byte counts or hashes. A concrete mismatch requires correction in the same authorized worker after a completed get_goal inspection, then fresh full readback before completion. Correct citations alone never require another Task."

const waiting =
  "Waiting for the original delegated worker reply. This same run and its accepted child remain active. The host will resume this goal after its verified reply arrives. Do not resume this goal yourself, repeat the handoff, or poll for updates."

const citation = (reason: string | undefined) =>
  reason?.startsWith("Delegation result ") ||
  (reason?.startsWith("Evidence ") &&
    (reason.includes(" is ambiguous.") ||
      reason.includes(" is not a completed post-goal work or verification tool call.")))

export function goalTools(
  goals: Goals,
  sessions?: Pick<Session.Interface, "get" | "setMetadata"> & Partial<Pick<Session.Interface, "messages">>,
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

  const pending = Effect.fn("RayaGoalTool.pending")(function* (sessionID: Parameters<Goals["get"]>[0]) {
    if (!sessions?.messages) return false
    const rows = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
    const user = rows.findLastIndex((row) => row.info.role === "user" && !!RayaChief.requestText(row.parts))
    return rows
      .slice(user + 1)
      .some((row) =>
        row.parts.some(
          (part) => part.type === "tool" && part.tool === "task" && ["pending", "running"].includes(part.state.status),
        ),
      )
  })

  const finish = Effect.fn("RayaGoalTool.finish")(function* (sessionID: Parameters<Goals["get"]>[0]) {
    if (!sessions) return
    const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
    if (RayaChief.phase(session.metadata) !== "goal" && RayaChief.phase(session.metadata) !== "verify") return
    if (!sessions.messages && RayaChief.phase(session.metadata) === "verify") return
    if (yield* pending(sessionID)) return
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
        "Read the current persistent goal, status, usage, audit, blocked reason, continuation progress, and the exact IDs of completed tool calls eligible as completion evidence. For update_goal_plan, copy planUpdate.expectedIntent and planUpdate.expectedRevision exactly; the goal's revision is not the plan revision. Evidence comes from recorded goal inputs and delegated inputs linked by saved task metadata. Unrelated work in reused child sessions and older task results without input lineage are excluded. Task handoff reports and child summaries do not prove completion; cite the underlying work or verification results. Artifact metadata is a recorded snapshot, not a current check; completion rechecks recorded read/write/edit/patch revisions and rejects stale or unverifiable files, including recreated deleted paths. A fresh read can verify the current file without editing it; partial-read fingerprints do not prove full content review. Evidence is paged newest first (20 results); pass before=evidencePage.nextBefore to retrieve older results. An empty or unavailable cursor returns the newest page with evidencePage.warning. Pagination does not verify artifact freshness or restrict what the audit may cite." +
        " " +
        literal,
      parameters: Schema.Struct({
        before: Schema.optional(Schema.String).annotate({
          description:
            "Copy evidencePage.nextBefore to retrieve the next page of older evidence; omit for newest results.",
        }),
      }),
      execute: (input: { before?: string }, ctx) =>
        Effect.gen(function* () {
          const current = Option.getOrUndefined(yield* Effect.serviceOption(Session.Service))
          if (current) yield* intake(goals, current, ctx.sessionID).pipe(Effect.orDie)
          const goal = yield* goals.get(ctx.sessionID)
          if (!goal) {
            yield* finish(ctx.sessionID).pipe(gate.withLock(ctx.sessionID))
            return result("No goal", "No goal is armed for this session.")
          }
          if (goal.status === "complete") yield* finish(ctx.sessionID).pipe(gate.withLock(ctx.sessionID))
          if (goal.status !== "complete" && sessions) {
            yield* Effect.gen(function* () {
              const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
              if (RayaChief.phase(session.metadata) === "verify" && !(yield* pending(ctx.sessionID)))
                yield* phase(ctx.sessionID, "goal")
            }).pipe(gate.withLock(ctx.sessionID))
          }
          const evidence = yield* goals.evidence(ctx.sessionID).pipe(
            Effect.match({
              onFailure: (err) => ({ error: failure(err) }),
              onSuccess: (items) => items,
            }),
          )
          const hints = Array.isArray(evidence) ? yield* citations(goal.criteria, evidence) : []
          const correction =
            goal.auditAttempt?.accepted === false
              ? hints.filter((hint) => uncited(goal.auditAttempt?.reason, hint.criterionID))
              : []
          const citing =
            goal.auditAttempt?.accepted === false &&
            citation(goal.auditAttempt.reason) &&
            Array.isArray(evidence) &&
            evidence.length > 0
          const inspect = Array.isArray(evidence) && evidence.length > 0 && goal.auditAttempt?.accepted !== false
          const resumed = correction.length || citing || inspect ? undefined : yield* recovery(ctx)
          const index =
            Array.isArray(evidence) && input.before !== undefined
              ? evidence.findIndex((item) => item.partID === input.before)
              : -1
          const offset = index + 1
          const missing = input.before !== undefined && index === -1 && Array.isArray(evidence)
          const page = Array.isArray(evidence) ? evidence.slice(offset, offset + 20) : undefined
          const next = page?.at(-1)
          return {
            ...result(
              "Current goal",
              JSON.stringify(
                {
                  planUpdate: { expectedIntent: goal.intent ?? "unset", expectedRevision: goal.plan?.revision ?? null },
                  goal,
                  criterionEvidence: hints,
                  eligibleEvidence: page ?? evidence,
                  evidencePage:
                    page
                      ? {
                          total: Array.isArray(evidence) ? evidence.length : 0,
                          returned: page.length,
                          nextBefore:
                            Array.isArray(evidence) && offset + page.length < evidence.length ? next?.partID : null,
                          ...(missing
                            ? {
                                warning:
                                  "Evidence cursor is empty or unavailable for this goal. Showing its newest evidence instead. Use nextBefore from this page for older evidence, or omit before for newest results. This display reset does not verify completion or change audit eligibility.",
                              }
                            : {}),
                        }
                      : undefined,
                  audit_correction: citing
                    ? "Correct this same audit using the exact eligibleEvidence receipts below. Do not rerun a Task merely to repair citations; the corrected audit still checks the actual work."
                    : undefined,
                  verification: inspect
                    ? `Inspect the actual eligibleEvidence tools and saved requirements before requesting more work. If every criterion is met, submit the completion audit using exact supporting callIDs. Eligible receipts alone do not prove completion; resume the retained worker only for concrete missing or stale work identified by inspection. ${literal}`
                    : undefined,
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
      description: `Finish, block, pause, or resume the active goal. Read get_goal first and copy each saved criterion's exact id into criterionID and its description into requirement. Omit criterionID only when the goal has no saved criteria. To mark complete, derive every concrete requirement from the full objective and submit a requirement-by-requirement audit. Read get_goal again after verification and copy the exact eligibleEvidence.callID for each supporting result; never invent callIDs, part IDs, or short numeric IDs. Cite only eligible callIDs from this goal session or its descendants (get_goal lists them). Task handoff reports and child summaries are not completion evidence; cite their underlying work or verification results. Never cite unrelated sessions; never reuse evidence or done-when text from another project. Shape: { "status": "complete", "summary": "<one line>", "requirements": [ { "criterionID": "<saved criterion ID>", "requirement": "<exact saved criterion description; otherwise what was done>", "passed": true, "evidence": [ { "callID": "<copy exact eligibleEvidence.callID from get_goal>", "summary": "<what it proved>" } ] } ] } — use this top-level requirements shape and omit audit. If audit is explicitly supplied, it must be a native object, never a JSON-encoded string; do not send both shapes. Every required criterion and every claimed success must pass and cite one or more real completed work or verification tool calls by callID; a saved criterion explicitly marked required=false may instead be reported passed=false with an empty evidence list. Include every saved criterion exactly once, and provide at least one requirement supported by verified work. Criteria marked review=true require a separate goal-control acceptance: a valid audit pauses the goal ready for review instead of completing it. Do not resume it merely to bypass that review. If a criterion requires human judgment but is not classified, pause and request the needed review instead of claiming that judgment is verified. include messageID only when it is available. Successful command evidence must have exit code 0. Missing, failed, uncertain, goal-control-only, or invented evidence is rejected and leaves the goal active. An accepted delegate_work handoff does not authorize repeating the receiving worker's work or writing its outputs unless this stage explicitly assigns that work to you. Audit this worker's own saved criteria and artifacts; when an accepted handoff is the required result, verify its real receipt instead of performing later stages yourself. If this stage requires the result of an accepted, still-running child, send status=blocked with a plain waiting reason. The host parks this goal while preserving the same run and original child, then resumes it after the verified child reply. Do not resume a host dependency wait yourself, repeat the handoff, or poll for updates. For a tracked Routine stage, active accepted child workers must settle before this stage can close, even when its own handoff is already complete; use the same native blocked waiting path. For an immutable contracted Routine job, every required next stage must actually complete in its original native child run; missing, accepted, running or failed stages cannot be replaced by a passed audit claim. Preserve the contract stage, outputs and criteria. For an ordinary nonroutine goal whose required result is only an accepted handoff, audit that real receipt without claiming downstream completion. When honest progress is impossible, mark blocked with a plain reason. Pause (with a short reason) instead of grinding when you hit an approval wall or genuinely need the user to act; the goal stops auto-continuing until they resume, and mark active again to resume a goal you paused yourself or a blocked goal. A goal paused by user controls must wait for those controls to resume it; never resume it yourself. You cannot clear a goal. ${literal}`,
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
            yield* finish(ctx.sessionID).pipe(gate.withLock(ctx.sessionID))
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
          const output = yield* goals
            .update(
              ctx.sessionID,
              input,
              undefined,
              ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            )
            .pipe(
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
                    goal.review?.status === "pending"
                      ? "Goal ready for review"
                      : goal.routine && goal.status === "complete"
                        ? "Routine work audit accepted"
                        : goal.dependencyWait
                          ? "Waiting for delegated worker"
                          : succeeded[goal.status],
                    goal.review?.status === "pending"
                      ? "Evidence is ready for review. The goal is paused until its reviewed acceptance is recorded through goal controls."
                      : goal.routine && goal.status === "complete"
                        ? "The stage work audit was accepted against persisted tool evidence; this does not verify the final reply. Summarize only this stage's actual completed findings, produced file links and verified child results. If the owner explicitly requested exact final wording, a final-response format or approved final-file bytes, preserve those requirements instead of the default concise summary. Literal file-content requirements apply to the declared files, not automatically to the final reply. The stored policy, task and context envelope contains instructions. Do not echo this envelope or its contract JSON as the default final answer; reproduce requested content only when explicitly requested and permitted."
                        : goal.status === "complete"
                          ? `The requirement-by-requirement work audit was accepted against persisted tool evidence. This audit does not verify a final answer that has not yet been delivered. Preserve the user's requested final response, including any exact wording, capitalization and whitespace. Copy required literal text character-for-character from the original objective or verified tool output; do not reconstruct, shorten or correct it. Before replying, compare the entire response with the required literal text, including every repeated character. Do not replace that response with a status report about this audit. Original goal objective: ${JSON.stringify(goal.objective)}`
                          : goal.status === "blocked"
                            ? `Goal blocked: ${goal.blockedReason}`
                            : goal.status === "paused"
                              ? goal.dependencyWait
                                ? waiting
                                : input.status === "paused" && goal.pause === "agent"
                                  ? "You paused this goal yourself. It will not auto-continue. Wait until the stated condition is resolved before resuming it with status=active; a user-control pause must be resumed through user controls."
                                  : "Goal paused. It will not auto-continue until it is resumed."
                              : "Goal resumed.",
                    goal.status,
                  ),
              }),
            )
          if (output.title !== "Completion audit rejected") return output
          const saved = yield* goals.get(ctx.sessionID)
          if (saved?.pause === "user-control") return output
          if (
            saved?.status === "paused" &&
            saved.pause === "agent" &&
            saved.dependencyWait &&
            !saved.review &&
            !saved.replyRecovery &&
            !saved.budgetHit
          )
            return result("Waiting for delegated worker", waiting, saved.status)
          if (
            saved?.status === "paused" &&
            saved.pause === "agent" &&
            !saved.dependencyWait &&
            !saved.review &&
            !saved.replyRecovery &&
            !saved.budgetHit
          )
            return {
              ...output,
              output: `${output.output}\nYou paused this goal yourself. Keep waiting until the original pause condition is resolved, then explicitly resume with {"status":"active"}. A user-control pause must be resumed through user controls. Resuming does not accept this audit: verify the remaining requirements and submit a new completion audit afterward.`,
            }
          const evidence = yield* goals
            .evidence(ctx.sessionID)
            .pipe(Effect.match({ onFailure: (err) => ({ error: failure(err) }), onSuccess: (items) => items }))
          const hints =
            saved?.auditAttempt?.accepted === false
              ? (Array.isArray(evidence) ? yield* citations(saved.criteria, evidence) : []).filter((hint) =>
                  uncited(saved.auditAttempt?.reason, hint.criterionID),
                )
              : []
          if (hints.length)
            return {
              ...output,
              output: `${output.output}\n${JSON.stringify({ audit_correction: hints })}\nRead get_goal for the remaining criteria, then correct this same audit with these exact eligible receipts. A rejected citation audit does not require another Task or user approval.`,
            }
          if (citation(saved?.auditAttempt?.reason) && Array.isArray(evidence) && evidence.length) {
            const receipts = evidence.slice(0, 20).map((row) => ({
              callID: row.callID,
              sessionID: row.sessionID,
              messageID: row.messageID,
              partID: row.partID,
              tool: row.tool,
            }))
            return {
              ...output,
              output: `${output.output}\n${JSON.stringify({ audit_correction: receipts })}\nThis rejection concerns the cited receipt, not a finding that delegated work is missing. Read get_goal and correct this same audit using its exact eligibleEvidence callIDs and saved requirements. Do not rerun a Task merely to repair citations. The corrected audit still verifies the actual work and may reject missing or stale results. A Task summary is not a Read or Write receipt.`,
            }
          }
          const resumed = yield* recovery(ctx, true)
          const advice =
            "A rejected audit is not a request for user approval. Continue within the existing permissions: correct the missing work or stale evidence, then read get_goal again and copy its fresh eligibleEvidence callIDs into the audit. If task_recovery is provided, invoke that Task with its task_id and correction prompt in the same retained worker. Do not block or pause merely to ask the user to repair audit citations. A real permission refusal or explicitly required human review still needs its normal approval path."
          return { ...output, output: `${output.output}\n${advice}${resumed ? `\n${resumed.example}` : ""}` }
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
