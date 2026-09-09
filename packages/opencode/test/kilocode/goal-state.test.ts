// raya_change - Milestone A goal persistence, audit, and continuation eligibility
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RayaGoal } from "@/kilocode/goal"
import { mutation } from "@/kilocode/goal/mutation"
import { gate } from "@/kilocode/session/input-gate"
import { receipts } from "@/kilocode/goal/stop-receipt"
import { settle } from "@/kilocode/goal/owned-jobs"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { observer, closing, binding } from "@/kilocode/goal/turn"
import { Runner } from "@/effect/runner"
import { observe } from "@/kilocode/effect/observation"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Git } from "@/git"
import { ProjectV2 } from "@opencode-ai/core/project"
import * as ToolJsonSchema from "@/tool/json-schema"
import { testEffect } from "../lib/effect"
import { pollWithTimeout } from "../lib/effect"
import type { Bus } from "@/bus"
import { tmpdirScoped } from "../fixture/fixture"
import * as Artifact from "@/kilocode/goal/artifact"
import { digest } from "@opencode-ai/core/kilocode/evidence-digest"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node, Git.node])))

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("goal-model"),
}

function transcript(input: {
  sessionID: SessionID
  tool?: string
  exit?: number
  output?: string
  text?: string
  metadata?: Record<string, unknown>
}) {
  const user: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "code",
    model,
  }
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    parentID: user.id,
    sessionID: input.sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    agent: "code",
    mode: "code",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: model.providerID,
    modelID: model.modelID,
    finish: "stop",
  }
  const part: MessageV2.ToolPart | undefined = input.tool
    ? {
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "tool",
        callID: crypto.randomUUID(),
        tool: input.tool,
        state: {
          status: "completed",
          input: {},
          output: input.output ?? (input.exit === 0 ? "all checks passed" : "check failed"),
          title: "verification",
          metadata: { exit: input.exit, ...input.metadata },
          time: { start: Date.now(), end: Date.now() },
        },
      }
    : undefined
  const text: MessageV2.TextPart | undefined = input.text
    ? {
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: input.sessionID,
        type: "text",
        text: input.text,
        time: { start: Date.now(), end: Date.now() },
      }
    : undefined
  const rows: MessageV2.WithParts[] = [
    { info: user, parts: [] },
    { info: assistant, parts: [...(part ? [part] : []), ...(text ? [text] : [])] },
  ]
  return { rows, part }
}

function setup(
  storage: Storage.Interface,
  rows: () => MessageV2.WithParts[],
  opts?: {
    // raya_change - model subagent child sessions: messagesFor branches on id,
    // children returns the descendants that hold the delegated tool calls.
    messagesFor?: (id: SessionID) => MessageV2.WithParts[]
    children?: (id: SessionID) => Session.Info[]
  },
) {
  return RayaGoal.make({
    storage,
    sessions: {
      messages: (input) => Effect.succeed(opts?.messagesFor ? opts.messagesFor(input.sessionID) : rows()),
      children: (id) => Effect.succeed(opts?.children ? opts.children(id) : []),
    },
  })
}

describe("RayaGoal", () => {
  it.live("human review requires current acceptance and revalidates evidence", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_review_${crypto.randomUUID()}`)
      const rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const initial = yield* goals.create(sessionID, "Review result", undefined, undefined, undefined, [
        { id: "result", description: "Result", verification: "Check result", review: true },
      ])
      const result = transcript({ sessionID, tool: "bash", exit: 0 })
      rows.push(...result.rows)
      const audit = {
        summary: "Result checked",
        requirements: [
          {
            criterionID: "result",
            requirement: "Result",
            passed: true,
            evidence: [{ callID: result.part!.callID, summary: "Checks passed" }],
          },
        ],
      }
      const pending = yield* goals.update(sessionID, { status: "complete", audit })
      expect(pending.status).toBe("paused")
      expect(pending.review).toMatchObject({ status: "pending", criteria: ["result"] })
      expect(pending.intent).not.toBe(initial.intent)
      expect((yield* goals.edit(sessionID, { accept: true }).pipe(Effect.flip)).message).toBeTruthy()
      expect(
        (yield* goals.edit(sessionID, { accept: true, expectedIntent: initial.intent! }).pipe(Effect.flip)).message,
      ).toBeTruthy()
      expect(
        (yield* goals
          .edit(sessionID, { accept: true, expectedIntent: pending.intent!, status: "active" })
          .pipe(Effect.flip)).message,
      ).toBeTruthy()
      expect((yield* goals.update(sessionID, { status: "complete", audit }).pipe(Effect.flip)).message).toBeTruthy()
      yield* goals.update(sessionID, { status: "active" })
      const again = yield* goals.update(sessionID, { status: "complete", audit })
      expect(again.status).toBe("paused")
      const part = result.part!
      if (part.state.status !== "completed") throw new Error("Expected completed fixture")
      part.state.metadata.exit = 1
      expect(
        (yield* goals.edit(sessionID, { accept: true, expectedIntent: again.intent! }).pipe(Effect.flip)).message,
      ).toBeTruthy()
      expect((yield* goals.get(sessionID))?.status).toBe("paused")
      part.state.metadata.exit = 0
      const output = part.state.output
      part.state.output = "A different successful result"
      expect(
        (yield* goals.edit(sessionID, { accept: true, expectedIntent: again.intent! }).pipe(Effect.flip)).message,
      ).toContain("Evidence changed")
      part.state.output = output
      const accepted = yield* goals.edit(sessionID, { accept: true, expectedIntent: again.intent! })
      expect(accepted.state.status).toBe("complete")
      expect(accepted.state.review).toMatchObject({
        status: "accepted",
        criteria: ["result"],
        acceptedAt: expect.any(Number),
      })
      expect((yield* setup(storage, () => rows).get(sessionID))?.review).toEqual(accepted.state.review)
      const next = yield* goals.create(sessionID, "Next result")
      expect(next.review).toBeUndefined()
      expect(next.history?.[0].review).toEqual(accepted.state.review)
    }),
  )
  it.live("optional criteria retain accountability without weakening verified completion", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const mode of [
        "missing",
        "required-failed",
        "optional-claim",
        "optional-failed-evidence",
        "optional-unverified",
        "all-unverified",
        "optional-passed",
      ]) {
        const sessionID = SessionID.make(`ses_optional_${crypto.randomUUID()}`)
        const rows: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Deliver the required result", undefined, undefined, undefined, [
          {
            id: "required",
            description: "Required result",
            verification: "Run checks",
            ...(mode === "all-unverified" ? { required: false } : {}),
          },
          { id: "optional", description: "Optional improvement", verification: "Run checks", required: false },
        ])
        const result = transcript({ sessionID, tool: "bash", exit: 0 })
        rows.push(...result.rows)
        const evidence = [{ callID: result.part!.callID, summary: "Checks passed" }]
        const requirement = {
          criterionID: "required",
          requirement: "Required result",
          passed: mode !== "required-failed" && mode !== "all-unverified",
          evidence: mode === "all-unverified" ? [] : evidence,
        }
        const optional = {
          criterionID: "optional",
          requirement: "Optional improvement",
          passed: mode === "optional-claim" || mode === "optional-passed",
          evidence: mode === "optional-failed-evidence" || mode === "optional-passed" ? evidence : [],
        }
        const operation = goals.update(sessionID, {
          status: "complete",
          audit: {
            summary: "Required result checked; optional status recorded",
            requirements: mode === "missing" ? [requirement] : [requirement, optional],
          },
        })
        if (mode !== "optional-unverified" && mode !== "optional-passed") {
          const error = yield* operation.pipe(Effect.flip)
          expect(error.message).toBeTruthy()
          expect((yield* goals.get(sessionID))?.status).toBe("active")
          continue
        }
        const completed = yield* operation
        expect(completed.status).toBe("complete")
        expect(completed.audit?.requirements[1].passed).toBe(mode === "optional-passed")
        expect(completed.audit?.requirements[1].evidence.length).toBe(mode === "optional-passed" ? 1 : 0)
        const reloaded = yield* setup(storage, () => rows).get(sessionID)
        expect(reloaded?.criteria?.[1].required).toBe(false)
        expect(reloaded?.audit).toEqual(completed.audit)
        const next = yield* goals.create(sessionID, "Next objective")
        expect(next.history?.[0].criteria?.[1].required).toBe(false)
      }
    }),
  )
  it.live("criteria edits require current intent, invalidate audits and flag the plan for review", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_criteria_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const criteria = [{ id: "result", description: "Original result", verification: "Inspect output" }]
      const goal = yield* goals.create(sessionID, "Full objective", undefined, undefined, undefined, criteria)
      const planned = yield* goals.plan(sessionID, {
        expectedIntent: goal.intent!,
        expectedRevision: null,
        tasks: [
          {
            id: "work",
            description: "Do work",
            owner: "code",
            output: "Result",
            verification: "Review result",
            status: "pending",
            dependencies: [],
          },
        ],
      })
      yield* goals
        .update(sessionID, {
          status: "complete",
          audit: {
            summary: "Unverified",
            requirements: [{ criterionID: "result", requirement: "Original result", passed: false, evidence: [] }],
          },
        })
        .pipe(Effect.flip)
      expect((yield* goals.get(sessionID))?.auditAttempt).toBeDefined()
      const next = [{ ...criteria[0], description: "Expanded result", verification: "Run the acceptance checks" }]
      expect((yield* goals.edit(sessionID, { criteria: next }).pipe(Effect.flip)).message).toContain("revision")
      const edited = yield* goals.edit(sessionID, { criteria: next, expectedIntent: goal.intent! })
      expect(edited.state.objective).toBe(goal.objective)
      expect(edited.state.criteria).toEqual(next)
      expect(edited.state.intent).not.toBe(goal.intent)
      expect(edited.state.auditAttempt).toBeUndefined()
      expect(edited.state.revisions).toHaveLength(1)
      expect(edited.state.revisions?.[0]).toMatchObject({
        objective: goal.objective,
        criteria,
        intent: goal.intent,
        source: "control",
        plan: planned.plan,
        auditAttempt: { accepted: false },
      })
      expect(edited.state.plan?.review).toBe(true)
      expect((yield* setup(storage, () => []).get(sessionID))?.criteria).toEqual(next)
      expect(yield* goals.edit(sessionID, { criteria, expectedIntent: goal.intent! }).pipe(Effect.flip)).toMatchObject({
        conflict: true,
      })
      const same = yield* goals.edit(sessionID, { criteria: next, expectedIntent: edited.state.intent! })
      expect(same.state.intent).toBe(edited.state.intent)
      expect(same.state.revisions).toEqual(edited.state.revisions)
      expect(
        (yield* goals.edit(sessionID, { criteria: [], expectedIntent: edited.state.intent! }).pipe(Effect.flip))
          .message,
      ).toContain("valid IDs")
      expect(
        (yield* goals
          .edit(sessionID, { criteria: [next[0], next[0]], expectedIntent: edited.state.intent! })
          .pipe(Effect.flip)).message,
      ).toContain("unique")
      const reviewed = yield* goals.plan(sessionID, {
        tasks: planned.plan!.tasks,
        expectedIntent: edited.state.intent!,
        expectedRevision: planned.plan!.revision,
      })
      expect(reviewed.plan?.review).toBeUndefined()
      expect(reviewed.plan?.revision).not.toBe(planned.plan?.revision)
      const steered = yield* goals.revise(sessionID, "Expanded full objective")
      expect(steered.revisions).toHaveLength(2)
      expect(steered.revisions?.[1]).toMatchObject({ objective: goal.objective, criteria: next, source: "steering" })
      expect(steered.revisions?.[0]).toEqual(edited.state.revisions?.[0])
      expect((yield* setup(storage, () => []).get(sessionID))?.revisions).toEqual(steered.revisions)
      const paused = yield* goals.edit(sessionID, { status: "paused", expectedIntent: steered.intent! })
      expect(paused.state.revisions).toEqual(steered.revisions)
      yield* storage.replace(["raya", "goal", sessionID], { ...paused.state, status: "complete" })
      const replacement = yield* goals.create(sessionID, "Next goal")
      expect(replacement.revisions).toBeUndefined()
      expect(replacement.history?.at(-1)?.revisions).toEqual(steered.revisions)
    }),
  )
  it.live("goal plans persist parallel work, reject stale revisions, and preserve objective ownership", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_plan_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const goal = yield* goals.create(sessionID, "Complete the full objective")
      const task = {
        description: "Inspect source",
        output: "Findings",
        owner: "code",
        verification: "Review source",
        status: "in_progress" as const,
        dependencies: [],
      }
      const tasks = [
        { ...task, id: "source" },
        { ...task, id: "tests", description: "Inspect tests" },
      ]
      const saved = yield* goals.plan(sessionID, { expectedIntent: goal.intent!, expectedRevision: null, tasks })
      expect(saved.plan?.tasks).toEqual(tasks)
      expect(saved.plan?.objective).toBe(goal.objective)
      expect(saved.intent).toBe(goal.intent)
      expect(saved.status).toBe("active")
      expect((yield* setup(storage, () => []).get(sessionID))?.plan).toEqual(saved.plan)
      expect(
        yield* goals.plan(sessionID, { expectedIntent: goal.intent!, expectedRevision: null, tasks }).pipe(Effect.flip),
      ).toMatchObject({ conflict: true })
      const unchanged = yield* goals.plan(sessionID, {
        expectedIntent: goal.intent!,
        expectedRevision: saved.plan!.revision,
        tasks,
      })
      expect(unchanged.plan?.revision).toBe(saved.plan?.revision)
      const pending = [...tasks, { ...task, id: "dependent", dependencies: ["source"], status: "in_progress" as const }]
      expect(
        (yield* goals
          .plan(sessionID, { expectedIntent: goal.intent!, expectedRevision: saved.plan!.revision, tasks: pending })
          .pipe(Effect.flip)).message,
      ).toContain("until dependency source is completed")
      expect((yield* goals.get(sessionID))?.plan).toEqual(saved.plan)
      const revised = yield* goals.revise(sessionID, "Preserve this expanded objective")
      expect(revised.plan?.objective).toBe(goal.objective)
      expect(
        yield* goals
          .plan(sessionID, { expectedIntent: goal.intent!, expectedRevision: saved.plan!.revision, tasks })
          .pipe(Effect.flip),
      ).toMatchObject({ conflict: true })
      const current = yield* goals.plan(sessionID, {
        expectedIntent: revised.intent!,
        expectedRevision: saved.plan!.revision,
        tasks,
      })
      expect(current.objective).toBe(revised.objective)
      expect(current.plan?.objective).toBe(revised.objective)
      expect(current.plan?.revision).not.toBe(saved.plan?.revision)
    }),
  )
  it.live("saved smoke verification instructions require the matching successful smoke result", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_criterion_smoke_${crypto.randomUUID()}`)
      const rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Verify the interaction", undefined, undefined, undefined, [
        { id: "interaction", description: "Interaction works", verification: "The browser smoke test must pass" },
      ])
      const command = transcript({ sessionID, tool: "bash", exit: 0 })
      rows.push(...command.rows)
      const submit = (callID: string) =>
        goals.update(sessionID, {
          status: "complete",
          summary: "Interaction verified",
          requirements: [
            {
              criterionID: "interaction",
              requirement: "Interaction works",
              passed: true,
              evidence: [{ callID, summary: "Recorded verification" }],
            },
          ],
        })
      expect((yield* submit(command.part!.callID).pipe(Effect.flip)).message).toContain("browser_smoke_test")
      expect((yield* goals.get(sessionID))?.status).toBe("active")
      const failed = transcript({
        sessionID,
        tool: "browser_smoke_test",
        metadata: { passed: false, evidence: "raya-smoke-v1" },
      })
      rows.push(...failed.rows)
      expect((yield* submit(failed.part!.callID).pipe(Effect.flip))._tag).toBe("RayaGoal.AuditError")
      const smoke = transcript({
        sessionID,
        tool: "browser_smoke_test",
        metadata: { passed: true, evidence: "raya-smoke-v1" },
      })
      rows.push(...smoke.rows)
      expect((yield* submit(smoke.part!.callID)).status).toBe("complete")
    }),
  )
  it.live("steering invalidates the prior completion attempt while status changes preserve it", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const mode of ["revise", "edit"]) {
        const sessionID = SessionID.make(`ses_steer_audit_${crypto.randomUUID()}`)
        const goals = setup(storage, () => [])
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        const criteria = [{ id: "check", description: "Required outcome", verification: "Inspect the result" }]
        yield* goals.create(sessionID, "Original direction", undefined, undefined, undefined, criteria)
        yield* goals
          .update(sessionID, {
            status: "complete",
            requirements: [{ criterionID: "check", requirement: "Required outcome", passed: false, evidence: [] }],
          })
          .pipe(Effect.flip)
        const attempt = (yield* goals.get(sessionID))?.auditAttempt
        expect(attempt?.accepted).toBe(false)
        yield* goals.edit(sessionID, { status: "paused" })
        expect((yield* goals.get(sessionID))?.auditAttempt).toEqual(attempt)
        const state =
          mode === "revise"
            ? yield* goals.revise(sessionID, "Revised direction")
            : (yield* goals.edit(sessionID, { objective: "Revised direction" })).state
        expect(state.auditAttempt).toBeUndefined()
        expect(state.criteria).toEqual(criteria)
        expect(state.status).toBe("paused")
        expect((yield* setup(storage, () => []).get(sessionID))?.auditAttempt).toBeUndefined()
      }
    }),
  )
  it.live(
    "completion follows exact delegated inputs and excludes unrelated work in reused sessions",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const parent = SessionID.make(`ses_scope_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_scope_${crypto.randomUUID()}`)
        const grand = SessionID.make(`ses_scope_${crypto.randomUUID()}`)
        const orphan = SessionID.make(`ses_scope_${crypto.randomUUID()}`)
        const records = new Map<SessionID, MessageV2.WithParts[]>()
        const reads: SessionID[] = []
        const goals = setup(storage, () => [], {
          messagesFor: (id) => {
            reads.push(id)
            return records.get(id) ?? []
          },
          children: (id) =>
            (id === parent ? [child, orphan] : id === child ? [grand] : []).map(
              (id) => ({ id, time: { created: 0 } }) as Session.Info,
            ),
        })
        yield* Effect.addFinalizer(() => goals.clear(parent))
        const state = yield* goals.create(parent, "Verify delegated work")
        const work = transcript({ sessionID: child, tool: "write" })
        const final = transcript({ sessionID: grand, tool: "bash", exit: 0 })
        const unrelated = transcript({ sessionID: child, tool: "bash", exit: 0 })
        const root = transcript({ sessionID: parent, tool: "bash", exit: 0 })
        const report = transcript({
          sessionID: parent,
          tool: "task",
          metadata: { parentSessionId: parent, sessionId: child, childMessageID: work.rows[0].info.id },
        })
        const nested = transcript({
          sessionID: child,
          tool: "task",
          metadata: { parentSessionId: child, sessionId: grand, childMessageID: final.rows[0].info.id },
        })
        if (nested.rows[1].info.role === "assistant") nested.rows[1].info.parentID = work.rows[0].info.id
        records.set(parent, [...report.rows, ...root.rows])
        records.set(child, [...work.rows, ...unrelated.rows, nested.rows[1]])
        records.set(grand, final.rows)
        yield* storage.write(["raya", "goal", parent], { ...state, inputs: [] })
        expect(yield* goals.evidence(parent)).toEqual([])
        yield* storage.write(["raya", "goal", parent], { ...state, inputs: [report.rows[0].info.id] })
        const listed = yield* goals.evidence(parent)
        expect(listed.map((item) => item.callID).sort()).toEqual([work.part!.callID, final.part!.callID].sort())
        expect(reads).not.toContain(orphan)
        report.rows[1].parts.push({ ...report.part!, callID: crypto.randomUUID() })
        expect(yield* goals.evidence(parent)).toEqual([])
        report.rows[1].parts.pop()
        if (report.part!.state.status === "completed") {
          const metadata = report.part!.state.metadata
          report.part!.state.metadata = { ...metadata, childMessageID: undefined }
          expect(yield* goals.evidence(parent)).toEqual([])
          report.part!.state.metadata = metadata
        }
        const created = work.rows[0].info.time.created
        work.rows[0].info.time.created = state.createdAt - 1
        expect(yield* goals.evidence(parent)).toEqual([])
        work.rows[0].info.time.created = created
        const submit = (part: MessageV2.ToolPart) =>
          goals.update(parent, {
            status: "complete",
            summary: "Verified",
            requirements: [
              {
                requirement: "The delegated check passes",
                passed: true,
                evidence: [{ callID: part.callID, sessionID: part.sessionID, summary: "Real result" }],
              },
            ],
          })
        for (const part of [root.part!, unrelated.part!])
          expect((yield* submit(part).pipe(Effect.flip)).message).toContain("not a completed")
        records.set(child, [...records.get(child)!, work.rows[0]])
        expect(yield* goals.evidence(parent)).toEqual([])
        records.set(child, [...work.rows, ...unrelated.rows, nested.rows[1]])
        expect((yield* submit(final.part!)).status).toBe("complete")
      }),
    30_000,
  )
  it.live("persists host-authored evidence receipts and strips submitted receipt claims", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const success of [true, false]) {
        const sessionID = SessionID.make(`ses_receipt_${crypto.randomUUID()}`)
        const rows: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Verify the command")
        const data = transcript({ sessionID, tool: "bash", exit: success ? 0 : 1 })
        rows.push(...data.rows)
        const update = goals.update(sessionID, {
          status: "complete",
          summary: "Verified",
          requirements: [
            {
              requirement: "Command passes",
              passed: true,
              evidence: [
                {
                  callID: data.part!.callID,
                  summary: "Command result",
                  record: { version: 1, digest: "invented", at: 0 },
                },
              ],
            },
          ],
        })
        if (!success) {
          yield* update.pipe(Effect.flip)
          expect((yield* goals.get(sessionID))?.auditAttempt?.requirements[0].evidence[0].record).toBeUndefined()
          continue
        }
        const result = yield* update
        const receipt = result.audit!.requirements[0].evidence[0].record!
        expect(receipt.digest).toBe(digest(data.part!))
        expect(receipt.at).toBeGreaterThan(0)
        expect((yield* setup(storage, () => rows).get(sessionID))?.audit?.requirements[0].evidence[0].record).toEqual(
          receipt,
        )
        if (data.part!.state.status === "completed") data.part!.state.output = "changed result"
        expect(digest(data.part!)).not.toBe(receipt.digest)
      }
    }),
  )
  it.live("lists recorded read coverage separately from artifact freshness", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_coverage_${crypto.randomUUID()}`)
      const rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Review the file")
      const data = transcript({
        sessionID,
        tool: "read",
        metadata: {
          truncated: true,
          display: { type: "file", lineStart: 10, lineEnd: 12, totalLines: 30, truncated: true },
          rayaRevision: { version: 1, status: "unavailable", path: "unavailable.txt" },
        },
      })
      rows.push(...data.rows)
      expect(yield* goals.evidence(sessionID)).toEqual([
        expect.objectContaining({
          callID: data.part!.callID,
          artifact: { version: 1, status: "unavailable", path: "unavailable.txt" },
          inspection: {
            kind: "text",
            coverage: "partial",
            lineStart: 10,
            lineEnd: 12,
            reportedLines: 30,
            fullReview: "not-established",
          },
        }),
      ])
    }),
  )

  it.live(
    "completion checks recorded file revisions without invalidating unrelated artifacts",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const fs = yield* FSUtil.Service
        const directory = yield* tmpdirScoped()
        for (const scenario of ["write", "apply_patch", "read"].flatMap((tool) =>
          ["unchanged", "changed", "deleted", "unavailable", "malformed"].map((mode) => ({ tool, mode })),
        )) {
          const mode = scenario.mode
          const file = path.join(directory, `${mode}.txt`)
          yield* fs.writeFileString(file, "verified bytes")
          const revision = yield* Artifact.capture(fs, file)
          expect(revision.status).toBe("captured")
          const sessionID = SessionID.make(`ses_artifact_${crypto.randomUUID()}`)
          const rows: MessageV2.WithParts[] = []
          const goals = setup(storage, () => rows)
          yield* Effect.addFinalizer(() => goals.clear(sessionID))
          yield* goals.create(sessionID, "Create a verified file")
          const data = transcript({
            sessionID,
            tool: scenario.tool,
            metadata: {
              rayaRevision:
                mode === "unavailable"
                  ? { status: "unavailable", version: 1, path: file }
                  : mode === "malformed"
                    ? { ...revision, sha256: "invented" }
                    : scenario.tool === "apply_patch"
                      ? { version: 1, status: "bundle", revisions: [revision] }
                      : revision,
            },
          })
          rows.push(...data.rows)
          yield* fs.writeFileString(path.join(directory, "unrelated.txt"), crypto.randomUUID())
          if (mode === "changed") yield* fs.writeFileString(file, "changed bytes!")
          if (mode === "deleted") yield* fs.remove(file)
          const update = (part = data.part!) =>
            goals.update(sessionID, {
              status: "complete",
              summary: "File verified",
              requirements: [
                {
                  requirement: "The file is current",
                  passed: true,
                  evidence: [{ callID: part.callID, summary: "The recorded write matches the current file" }],
                },
              ],
            })
          if (mode === "unchanged") {
            expect((yield* update()).status).toBe("complete")
            continue
          }
          expect((yield* update().pipe(Effect.flip)).message).toContain(
            "stale or its current revision could not be verified",
          )
          expect((yield* goals.get(sessionID))?.status).toBe("active")
          yield* fs.writeFileString(file, "freshly verified bytes")
          const fresh = transcript({
            sessionID,
            tool: "write",
            metadata: { rayaRevision: yield* Artifact.capture(fs, file) },
          })
          rows.push(...fresh.rows)
          expect((yield* update(fresh.part!)).status).toBe("complete")
        }
      }),
    30_000,
  )

  it.live("delegated cancellation journals intent before action and retains uncertain results across reloads", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const mode of ["job", "input", "before", "after"]) {
        const jobs = yield* BackgroundJob.make
        const sessionID = SessionID.make(`ses_journal_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const data = transcript({ sessionID, tool: "task", metadata: { sessionId: child } })
        const goals = setup(
          {
            ...storage,
            replace: (key, value) => {
              const operation = (value as { operations?: { phase: string }[] })?.operations?.at(-1)
              if (
                (mode === "before" && operation?.phase === "requested") ||
                (mode === "after" && operation?.phase === "observed")
              )
                return Effect.die("Cancellation journal unavailable")
              return storage.replace(key, value)
            },
          },
          () => data.rows,
        )
        const goal = yield* goals.create(sessionID, "Keep delegated cancellation evidence", data.rows[0].info.id)
        yield* goals.initial(sessionID, goal.intent!, "finished-parent")
        const message = MessageID.ascending()
        yield* jobs.start({
          id: child,
          type: "task",
          metadata: { parentSessionId: sessionID },
          origin: {
            sessionID,
            messageID: data.rows[1].info.id,
            callID: data.part!.callID,
            childSessionID: child,
            childMessageID: message,
          },
          run: Effect.never,
        })
        if (mode === "input") yield* jobs.extend({ id: child, run: Effect.never })
        let calls = 0
        const check = Effect.gen(function* () {
          calls++
          const saved = yield* receipts(storage).read(sessionID, goal.intent!)
          expect(saved?.phase).toBe("cleared")
          expect(saved?.operations).toMatchObject([{ jobID: child, phase: "requested" }])
        })
        const runs = { requestCancel: () => Effect.succeed(Effect.succeed(false)) }
        const result = yield* goals.stop(sessionID, goal.intent!, runs, {
          ...jobs,
          cancel: (id, revision) => check.pipe(Effect.andThen(jobs.cancel(id, revision))),
          cancelInput: (id, revision, input) => check.pipe(Effect.andThen(jobs.cancelInput(id, revision, input))),
        })
        expect(calls).toBe(mode === "before" ? 0 : 1)
        expect(result.background?.status).toBe(mode === "before" || mode === "after" ? "unavailable" : "checked")
        expect(result.operations?.length ?? 0).toBe(mode === "before" ? 0 : 1)
        if (mode !== "before") {
          expect(result.operations?.[0]).toMatchObject({
            jobID: child,
            phase: mode === "after" ? "requested" : "observed",
          })
          if (mode === "input") expect(result.operations?.[0]).toMatchObject({ messageID: message, result: "accepted" })
          if (mode === "job") expect(result.operations?.[0]).toMatchObject({ result: "cancelled" })
        }
        expect((yield* jobs.get(child))?.status).toBe(mode === "before" || mode === "input" ? "running" : "cancelled")
        const reloaded = setup(storage, () => data.rows)
        expect(yield* reloaded.stopResult(sessionID)).toEqual(result)
        yield* jobs.cancel(child)
        yield* jobs.start({ id: child, type: "task", run: Effect.never })
        expect(yield* reloaded.stop(sessionID, goal.intent!, runs, jobs)).toEqual(result)
        expect((yield* jobs.get(child))?.status).toBe("running")
      }
    }),
  )

  it.live(
    "stop retains prior bound inputs across reloads and queued continuations without inheriting them into a new goal",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const jobs = yield* BackgroundJob.make
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const first = transcript({ sessionID, tool: "task", metadata: { sessionId: child } })
        const rows = [...first.rows]
        const goals = setup(storage, () => rows)
        const goal = yield* goals.create(sessionID, "Retain turn ownership", first.rows[0].info.id)
        const initial = yield* goals.initial(sessionID, goal.intent!, "first-worker")
        expect(initial?.inputs).toEqual([first.rows[0].info.id])
        if (first.rows[1].info.role !== "assistant") throw new Error("Missing assistant")
        first.rows[1].info.time.completed = Date.now()
        expect((yield* goals.finished(sessionID, first.rows[1].info.id))?.dispatch?.phase).toBe("finished")
        const queued = yield* goals.continued(sessionID)
        expect(queued?.inputs).toEqual(initial?.inputs)
        yield* goals.dispatched(sessionID, queued!.dispatch!.id)
        const second = transcript({ sessionID, tool: "task", metadata: { sessionId: child } })
        second.rows[0].info.id = queued!.dispatch!.messageID!
        if (second.rows[1].info.role !== "assistant") throw new Error("Missing second assistant")
        second.rows[1].info.parentID = second.rows[0].info.id
        rows.push(...second.rows)
        const bound = yield* goals.bound(sessionID, queued!.dispatch!.id, "second-worker")
        expect(bound?.inputs).toEqual([first.rows[0].info.id, second.rows[0].info.id])
        expect(yield* goals.bound(sessionID, queued!.dispatch!.id, "second-worker")).toEqual(bound)
        second.rows[1].info.time.completed = Date.now()
        expect((yield* goals.finished(sessionID, second.rows[1].info.id))?.dispatch?.phase).toBe("finished")
        yield* goals.continued(sessionID)
        yield* goals.control(sessionID, "paused")
        const revised = yield* goals.revise(sessionID, "Stop both earlier turns")
        const reloaded = setup(storage, () => rows)
        expect((yield* reloaded.get(sessionID))?.inputs).toEqual(bound?.inputs)
        const origin = (data: ReturnType<typeof transcript>) => ({
          sessionID,
          messageID: data.rows[1].info.id,
          callID: data.part!.callID,
          childSessionID: child,
          childMessageID: MessageID.ascending(),
        })
        yield* jobs.start({
          id: child,
          type: "task",
          metadata: { parentSessionId: sessionID },
          origin: origin(first),
          run: Effect.never,
        })
        yield* jobs.extend({ id: child, origin: origin(second), run: Effect.never })
        const runner = Runner.make<string>(yield* Scope.Scope)
        const runs = { requestCancel: (_: SessionID, id: string) => runner.requestCancel(id) }
        const receipt = yield* reloaded.stop(sessionID, revised.intent!, runs, jobs)
        expect(receipt.background).toMatchObject({ status: "checked", jobs: [] })
        expect((yield* jobs.get(child))?.status).toBe("cancelled")
        const next = yield* reloaded.create(sessionID, "A separate goal")
        expect(next.inputs).toBeUndefined()
        yield* jobs.start({
          id: child,
          type: "task",
          metadata: { parentSessionId: sessionID },
          origin: origin(first),
          run: Effect.never,
        })
        yield* reloaded.stop(sessionID, next.intent!, runs, jobs)
        expect((yield* jobs.get(child))?.status).toBe("running")
      }),
  )

  it.live("reviewed stop cancels corroborated nested jobs, preserves mixed work, and never replays cancellation", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const jobs = yield* BackgroundJob.make
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
      const grandchild = SessionID.make(`ses_grandchild_${crypto.randomUUID()}`)
      const mixed = SessionID.make(`ses_mixed_${crypto.randomUUID()}`)
      const root = transcript({ sessionID, tool: "task", metadata: { sessionId: child } })
      const nested = transcript({ sessionID: child, tool: "task", metadata: { sessionId: grandchild } })
      const extra = transcript({ sessionID, tool: "task", metadata: { sessionId: mixed } })
      if (extra.rows[1].info.role !== "assistant") throw new Error("Missing assistant")
      extra.rows[1].info.parentID = root.rows[0].info.id
      root.rows.push(extra.rows[1])
      const goals = setup(storage, () => root.rows, { messagesFor: (id) => (id === child ? nested.rows : root.rows) })
      const goal = yield* goals.create(sessionID, "Stop owned delegated work", root.rows[0].info.id)
      yield* goals.initial(sessionID, goal.intent!, "finished-worker")
      yield* jobs.start({
        id: child,
        type: "task",
        metadata: { parentSessionId: sessionID },
        origin: {
          sessionID,
          messageID: root.rows[1].info.id,
          callID: root.part!.callID,
          childSessionID: child,
          childMessageID: nested.rows[0].info.id,
        },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild,
        type: "task",
        metadata: { parentSessionId: child },
        origin: {
          sessionID: child,
          messageID: nested.rows[1].info.id,
          callID: nested.part!.callID,
          childSessionID: grandchild,
          childMessageID: MessageID.ascending(),
        },
        run: Effect.never,
      })
      yield* jobs.start({
        id: mixed,
        type: "task",
        metadata: { parentSessionId: sessionID },
        origin: {
          sessionID,
          messageID: extra.rows[1].info.id,
          callID: extra.part!.callID,
          childSessionID: mixed,
          childMessageID: MessageID.ascending(),
        },
        run: Effect.never,
      })
      yield* jobs.extend({ id: mixed, run: Effect.never })
      const reviewed = yield* goals.control(sessionID, "paused")
      const runner = Runner.make<string>(yield* Scope.Scope)
      const runs = { requestCancel: (_: SessionID, id: string) => runner.requestCancel(id) }
      const receipt = yield* goals.stop(sessionID, reviewed.intent!, runs, jobs)
      expect(receipt.phase).toBe("finished")
      expect(receipt.background).toMatchObject({ status: "checked", jobs: [{ id: mixed, type: "task" }] })
      expect(receipt.operations).toHaveLength(3)
      expect(new Set(receipt.operations?.map((operation) => operation.id)).size).toBe(3)
      expect(receipt.operations?.every((operation) => operation.phase === "observed")).toBe(true)
      expect(receipt.operations?.find((operation) => operation.jobID === mixed)).toMatchObject({
        result: "accepted",
        messageID: expect.any(String),
      })
      expect((yield* jobs.get(child))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild))?.status).toBe("cancelled")
      expect((yield* jobs.get(mixed))?.status).toBe("running")
      expect(yield* goals.stopResult(sessionID)).toEqual(receipt)
      yield* jobs.start({ id: child, type: "task", run: Effect.never })
      expect(yield* goals.stop(sessionID, reviewed.intent!, runs, jobs)).toEqual(receipt)
      expect((yield* jobs.get(child))?.status).toBe("running")
    }),
  )

  it.live("mixed jobs preserve unrelated work while verified inputs still own their descendants", () =>
    Effect.gen(function* () {
      for (const mode of ["mixed", "unknown", "collision", "foreign", "raced"]) {
        const jobs = yield* BackgroundJob.make
        const cleaned = yield* Deferred.make<void>()
        const advanced = yield* Deferred.make<void>()
        let raced = false
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const leaf = SessionID.make(`ses_leaf_${crypto.randomUUID()}`)
        const other = SessionID.make(`ses_other_${crypto.randomUUID()}`)
        const root = transcript({ sessionID, tool: "task", metadata: { sessionId: child } })
        const extra = transcript({ sessionID, tool: "task", metadata: { sessionId: child } })
        const nested = transcript({ sessionID: child, tool: "task", metadata: { sessionId: leaf } })
        const unrelated = transcript({ sessionID: child, tool: "task", metadata: { sessionId: other } })
        if (mode === "foreign" && nested.rows[1].info.role === "assistant")
          nested.rows[1].info.parentID = unrelated.rows[0].info.id
        // Descendants appear before their mixed ancestor: traversal must converge on input edges.
        for (const [id, data] of [
          [leaf, nested],
          [other, unrelated],
        ] as const) {
          yield* jobs.start({
            id,
            type: "task",
            metadata: { parentSessionId: child },
            origin: {
              sessionID: child,
              messageID: data.rows[1].info.id,
              callID: data.part!.callID,
              childSessionID: id,
              childMessageID: MessageID.ascending(),
            },
            run: Effect.never,
          })
        }
        yield* jobs.start({
          id: child,
          type: "task",
          metadata: { parentSessionId: sessionID },
          origin: {
            sessionID,
            messageID: root.rows[1].info.id,
            callID: root.part!.callID,
            childSessionID: child,
            childMessageID: nested.rows[0].info.id,
          },
          run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined))),
        })
        yield* jobs.extend({
          id: child,
          origin:
            mode === "unknown"
              ? undefined
              : {
                  sessionID,
                  messageID: extra.rows[1].info.id,
                  callID: extra.part!.callID,
                  childSessionID: child,
                  childMessageID: mode === "collision" ? nested.rows[0].info.id : unrelated.rows[0].info.id,
                },
          run: Deferred.succeed(advanced, undefined).pipe(Effect.andThen(Effect.never)),
        })
        const result = yield* settle(
          sessionID,
          [root.rows[0].info.id],
          {
            messages: ({ sessionID: id }) =>
              Effect.succeed(id === sessionID ? [...root.rows, ...extra.rows] : [...nested.rows, ...unrelated.rows]),
          },
          {
            ...jobs,
            cancelInput: (id, revision, message) =>
              Effect.gen(function* () {
                if (mode === "raced" && !raced) {
                  raced = true
                  yield* jobs.extend({ id, run: Effect.never })
                }
                return yield* jobs.cancelInput(id, revision, message)
              }),
          },
        )
        expect(yield* Deferred.isDone(cleaned)).toBe(mode !== "collision")
        if (mode !== "collision") yield* Deferred.await(advanced)
        expect(yield* Deferred.isDone(advanced)).toBe(mode !== "collision")
        expect(result.status).toBe("checked")
        expect((yield* jobs.get(child))?.status).toBe("running")
        expect((yield* jobs.get(other))?.status).toBe("running")
        expect((yield* jobs.get(leaf))?.status).toBe(
          mode === "collision" || mode === "foreign" ? "running" : "cancelled",
        )
        expect(result.jobs.map((job) => job.id).includes(leaf)).toBe(mode === "collision" || mode === "foreign")
      }
    }),
  )

  it.live("delegated settlement catches late descendants and preserves raced extensions or unavailable evidence", () =>
    Effect.gen(function* () {
      for (const mode of ["late", "extension", "unavailable", "foreign", "ambiguous"]) {
        const jobs = yield* BackgroundJob.make
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const grandchild = SessionID.make(`ses_grandchild_${crypto.randomUUID()}`)
        const root = transcript({ sessionID, tool: "task", metadata: { sessionId: child } })
        const nested = transcript({ sessionID: child, tool: "task", metadata: { sessionId: grandchild } })
        if (mode === "foreign" && root.rows[1].info.role === "assistant")
          root.rows[1].info.parentID = MessageID.ascending()
        if (mode === "ambiguous") root.rows[1].parts.push({ ...root.part!, id: PartID.ascending() })
        const origin = {
          sessionID,
          messageID: root.rows[1].info.id,
          callID: root.part!.callID,
          childSessionID: child,
          childMessageID: nested.rows[0].info.id,
        }
        const late = jobs.start({
          id: grandchild,
          type: "task",
          metadata: { parentSessionId: child },
          origin: {
            sessionID: child,
            messageID: nested.rows[1].info.id,
            callID: nested.part!.callID,
            childSessionID: grandchild,
            childMessageID: MessageID.ascending(),
          },
          run: Effect.never,
        })
        yield* jobs.start({
          id: child,
          type: "task",
          metadata: { parentSessionId: sessionID },
          origin,
          run: mode === "late" ? Effect.never.pipe(Effect.ensuring(late)) : Effect.never,
        })
        const result = yield* settle(
          sessionID,
          [root.rows[0].info.id],
          {
            messages: ({ sessionID: id }) =>
              mode === "unavailable"
                ? Effect.die("transcript unavailable")
                : Effect.succeed(id === sessionID ? root.rows : nested.rows),
          },
          {
            list: jobs.list,
            cancel: (id, revision) =>
              mode === "extension"
                ? jobs.extend({ id, run: Effect.never }).pipe(Effect.andThen(jobs.cancel(id, revision)))
                : jobs.cancel(id, revision),
          },
        )
        if (mode === "late") {
          expect(result.jobs).toEqual([])
          expect((yield* jobs.get(grandchild))?.status).toBe("cancelled")
          continue
        }
        expect((yield* jobs.get(child))?.status).toBe("running")
        expect(result.jobs).toMatchObject([{ id: child }])
        expect(result.status).toBe(mode === "unavailable" ? "unavailable" : "checked")
      }
    }),
  )

  it.live("stop persists related jobs without cancelling them or refreshing a replayed receipt", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const jobs = yield* BackgroundJob.make
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      const state = yield* goals.create(sessionID, "Observe background work")
      yield* jobs.start({ id: "child", type: "task", metadata: { parentSessionId: sessionID }, run: Effect.never })
      const runs = { requestCancel: () => Effect.succeed(Effect.succeed(false)) }
      const result = yield* goals.stop(sessionID, state.intent!, runs, jobs)
      expect(result.background).toMatchObject({ status: "checked", jobs: [{ id: "child", type: "task" }] })
      expect((yield* jobs.get("child"))?.status).toBe("running")
      expect(yield* goals.stopResult(sessionID)).toEqual(result)
      yield* jobs.cancel("child")
      expect(yield* goals.stop(sessionID, state.intent!, runs, jobs)).toEqual(result)
    }),
  )

  it.live("initial ownership rejects stale anchors and direction and preserves continuation accounting", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const state = yield* goals.create(sessionID, "Own initial work", data.rows[0].info.id)
      expect(yield* goals.initial(sessionID, state.intent!, "worker")).toBeUndefined()
      rows.push(data.rows[0])
      expect(yield* goals.initial(sessionID, "stale", "worker")).toBeUndefined()
      rows.push(transcript({ sessionID }).rows[0])
      expect(yield* goals.initial(sessionID, state.intent!, "worker")).toBeUndefined()
      rows.pop()
      const paused = yield* goals.control(sessionID, "paused")
      expect(yield* goals.initial(sessionID, paused.intent!, "worker")).toBeUndefined()
      const active = yield* goals.control(sessionID, "active")
      const started = yield* goals.initial(sessionID, active.intent!, "worker")
      expect(started?.usage).toEqual(state.usage)
      expect(started?.dispatch).toMatchObject({ phase: "started", messageID: data.rows[0].info.id, worker: "worker" })
      expect(yield* goals.initial(sessionID, active.intent!, "replacement")).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(started)
      const assistant = data.rows[1]
      if (assistant.info.role !== "assistant") throw new Error("Missing assistant")
      assistant.info.time.completed = Date.now()
      rows.push(assistant)
      expect((yield* goals.finished(sessionID, assistant.info.id))?.dispatch?.phase).toBe("finished")
      const queued = yield* goals.continued(sessionID)
      expect(queued?.usage.continuations).toBe(1)
      expect(queued?.dispatch?.id).not.toBe(started?.dispatch?.id)
      expect(queued?.dispatch?.messageID).not.toBe(started?.dispatch?.messageID)
      yield* goals.clear(sessionID)
      const stale = yield* goals.create(sessionID, "Do not claim an old assistant", assistant.info.id)
      expect(yield* goals.initial(sessionID, stale.intent!, "worker")).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(stale)
    }),
  )

  it.live("latest stop discovery preserves uncertain results, isolates sessions, and rejects misplaced records", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const records = receipts(storage)
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const other = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      expect(yield* records.latest(sessionID)).toBeUndefined()
      const older = { sessionID, intent: "older", at: 1, phase: "finished" as const, finishedAt: 2, interrupted: true }
      yield* records.save(older)
      yield* records.save({ ...older, sessionID: other, at: 100 })
      const pending = { sessionID, intent: "pending", at: 3, phase: "requested" as const }
      yield* records.save(pending)
      expect(yield* records.latest(sessionID)).toEqual(pending)
      expect(yield* records.read(sessionID, "older")).toEqual(older)
      const cleared = { ...pending, phase: "cleared" as const }
      yield* records.save(cleared)
      expect(yield* records.latest(sessionID)).toEqual(cleared)
      expect(yield* records.read(sessionID, "pending")).toEqual(cleared)
      const paths = yield* storage.list(["raya", "goal-stops", sessionID])
      yield* storage.replace(paths[0], { ...older, sessionID: other })
      expect(Exit.isFailure(yield* records.latest(sessionID).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.live(
    "stop completion is saved after its request waiter disconnects",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const scope = yield* Scope.Scope
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const rows: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        const initial = yield* goals.create(sessionID, "Keep a cancellation receipt")
        const queued = yield* goals.continued(sessionID)
        if (!queued?.dispatch?.messageID) throw new Error("Missing dispatch")
        yield* goals.dispatched(sessionID, queued.dispatch.id)
        const user = transcript({ sessionID }).rows[0]
        user.info.id = queued.dispatch.messageID
        rows.push(user)
        const runner = Runner.make<string>(scope, { onInterrupt: Effect.succeed("cancelled") })
        const cleanup = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* runner
          .ensureRunning(
            Effect.never.pipe(
              Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(release)))),
            ),
          )
          .pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.sync(() => observe(runner).id),
          "worker did not start",
        )
        yield* goals.bound(sessionID, queued.dispatch.id, observe(runner).id!)
        const runs = { requestCancel: (_: SessionID, id: string) => runner.requestCancel(id) }
        const request = yield* goals.stop(sessionID, initial.intent!, runs).pipe(Effect.forkChild)
        yield* Deferred.await(cleanup)
        yield* Fiber.interrupt(request)
        expect((yield* goals.stop(sessionID, initial.intent!, runs)).phase).toBe("cleared")
        const next = yield* goals.create(sessionID, "Preserve the new goal during old cleanup")
        yield* Deferred.succeed(release, undefined)
        const result = yield* pollWithTimeout(
          goals
            .stop(sessionID, initial.intent!, runs)
            .pipe(Effect.map((receipt) => (receipt.phase === "finished" ? receipt : undefined))),
          "detached stop result was not saved",
        )
        expect(result.interrupted).toBe(true)
        expect(yield* goals.get(sessionID)).toEqual(next)
      }),
    30_000,
  )

  it.live(
    "stop receipts recover storage boundaries without reissuing uncertain cancellation",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const scope = yield* Scope.Scope
        for (const phase of ["requested", "cleared", "finished"] as const) {
          let fault = true
          const store = {
            ...storage,
            replace: (key: string[], value: unknown) => {
              if (fault && key[1] === "goal-stops" && (value as { phase?: string }).phase === phase)
                return Effect.die(new Error("receipt write unavailable"))
              return storage.replace(key, value)
            },
          }
          const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
          const rows: MessageV2.WithParts[] = []
          const goals = setup(store, () => rows)
          yield* Effect.addFinalizer(() => goals.clear(sessionID))
          const initial = yield* goals.create(sessionID, "Recover a stop result")
          const queued = yield* goals.continued(sessionID)
          if (!queued?.dispatch?.messageID) throw new Error("Missing dispatch")
          yield* goals.dispatched(sessionID, queued.dispatch.id)
          const user = transcript({ sessionID }).rows[0]
          user.info.id = queued.dispatch.messageID
          rows.push(user)
          const runner = Runner.make<string>(scope, { onInterrupt: Effect.succeed("cancelled") })
          const start = () => runner.ensureRunning(Effect.never).pipe(Effect.forkChild)
          yield* start()
          yield* pollWithTimeout(
            Effect.sync(() => observe(runner).id),
            "worker did not start",
          )
          yield* goals.bound(sessionID, queued.dispatch.id, observe(runner).id!)
          const runs = { requestCancel: (_: SessionID, id: string) => runner.requestCancel(id) }
          const failed = yield* goals.stop(sessionID, initial.intent!, runs).pipe(Effect.exit)
          expect(Exit.isFailure(failed)).toBe(true)
          expect(Boolean(yield* goals.get(sessionID))).toBe(phase === "requested")
          expect(observe(runner).phase).toBe(phase === "finished" ? "idle" : "running")
          if (phase === "finished") {
            yield* start()
            yield* pollWithTimeout(
              Effect.sync(() => observe(runner).id),
              "replacement did not start",
            )
          }
          const before = observe(runner)
          fault = false
          const receipt = yield* goals.stop(sessionID, initial.intent!, runs)
          expect(receipt.phase).toBe(phase === "requested" ? "finished" : "cleared")
          expect(receipt.interrupted).toBe(phase === "requested" ? true : undefined)
          if (phase !== "requested") expect(observe(runner)).toEqual(before)
          expect(yield* goals.stop(sessionID, initial.intent!, runs)).toEqual(receipt)
          yield* runner.cancel
        }
      }),
    30_000,
  )

  it.live(
    "stopping protects newer input and replacement workers and releases locks before cleanup",
    () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const scope = yield* Scope.Scope
        for (const mode of ["owned", "newer", "replacement", "unbound"] as const) {
          const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
          const rows: MessageV2.WithParts[] = []
          const goals = setup(storage, () => rows)
          yield* Effect.addFinalizer(() => goals.clear(sessionID))
          yield* goals.create(sessionID, "Stop only owned work")
          const queued = yield* goals.continued(sessionID)
          if (!queued?.dispatch?.messageID) throw new Error("Missing dispatch")
          yield* goals.dispatched(sessionID, queued.dispatch.id)
          const user = transcript({ sessionID }).rows[0]
          user.info.id = queued.dispatch.messageID
          rows.push(user)
          const runner = Runner.make<string>(scope, { onInterrupt: Effect.succeed("cancelled") })
          const work = Effect.never.pipe(
            Effect.ensuring(mutation(storage, sessionID, Effect.void).pipe(gate.withLock(sessionID))),
          )
          const start = () => runner.ensureRunning(work).pipe(Effect.forkChild)
          const first = yield* start()
          yield* pollWithTimeout(
            Effect.sync(() => observe(runner).id),
            "goal worker did not start",
          )
          if (mode !== "unbound") yield* goals.bound(sessionID, queued.dispatch.id, observe(runner).id!)
          if (mode === "newer") rows.push(transcript({ sessionID }).rows[0])
          if (mode === "replacement") {
            yield* runner.cancel
            yield* Fiber.join(first)
            yield* start()
            yield* pollWithTimeout(
              Effect.sync(() => observe(runner).id),
              "replacement worker did not start",
            )
          }
          const runs = { requestCancel: (_: SessionID, id: string) => runner.requestCancel(id) }
          const before = yield* goals.get(sessionID)
          expect((yield* goals.stop(sessionID, "stale", runs).pipe(Effect.flip)).conflict).toBe(true)
          expect(yield* goals.get(sessionID)).toEqual(before)
          expect(observe(runner).phase).toBe("running")
          if (mode === "owned") {
            const held = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const input = yield* Deferred.succeed(held, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              gate.withLock(sessionID),
              Effect.forkChild,
            )
            yield* Deferred.await(held)
            const waiting = yield* goals
              .stop(sessionID, before!.intent!, runs)
              .pipe(Effect.forkChild({ startImmediately: true }))
            yield* Fiber.interrupt(waiting)
            expect(yield* goals.get(sessionID)).toEqual(before)
            expect(observe(runner).phase).toBe("running")
            yield* Deferred.succeed(release, undefined)
            yield* Fiber.join(input)
          }
          const result = yield* goals.stop(sessionID, before!.intent!, runs)
          expect(result).toMatchObject({
            sessionID,
            intent: before!.intent!,
            phase: "finished",
            interrupted: mode === "owned",
          })
          expect(yield* goals.get(sessionID)).toBeUndefined()
          expect(observe(runner).phase).toBe(mode === "owned" ? "idle" : "running")
          expect(yield* goals.stop(sessionID, before!.intent!, runs)).toEqual(result)
          const next = yield* goals.create(sessionID, "Preserve the next goal")
          expect(yield* goals.stop(sessionID, before!.intent!, runs)).toEqual(result)
          expect(yield* goals.get(sessionID)).toEqual(next)
          yield* runner.cancel
        }
      }),
    30_000,
  )

  it.live("records failed and interrupted dispatch outcomes only with terminal saved evidence", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const outcome of ["error", "interrupted"] as const) {
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        let rows: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Retain the unfinished objective")
        const queued = yield* goals.continued(sessionID)
        if (!queued?.dispatch?.messageID) throw new Error("Missing dispatch")
        yield* goals.dispatched(sessionID, queued.dispatch.id)
        const data = transcript({ sessionID, tool: "bash", exit: 1 })
        const user = data.rows[0]
        const reply = data.rows[1]
        if (user.info.role !== "user" || reply.info.role !== "assistant") throw new Error("Invalid transcript")
        user.info.id = queued.dispatch.messageID
        reply.info.parentID = user.info.id
        reply.info.time.completed = Date.now() + 1
        rows = data.rows
        if (outcome === "error") expect(yield* goals.finished(sessionID, reply.info.id, outcome)).toBeUndefined()
        reply.info.error = { name: "UnknownError", data: { message: "Provider failed" } }
        const part = reply.parts.find((part) => part.type === "tool")
        if (!part || part.state.status !== "completed") throw new Error("Missing tool")
        const completed = part.state
        part.state = { ...completed, status: "running" }
        expect(yield* goals.finished(sessionID, reply.info.id, outcome)).toBeUndefined()
        part.state = completed
        const paused = yield* goals.control(sessionID, "paused")
        const id = yield* closing({ messages: () => Effect.succeed(rows.toReversed()) }, sessionID)
        expect(id).toBe(reply.info.id)
        if (!id) throw new Error("Missing closing assistant")
        const saved = yield* goals.finished(sessionID, id, outcome)
        expect(saved?.dispatch).toMatchObject({ phase: "finished", outcome, assistantID: id })
        expect(saved?.status).toBe("paused")
        expect(saved?.objective).toBe(paused.objective)
        expect(saved?.usage).toEqual(paused.usage)
        expect(yield* goals.finished(sessionID, id, outcome)).toBeUndefined()
      }
      const absent = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      expect(yield* closing({ messages: () => Effect.succeed([]) }, absent)).toBeUndefined()
      expect(yield* closing({ messages: () => Effect.die(new Error("Read failed")) }, absent)).toBeUndefined()
    }),
  )

  it.live("acknowledges only the matching terminal dispatch without changing steered goal state", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Observe the dispatched turn")
      const queued = yield* goals.continued(sessionID)
      if (!queued?.dispatch?.messageID) throw new Error("Missing queued dispatch")
      yield* goals.dispatched(sessionID, queued.dispatch.id)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const user = data.rows[0]
      const reply = data.rows[1]
      if (user.info.role !== "user" || reply.info.role !== "assistant") throw new Error("Invalid transcript")
      user.info.id = queued.dispatch.messageID
      reply.info.parentID = user.info.id
      reply.info.time.completed = Date.now() + 1
      rows = [reply]
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      rows = data.rows
      expect(yield* goals.finished(sessionID, MessageID.ascending())).toBeUndefined()
      const at = reply.info.time.completed
      reply.info.time.completed = undefined
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      reply.info.time.completed = queued.dispatch.queuedAt - 1
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      reply.info.time.completed = at
      const newer = transcript({ sessionID, tool: "bash", exit: 0 }).rows[1]
      if (newer.info.role !== "assistant") throw new Error("Missing newer assistant")
      newer.info.parentID = user.info.id
      rows = [...data.rows, newer]
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      rows = data.rows
      const part = reply.parts.find((part) => part.type === "tool")
      if (!part || part.state.status !== "completed") throw new Error("Missing completed tool")
      const completed = part.state
      part.state = { ...completed, status: "running" }
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      part.state = completed
      reply.info.error = { name: "UnknownError", data: { message: "Provider failed" } }
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      reply.info.error = undefined
      yield* goals.control(sessionID, "paused")
      const steered = yield* goals.revise(sessionID, "Preserve the revised paused direction")
      let close:
        | ((event: {
            properties: { sessionID: SessionID; messageID: MessageID; reason: "completed" }
          }) => Fiber.Fiber<unknown, unknown>)
        | undefined
      const bus = {
        subscribeCallback: (_event, callback) => {
          close = callback as typeof close
          return Effect.succeed(() => {})
        },
      } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
      yield* RayaGoalContinuation.subscribe({
        bus,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed(rows),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async () => {
          throw new Error("A paused goal must not dispatch")
        },
      })
      if (!close) throw new Error("Missing turn-close subscription")
      yield* Fiber.join(close({ properties: { sessionID, messageID: reply.info.id, reason: "completed" } }))
      const saved = yield* goals.get(sessionID)
      expect(saved?.dispatch).toMatchObject({ phase: "finished", assistantID: reply.info.id, finishedAt: at })
      expect(saved?.objective).toBe(steered.objective)
      expect(saved?.status).toBe("paused")
      expect(saved?.intent).toBe(steered.intent)
      expect(saved?.usage).toEqual(steered.usage)
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(saved)
      yield* goals.control(sessionID, "active")
      yield* goals.continued(sessionID)
      expect(yield* goals.finished(sessionID, reply.info.id)).toBeUndefined()
      expect((yield* goals.get(sessionID))?.dispatch?.phase).toBe("queued")
    }),
  )

  it.live("does not hand off a saved prompt or supersede newer user input", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const kind of ["saved", "newer", "time", "older", "unreadable"] as const) {
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const prior = transcript({ sessionID, tool: "bash", exit: 0 })
        let rows = prior.rows
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Respect the conversation")
        const queued = yield* goals.continued(sessionID)
        if (!queued?.dispatch?.messageID) throw new Error("Missing reserved message")
        const newer = transcript({ sessionID, tool: "bash", exit: 0 })
        if (kind === "saved") rows = [{ info: { ...prior.rows[0].info, id: queued.dispatch.messageID }, parts: [] }]
        if (kind === "newer") rows = newer.rows
        if (kind === "time")
          rows = [{ info: { ...prior.rows[0].info, time: { created: queued.dispatch.queuedAt + 1 } }, parts: [] }]
        if (kind === "older") rows = [prior.rows[0], newer.rows[1]]
        const reader =
          kind === "unreadable"
            ? RayaGoal.make({
                storage,
                sessions: {
                  messages: () => Effect.die(new Error("Conversation unavailable")),
                  children: () => Effect.succeed([]),
                },
              })
            : goals
        const result = yield* reader.dispatched(sessionID, queued.dispatch.id).pipe(Effect.exit)
        if (kind === "older") {
          expect(Exit.isSuccess(result)).toBe(true)
          expect((yield* goals.get(sessionID))?.dispatch?.phase).toBe("started")
          continue
        }
        expect(yield* goals.get(sessionID)).toEqual(queued)
        if (kind === "unreadable") expect(Exit.isFailure(result)).toBe(true)
        if (kind !== "unreadable") expect(result).toMatchObject({ _tag: "Success", value: undefined })
      }
    }),
  )

  it.live("persists a queued dispatch with accounting and starts each identity at most once", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const goal = yield* goals.create(sessionID, "Dispatch the reviewed work")
      const queued = yield* goals.continued(sessionID, goal.intent)
      if (!queued?.dispatch) throw new Error("Dispatch was not saved")
      const reopened = setup(storage, () => [])
      expect((yield* reopened.get(sessionID))?.dispatch).toEqual(queued.dispatch)
      expect(queued.dispatch.phase).toBe("queued")
      expect(queued.dispatch.messageID).toStartWith("msg")
      expect(queued.usage.continuations).toBe(1)
      expect(yield* reopened.continued(sessionID, goal.intent)).toEqual(queued)
      const results = yield* Effect.all(
        [goals.dispatched(sessionID, queued.dispatch.id), reopened.dispatched(sessionID, queued.dispatch.id)].map(
          Effect.exit,
        ),
        { concurrency: "unbounded" },
      )
      const starts = results.filter((result) => Exit.isSuccess(result) && result.value !== undefined)
      expect(starts).toHaveLength(1)
      expect((yield* goals.get(sessionID))?.dispatch?.phase).toBe("started")
      expect((yield* goals.get(sessionID))?.dispatch?.messageID).toBe(queued.dispatch.messageID)
      expect(yield* goals.dispatched(sessionID, queued.dispatch.id)).toBeUndefined()
      expect((yield* goals.get(sessionID))?.usage.continuations).toBe(1)
      const pending = yield* reopened.get(sessionID)
      expect(yield* reopened.continued(sessionID, goal.intent)).toBeUndefined()
      expect(yield* reopened.get(sessionID)).toEqual(pending)
      yield* goals.revise(sessionID, "Explicitly revised direction")
      const next = yield* goals.continued(sessionID)
      if (!next?.dispatch) throw new Error("Next dispatch was not saved")
      yield* goals.revise(sessionID, "A different direction")
      expect(yield* goals.dispatched(sessionID, next.dispatch.id)).toBeUndefined()
      expect((yield* goals.get(sessionID))?.dispatch?.phase).toBe("queued")
      const retry = yield* goals.retried(sessionID, "stream dropped", "retry-event")
      if (!retry?.dispatch) throw new Error("Retry dispatch was not saved")
      expect(retry.dispatch.messageID).toStartWith("msg")
      expect(yield* goals.retried(sessionID, "stream dropped", "retry-event")).toBeUndefined()
      expect((yield* goals.get(sessionID))?.dispatch?.messageID).toBe(retry.dispatch.messageID)
      yield* storage.replace(["raya", "goal", sessionID], {
        ...retry,
        dispatch: { ...retry.dispatch, messageID: undefined },
      })
      const legacy = yield* reopened.dispatched(sessionID, retry.dispatch.id)
      expect(legacy?.dispatch?.messageID).toStartWith("msg")
      expect((yield* goals.get(sessionID))?.dispatch?.messageID).toBe(legacy?.dispatch?.messageID)
      expect(yield* goals.dispatched(sessionID, retry.dispatch.id)).toBeUndefined()
    }),
  )

  it.live("captures only an active goal direction and leaves unreadable state intact", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const capture = yield* observer
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      expect(yield* capture(sessionID)).toBe("none")
      const created = yield* goals.create(sessionID, "Capture this direction")
      expect(yield* capture(sessionID)).toBe(created.intent ?? "unset")
      yield* goals.continued(sessionID)
      expect(yield* capture(sessionID)).toBe(created.intent ?? "unset")
      yield* goals.control(sessionID, "paused")
      expect(yield* capture(sessionID)).toBe("none")
      const resumed = yield* goals.control(sessionID, "active")
      expect(yield* capture(sessionID)).toBe(resumed.intent ?? "unset")
      expect(resumed.intent).not.toBe(created.intent)
      yield* storage.replace(["raya", "goal", sessionID], { ...resumed, intent: undefined })
      expect(yield* capture(sessionID)).toBe("unset")
      yield* storage.replace(["raya", "goal", sessionID], { malformed: true })
      expect(yield* capture(sessionID)).toBe("none")
      expect(yield* storage.read(["raya", "goal", sessionID])).toEqual({ malformed: true })
    }),
  )

  it.live("conditional clear preserves newer goals and permits accounting-only changes", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID).pipe(Effect.orDie))
      const first = yield* goals.create(sessionID, "Keep the reviewed objective")
      const revised = yield* goals.revise(sessionID, "Keep the newer objective")
      const stale = yield* goals.clear(sessionID, first.intent ?? "unset").pipe(Effect.flip)
      expect(stale).toMatchObject({ _tag: "RayaGoal.AuditError", conflict: true })
      expect(yield* goals.get(sessionID)).toEqual(revised)
      yield* goals.continued(sessionID)
      yield* goals.clear(sessionID, revised.intent ?? "unset")
      expect(yield* goals.get(sessionID)).toBeUndefined()
      const replay = yield* goals.clear(sessionID, revised.intent ?? "unset").pipe(Effect.flip)
      expect(replay).toMatchObject({ _tag: "RayaGoal.AuditError", conflict: true })
      const replacement = yield* goals.create(sessionID, "A different goal")
      yield* goals.clear(sessionID, revised.intent ?? "unset").pipe(Effect.flip)
      expect(yield* goals.get(sessionID)).toEqual(replacement)
      const unset = yield* goals.clear(sessionID, "unset").pipe(Effect.flip)
      expect(unset).toMatchObject({ _tag: "RayaGoal.AuditError", conflict: true })
      expect(yield* goals.get(sessionID)).toEqual(replacement)
      const legacy = { ...replacement, intent: undefined }
      yield* storage.replace(["raya", "goal", sessionID], legacy)
      yield* goals.clear(sessionID, "unset")
      expect(yield* goals.get(sessionID)).toBeUndefined()
      const next = yield* goals.create(sessionID, "Stop once")
      const results = yield* Effect.all(
        [goals.clear(sessionID, next.intent ?? "unset"), goals.clear(sessionID, next.intent ?? "unset")].map(
          Effect.exit,
        ),
        { concurrency: "unbounded" },
      )
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      expect(results.filter(Exit.isFailure)).toHaveLength(1)
      expect(yield* goals.get(sessionID)).toBeUndefined()
    }),
  )

  test("emits provider-compatible object parameters for update_goal", () => {
    expect(ToolJsonSchema.fromSchema(RayaGoal.ModelUpdate).type).toBe("object")
  })

  it.live("distinguishes control changes from accounting and rejects old control revisions", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const goals = setup(storage, () => data.rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const created = yield* goals.create(sessionID, "Original direction")
      expect(created.intent).toBeString()
      expect((yield* goals.continued(sessionID))?.intent).toBe(created.intent)
      expect((yield* goals.retried(sessionID, "a stream error", "error"))?.intent).toBe(created.intent)
      expect((yield* goals.recordTurn(sessionID))?.state.intent).toBe(created.intent)
      yield* goals.revise(sessionID, "Temporary direction")
      const restored = yield* goals.revise(sessionID, "Original direction")
      expect(restored.intent).not.toBe(created.intent)
      expect(yield* goals.continued(sessionID, created.intent)).toBeUndefined()
      expect(yield* goals.retried(sessionID, "a stream error", "stale", created.intent)).toBeUndefined()
      expect(yield* goals.recordTurn(sessionID, undefined, created.intent)).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(restored)
      const paused = yield* goals.control(sessionID, "paused")
      const resumed = yield* goals.control(sessionID, "active")
      expect(paused.intent).not.toBe(restored.intent)
      expect(resumed.intent).not.toBe(paused.intent)
      const model = yield* goals.update(sessionID, { status: "paused", reason: "Awaiting a decision" })
      const active = yield* goals.update(sessionID, { status: "active" })
      expect(model.intent).not.toBe(resumed.intent)
      expect(active.intent).not.toBe(model.intent)
      expect((yield* setup(storage, () => data.rows).get(sessionID))?.intent).toBe(active.intent)
    }),
  )

  it.live("recovers bounded accounting conflicts without crossing steering or pause-resume changes", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const action of ["account", "steer", "restore", "resume", "block", "busy"] as const) {
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const data = transcript({ sessionID, tool: "bash", exit: 0 })
        const goals = setup(storage, () => data.rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Original direction")
        let calls = 0
        let runs = 0
        let close:
          | ((event: {
              properties: { sessionID: SessionID; messageID: MessageID; reason: "completed" }
            }) => Fiber.Fiber<unknown, unknown>)
          | undefined
        const bus = {
          subscribeCallback: (_event, callback) => {
            close = callback as typeof close
            return Effect.succeed(() => {})
          },
        } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
        yield* RayaGoalContinuation.subscribe({
          bus,
          storage,
          sessions: {
            get: () => Effect.succeed({ directory: process.cwd() }),
            children: () => Effect.succeed([]),
            messages: () =>
              Effect.gen(function* () {
                calls += 1
                if (action === "busy")
                  yield* goals.retried(sessionID, "concurrent provider recovery", crypto.randomUUID())
                if (action === "account" && calls === 1) yield* goals.continued(sessionID)
                if (calls === 1 && (action === "steer" || action === "restore")) {
                  yield* goals.revise(sessionID, "New direction")
                  if (action === "restore") yield* goals.revise(sessionID, "Original direction")
                }
                if (calls === 1 && action === "resume") {
                  yield* goals.control(sessionID, "paused")
                  yield* goals.control(sessionID, "active")
                }
                if (calls === 1 && action === "block") {
                  yield* goals.update(sessionID, { status: "blocked", reason: "New blocker" })
                }
                return data.rows
              }),
          } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
          run: async () => void runs++,
        })
        if (!close) throw new Error("Missing turn-close subscription")
        yield* Fiber.join(close({ properties: { sessionID, messageID: data.rows[1].info.id, reason: "completed" } }))
        expect(runs).toBe(action === "account" ? 1 : 0)
        // Successful recovery reads twice for accounting, then once for dispatch preflight.
        expect(calls).toBe(action === "account" || action === "busy" ? 3 : 1)
        const saved = yield* goals.get(sessionID)
        expect(saved?.usage.turns).toBe(action === "account" ? 1 : 0)
        expect(saved?.objective).toBe(action === "steer" ? "New direction" : "Original direction")
        expect(saved?.status).toBe(action === "block" ? "blocked" : "active")
        if (action === "block") expect(saved?.blockedReason).toBe("New blocker")
      }
    }),
  )

  it.live("edits objective and status atomically against the reviewed control revision", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const created = yield* goals.create(sessionID, "Original direction")
      yield* goals.continued(sessionID)
      let writes = 0
      const editor = setup(
        {
          ...storage,
          replace: (key, value) =>
            Effect.gen(function* () {
              if (key.join("/") === `raya/goal/${sessionID}`) writes += 1
              yield* storage.replace(key, value)
            }),
        },
        () => [],
      )
      const changed = yield* editor.edit(sessionID, {
        objective: "New direction",
        status: "paused",
        expectedIntent: created.intent,
      })
      expect(writes).toBe(1)
      expect(changed.prior.objective).toBe("Original direction")
      expect(changed.state.objective).toBe("New direction")
      expect(changed.state.status).toBe("paused")
      expect(changed.state.usage.continuations).toBe(1)
      expect(changed.state.intent).not.toBe(created.intent)
      expect(
        yield* editor
          .edit(sessionID, { objective: "Stale direction", expectedIntent: created.intent })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "RayaGoal.AuditError", conflict: true })
      expect(writes).toBe(1)
      expect(yield* goals.get(sessionID)).toEqual(changed.state)
      expect(
        (yield* editor
          .edit(sessionID, { objective: "  ", status: "active", expectedIntent: changed.state.intent })
          .pipe(Effect.flip)).message,
      ).toContain("objective")
      expect(yield* goals.get(sessionID)).toEqual(changed.state)
      expect(writes).toBe(1)
      const resumed = yield* editor.edit(sessionID, { status: "active", expectedIntent: changed.state.intent })
      expect(resumed.state.status).toBe("active")
      expect(resumed.state.objective).toBe("New direction")
      expect(writes).toBe(2)
      yield* storage.write(["raya", "goal", sessionID], { ...resumed.state, intent: undefined })
      const legacy = yield* editor.edit(sessionID, {
        objective: "Legacy direction",
        status: "paused",
        expectedIntent: "unset",
      })
      expect(legacy.state.intent).toBeString()
      expect(legacy.state.status).toBe("paused")
      expect(
        yield* editor.edit(sessionID, { objective: "Old legacy draft", expectedIntent: "unset" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "RayaGoal.AuditError", conflict: true })
      expect(yield* goals.get(sessionID)).toEqual(legacy.state)
    }),
  )

  it.live("persists pause and resume state across service recreation", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const messageID = MessageID.ascending()
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))

      const created = yield* goals.create(sessionID, "Ship verified goal mode", messageID)
      expect(created.status).toBe("active")
      expect(created.startMessageID).toBe(messageID)
      expect((yield* goals.create(sessionID, "Ship verified goal mode")).createdAt).toBe(created.createdAt)
      yield* goals.control(sessionID, "paused")
      const revised = yield* goals.revise(sessionID, "Ship the revised verified goal")
      expect(revised.objective).toBe("Ship the revised verified goal")
      expect(revised.status).toBe("paused")
      expect(revised.progress.at(-1)?.message).toContain("current step will finish")

      const reloaded = setup(storage, () => [])
      expect((yield* reloaded.get(sessionID))?.status).toBe("paused")
      yield* reloaded.control(sessionID, "active")
      const queued = yield* reloaded.continued(sessionID)
      let directory = ""
      let message: MessageID | undefined
      yield* RayaGoalContinuation.resume({
        sessionID,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async (_sid, _goal, dir, id) => {
          message = id
          directory = dir
        },
      })
      expect((yield* goals.get(sessionID))?.status).toBe("active")
      expect((yield* goals.get(sessionID))?.usage.continuations).toBe(1)
      expect(directory).toBe(process.cwd())
      expect(message).toStartWith("msg")
      expect((yield* goals.get(sessionID))?.dispatch?.messageID).toBe(message)
      expect(message).toBe(queued?.dispatch?.messageID)
      const started = yield* goals.get(sessionID)
      yield* RayaGoalContinuation.resume({
        sessionID,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async () => {
          throw new Error("An unconfirmed started dispatch must not be replayed")
        },
      })
      expect(yield* goals.get(sessionID)).toEqual(started)
    }),
  )

  it.live("binds only the matching saved dispatch to an observed running worker", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const scope = yield* Scope.Scope
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const rows: MessageV2.WithParts[] = []
      const sessions = {
        get: () => Effect.succeed({ directory: process.cwd() }),
        messages: () => Effect.succeed(rows),
        children: () => Effect.succeed([]),
      } as unknown as Pick<Session.Interface, "get" | "messages" | "children">
      const goals = RayaGoal.make({ storage, sessions })
      yield* goals.create(sessionID, "Bind owned work")
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const queued = yield* goals.continued(sessionID)
      if (!queued?.dispatch) throw new Error("Missing dispatch")
      yield* goals.dispatched(sessionID, queued.dispatch.id)
      const runner = Runner.make<string>(scope)
      const runs = { inspect: () => Effect.succeed(observe(runner)) }
      const bind = yield* binding
      yield* bind(sessions, runs, sessionID)
      expect((yield* goals.get(sessionID))?.dispatch?.worker).toBeUndefined()
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const fiber = yield* runner
        .ensureRunning(
          Effect.gen(function* () {
            yield* bind(sessions, runs, sessionID)
            expect((yield* goals.get(sessionID))?.dispatch?.worker).toBeUndefined()
            const user = transcript({ sessionID }).rows[0]
            user.info.id = queued.dispatch!.messageID!
            rows.push(user)
            rows.push(transcript({ sessionID }).rows[0])
            yield* bind(sessions, runs, sessionID)
            expect((yield* goals.get(sessionID))?.dispatch?.worker).toBeUndefined()
            rows.pop()
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(release)
            const before = yield* goals.get(sessionID)
            yield* bind(sessions, runs, sessionID)
            const saved = yield* goals.get(sessionID)
            expect(saved?.dispatch?.worker).toBe(observe(runner).id)
            expect(saved?.usage).toEqual(before?.usage)
            expect(saved?.intent).toBe(before?.intent)
            yield* bind(sessions, runs, sessionID)
            expect(yield* goals.get(sessionID)).toEqual(saved)
            expect(yield* goals.bound(sessionID, queued.dispatch!.id, "replacement")).toBeUndefined()
            expect(yield* goals.get(sessionID)).toEqual(saved)
            return saved!.dispatch!.worker!
          }).pipe(Effect.orDie),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      // Even matching transcript and observed state cannot confer ownership on an outside caller.
      yield* bind(sessions, runs, sessionID)
      expect((yield* goals.get(sessionID))?.dispatch?.worker).toBeUndefined()
      const other = Runner.make<void>(scope)
      yield* other.ensureRunning(bind(sessions, runs, sessionID).pipe(Effect.asVoid))
      expect((yield* goals.get(sessionID))?.dispatch?.worker).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const worker = yield* Fiber.join(fiber)
      expect((yield* goals.get(sessionID))?.dispatch?.worker).toBe(worker)
    }),
  )

  it.live("interrupting continuation propagates an abort signal without inventing a terminal outcome", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* goals.create(sessionID, "Continue interruptible work")
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const entered = Promise.withResolvers<AbortSignal>()
      const stopped = Promise.withResolvers<void>()
      const fiber = yield* RayaGoalContinuation.resume({
        sessionID,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async (_id, _objective, _directory, _message, _queued, signal) => {
          entered.resolve(signal)
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                stopped.resolve()
                resolve()
              },
              { once: true },
            ),
          )
        },
      }).pipe(Effect.forkChild)
      const signal = yield* Effect.promise(() => entered.promise)
      expect(signal.aborted).toBe(false)
      const before = yield* goals.get(sessionID)
      yield* Fiber.interrupt(fiber)
      yield* Effect.promise(() => stopped.promise)
      expect(signal.aborted).toBe(true)
      expect(yield* goals.get(sessionID)).toEqual(before)
      expect(before?.dispatch?.phase).toBe("started")
      expect(before?.status).toBe("active")
    }),
  )

  it.live("overlapping startup scans share two handoff slots while retaining a bounded queue", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const goals = setup(storage, () => [])
      const ids: SessionID[] = []
      for (let index = 0; index < 4; index++) {
        const id = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        ids.push(id)
        yield* goals.create(id, "Recover independent work")
        yield* goals.continued(id)
        yield* Effect.addFinalizer(() => goals.clear(id))
      }
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      let active = 0
      let maximum = 0
      const runs: SessionID[] = []
      const fiber = yield* Effect.all(
        [ids.slice(0, 2), ids.slice(2)].map((group) =>
          RayaGoalContinuation.restore({
            directory: process.cwd(),
            storage: { ...storage, list: () => Effect.succeed(group.map((id) => ["raya", "goal", id])) },
            sessions: {
              get: (id: SessionID) => Effect.succeed({ id, directory: process.cwd() }),
              messages: () => Effect.succeed([]),
              children: () => Effect.succeed([]),
            } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
            enabled: () => Effect.succeed(true),
            idle: () => Effect.succeed(true),
            run: async (id) => {
              runs.push(id)
              active++
              maximum = Math.max(maximum, active)
              if (runs.length === 2) entered.resolve()
              await release.promise
              active--
            },
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild)
      yield* Effect.promise(() => entered.promise)
      expect(runs).toHaveLength(2)
      expect(maximum).toBe(2)
      const states = yield* Effect.forEach(ids, (id) => goals.get(id))
      expect(states.filter((state) => state?.dispatch?.phase === "started")).toHaveLength(2)
      expect(states.filter((state) => state?.dispatch?.phase === "queued")).toHaveLength(2)
      release.resolve()
      yield* Fiber.join(fiber)
      expect(new Set(runs).size).toBe(4)
      expect(maximum).toBe(2)
      expect(active).toBe(0)
    }),
  )

  it.live("startup recovery respects workspace, busy state, settings and persisted dispatch identity", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const goals = setup(storage, () => [])
      const entries = new Map<SessionID, string>()
      for (const kind of ["queued", "foreign", "busy", "becamebusy", "paused", "started", "missing", "untracked"]) {
        const id = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        entries.set(id, kind)
        yield* goals.create(id, `Recover ${kind}`)
        yield* Effect.addFinalizer(() => goals.clear(id))
        if (kind === "untracked") continue
        const queued = yield* goals.continued(id)
        if (kind === "paused") yield* goals.control(id, "paused")
        if (kind === "started" && queued?.dispatch) yield* goals.dispatched(id, queued.dispatch.id)
      }
      const runs: SessionID[] = []
      const checks = new Map<SessionID, number>()
      let enabled = false
      let reads = 0
      const input = {
        directory: process.cwd(),
        storage: { ...storage, list: () => Effect.succeed([...entries.keys()].map((id) => ["raya", "goal", id])) },
        sessions: {
          get: (id: SessionID) => {
            reads++
            if (entries.get(id) === "missing") return Effect.die(new Error("Session unavailable"))
            return Effect.succeed({
              id,
              directory: entries.get(id) === "foreign" ? path.join(process.cwd(), "other") : process.cwd(),
            })
          },
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        enabled: () => Effect.succeed(enabled),
        idle: (id: SessionID) => {
          const count = (checks.get(id) ?? 0) + 1
          checks.set(id, count)
          return Effect.succeed(entries.get(id) !== "busy" && (entries.get(id) !== "becamebusy" || count < 3))
        },
        run: async (id: SessionID) => {
          runs.push(id)
        },
      }
      yield* RayaGoalContinuation.restore(input)
      expect(reads).toBe(0)
      enabled = true
      yield* RayaGoalContinuation.restore(input)
      expect(runs.map((id) => entries.get(id))).toEqual(["queued"])
      yield* RayaGoalContinuation.restore(input)
      expect(runs).toHaveLength(1)
      for (const [id, kind] of entries) {
        const saved = yield* goals.get(id)
        expect(saved?.usage.continuations).toBe(kind === "untracked" ? 0 : 1)
        expect(saved?.dispatch?.phase).toBe(
          kind === "untracked" ? undefined : kind === "queued" || kind === "started" ? "started" : "queued",
        )
      }
    }),
  )

  for (const boundary of ["started", "finished", "accounted", "error", "interrupted", "superseded", "changed"] as const)
    it.live(`resume reconciles a saved completed turn without replaying an unconfirmed attempt: ${boundary}`, () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const rows: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Recover verified work")
        const queued = yield* goals.continued(sessionID)
        if (!queued?.dispatch) throw new Error("Missing queued dispatch")
        const started = yield* goals.dispatched(sessionID, queued.dispatch.id)
        if (!started?.dispatch?.messageID) throw new Error("Missing started dispatch")
        const data = transcript({ sessionID, tool: "bash", exit: 0 })
        const user = data.rows[0].info
        const reply = data.rows[1].info
        if (user.role !== "user" || reply.role !== "assistant") throw new Error("Invalid transcript")
        user.id = started.dispatch.messageID
        reply.parentID = user.id
        reply.time.completed = undefined
        rows.push(...data.rows)
        let runs = 0
        const input = {
          sessionID,
          storage,
          sessions: {
            get: () => Effect.succeed({ directory: process.cwd() }),
            messages: () => Effect.succeed(rows),
            children: () => Effect.succeed([]),
          } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
          run: async () => void runs++,
        }
        yield* RayaGoalContinuation.resume(input)
        expect(runs).toBe(0)
        expect(yield* goals.get(sessionID)).toEqual(started)
        reply.time.completed = Date.now() + 1
        reply.error = { name: "UnknownError", data: { message: "Unrecovered provider failure" } }
        yield* RayaGoalContinuation.resume(input)
        expect(runs).toBe(0)
        expect(yield* goals.get(sessionID)).toEqual(started)
        reply.error = undefined
        if (boundary !== "started") {
          if (boundary === "error") reply.error = { name: "UnknownError", data: { message: "Saved failure" } }
          yield* goals.finished(
            sessionID,
            reply.id,
            boundary === "error" || boundary === "interrupted" ? boundary : "completed",
          )
        }
        if (boundary === "accounted" || boundary === "superseded" || boundary === "changed")
          yield* goals.recordTurn(sessionID, reply.id)
        if (boundary === "superseded") rows.push(transcript({ sessionID }).rows[0])
        if (boundary === "changed") reply.time.completed = undefined
        const before = yield* goals.get(sessionID)
        if (boundary === "accounted") {
          expect(yield* goals.finished(sessionID, reply.id, "completed", true)).toEqual(before)
          expect(yield* goals.get(sessionID)).toEqual(before)
        }
        yield* RayaGoalContinuation.resume(input)
        if (boundary === "error" || boundary === "interrupted" || boundary === "superseded" || boundary === "changed") {
          expect(runs).toBe(0)
          expect(yield* goals.get(sessionID)).toEqual(before)
          return
        }
        const recovered = yield* goals.get(sessionID)
        expect(runs).toBe(1)
        expect(recovered?.usage.turns).toBe(1)
        expect(recovered?.usage.continuations).toBe(2)
        expect(recovered?.dispatch?.messageID).not.toBe(user.id)
        expect(recovered?.accounted?.messages).toContain(reply.id)
        yield* RayaGoalContinuation.resume(input)
        expect(runs).toBe(1)
        expect(yield* goals.get(sessionID)).toEqual(recovered)
      }),
    )

  it.live("continuation dispatch rechecks steering, pause and deletion and cannot block a newer revision", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const action of ["steer", "pause", "clear", "failure", "error"]) {
        const sessionID = SessionID.make(`ses_dispatch_${crypto.randomUUID()}`)
        const goals = setup(storage, () => [])
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Original objective")
        let pending = false
        const calls: string[] = []
        const session = {
          id: sessionID,
          slug: "dispatch",
          projectID: ProjectV2.ID.make("project"),
          directory: process.cwd(),
          title: "Dispatch",
          version: "test",
          time: { created: Date.now(), updated: Date.now() },
        }
        const outcome = yield* RayaGoalContinuation.resume({
          sessionID,
          storage: {
            ...storage,
            replace: (key, value) =>
              storage.replace(key, value).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (key[1] === "goal") pending = true
                  }),
                ),
              ),
            read: <T>(key: string[]) =>
              Effect.gen(function* () {
                if (key[1] === "goal" && pending) {
                  pending = false
                  if (action === "steer") yield* goals.revise(sessionID, "Revised objective").pipe(Effect.orDie)
                  if (action === "pause") yield* goals.control(sessionID, "paused").pipe(Effect.orDie)
                  if (action === "clear") yield* goals.clear(sessionID)
                }
                return yield* storage.read<T>(key)
              }),
          },
          sessions: {
            get: () => Effect.succeed(session),
            messages: () => Effect.succeed([]),
            children: () => Effect.succeed([]),
          },
          run: async (_id, objective) => {
            calls.push(objective)
            if (action !== "failure" && action !== "error") return
            if (action === "failure") await Effect.runPromise(goals.revise(sessionID, "New objective after dispatch"))
            throw new Error("Old dispatch failed")
          },
        }).pipe(Effect.exit)
        if (action === "steer") {
          expect(Exit.isSuccess(outcome)).toBe(true)
          expect(calls).toEqual([])
          expect((yield* goals.get(sessionID))?.objective).toBe("Revised objective")
        }
        if (action === "pause" || action === "clear") {
          expect(Exit.isSuccess(outcome)).toBe(true)
          expect(calls).toEqual([])
          expect((yield* goals.get(sessionID))?.status).toBe(action === "pause" ? "paused" : undefined)
        }
        if (action === "failure") {
          expect(Exit.isFailure(outcome)).toBe(true)
          expect(calls).toEqual(["Original objective"])
          expect(yield* goals.get(sessionID)).toMatchObject({
            status: "active",
            objective: "New objective after dispatch",
          })
          expect((yield* goals.get(sessionID))?.blockedReason).toBeUndefined()
        }
        if (action === "error") {
          expect(Exit.isSuccess(outcome)).toBe(true)
          expect(yield* goals.get(sessionID)).toMatchObject({
            status: "blocked",
            blockedReason: "Automatic continuation failed: Old dispatch failed",
          })
        }
      }
    }),
  )

  it.live("archives a completed goal when a new /goal is armed", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const criteria = [{ id: "date", description: "The date comment is on line 1", verification: "Inspect line 1" }]
      const goal = yield* goals.create(sessionID, "Add the date comment", undefined, undefined, undefined, criteria)
      const planned = yield* goals.plan(sessionID, {
        expectedIntent: goal.intent!,
        expectedRevision: null,
        tasks: [
          {
            id: "date",
            description: "Add date",
            output: "Date comment",
            owner: "code",
            verification: "Inspect line 1",
            status: "completed",
            dependencies: [],
          },
        ],
      })
      expect(planned.status).toBe("active")
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = data.rows
      yield* goals.recordTurn(sessionID)
      yield* goals.update(sessionID, {
        status: "complete",
        summary: "The date comment is on line 1.",
        audit: {
          requirements: [
            {
              requirement: "The date comment is on line 1",
              criterionID: "date",
              passed: true,
              evidence: [{ callID: data.part!.callID, summary: "The edit completed." }],
            },
          ],
        },
      })
      const next = yield* goals.create(sessionID, "Add it again")
      expect(next.history?.[0].plan).toEqual(planned.plan)
      expect(next.plan).toBeUndefined()
      expect(next.history?.[0].usage).toMatchObject({ turns: 1, toolCalls: 1, continuations: 0 })
      expect(next.history?.[0].activeMs).toBeGreaterThanOrEqual(0)
      expect(next.usage).toMatchObject({ turns: 0, toolCalls: 0, continuations: 0 })
      expect(next.status).toBe("active")
      expect(next.objective).toBe("Add it again")
      expect(next.history).toEqual([expect.objectContaining({ objective: "Add the date comment", status: "complete" })])
      expect(next.history?.[0].audit?.requirements[0].evidence[0].record?.digest).toBe(digest(data.part!))
      expect(next.history?.[0].auditAttempt?.accepted).toBe(true)
      expect(next.audit).toBeUndefined()
      expect(next.auditAttempt).toBeUndefined()
      expect(next.criteria).toBeUndefined()
      expect(next.history?.[0].criteria).toEqual(criteria)
      expect((yield* setup(storage, () => rows).get(sessionID))?.history).toEqual(next.history)
      const clash = yield* goals.create(sessionID, "A second live goal").pipe(Effect.flip)
      expect(clash._tag).toBe("RayaGoal.ExistsError")
    }),
  )

  it.live("an in-flight completion cannot overwrite steering, pause, deletion or a newer rejection context", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const action of ["revise", "pause", "clear", "reject"]) {
        const sessionID = SessionID.make(`ses_revision_${crypto.randomUUID()}`)
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let rows: MessageV2.WithParts[] = []
        const goals = RayaGoal.make({
          storage,
          sessions: {
            messages: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
                return rows
              }),
            children: () => Effect.succeed([]),
          },
        })
        const current = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => current.clear(sessionID))
        const original = yield* goals.create(sessionID, "Original objective")
        const data = transcript({ sessionID, tool: "bash", exit: action === "reject" ? 1 : 0 })
        rows = data.rows
        const fiber = yield* goals
          .update(sessionID, {
            status: "complete",
            summary: "Done",
            requirements: [
              {
                requirement: "The command passed",
                passed: true,
                evidence: [{ callID: data.part!.callID, summary: "Verified command" }],
              },
            ],
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        if (action === "clear") yield* current.clear(sessionID)
        if (action === "pause") yield* current.control(sessionID, "paused")
        if (action === "revise" || action === "reject") yield* current.revise(sessionID, "Revised objective")
        const expected = yield* current.get(sessionID)
        if (expected) expect(expected.revision).not.toBe(original.revision)
        yield* Deferred.succeed(release, undefined)
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
        expect(yield* current.get(sessionID)).toEqual(expected)
        expect(expected?.auditAttempt).toBeUndefined()
      }
    }),
  )

  it.live(
    "goal writes recover a stopped process and observe revisions from another backend",
    () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        yield* Effect.gen(function* () {
          const storage = yield* Storage.Service
          const goals = setup(storage, () => [])
          const sessionID = SessionID.make("ses_process_revision")
          const original = yield* goals.create(sessionID, "Original")
          const run = (action: string) =>
            spawnSync(
              process.execPath,
              [path.join(import.meta.dir, "fixtures/goal-write.ts"), directory, sessionID, action],
              {
                windowsHide: true,
                encoding: "utf8",
                timeout: 15_000,
                env: {
                  ...process.env,
                  XDG_DATA_HOME: path.join(directory, "data"),
                  XDG_CACHE_HOME: path.join(directory, "cache"),
                  XDG_CONFIG_HOME: path.join(directory, "config"),
                  XDG_STATE_HOME: path.join(directory, "state"),
                  KILO_TEST_HOME: path.join(directory, "home"),
                  KILO_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
                  KILO_MODELS_PATH: path.join(import.meta.dir, "../tool/fixtures/models-api.json"),
                },
              },
            )
          const crashed = run("crash")
          expect(crashed.status, crashed.stderr).toBe(21)
          const recovered = yield* goals.revise(sessionID, "Recovered")
          expect(recovered.revision).not.toBe(original.revision)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const data = transcript({ sessionID, tool: "bash", exit: 0 })
          const pending = RayaGoal.make({
            storage,
            sessions: {
              messages: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  return data.rows
                }),
              children: () => Effect.succeed([]),
            },
          })
          const completion = yield* pending
            .update(sessionID, {
              status: "complete",
              summary: "Done",
              requirements: [
                {
                  requirement: "Command succeeds",
                  passed: true,
                  evidence: [{ callID: data.part!.callID, summary: "Command passed" }],
                },
              ],
            })
            .pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          const written = run("Child edit")
          expect(written.status, written.stderr).toBe(0)
          const current = yield* goals.get(sessionID)
          expect(current?.objective).toBe("Child edit")
          expect(current?.revision).not.toBe(recovered.revision)
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isFailure(yield* Fiber.await(completion))).toBe(true)
          expect(yield* goals.get(sessionID)).toEqual(current)
        }).pipe(Effect.provide(Storage.layerFromDir(directory)))
      }),
    30_000,
  )

  it.live("saved criteria cannot be omitted, duplicated, renamed or replaced during completion", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_criteria_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const criteria = [
        { id: "sources", description: "List source documents", verification: "Check source references" },
        {
          id: "coverage",
          description: "Report unavailable inputs",
          verification: "Compare the report against requested inputs",
        },
      ]
      const original = yield* goals.create(
        sessionID,
        "Prepare a verified report",
        undefined,
        undefined,
        undefined,
        criteria,
      )
      expect(
        (yield* goals.create(sessionID, "Prepare a verified report", undefined, undefined, undefined, criteria))
          .createdAt,
      ).toBe(original.createdAt)
      expect(
        (yield* goals
          .create(sessionID, "Prepare a verified report", undefined, undefined, undefined, criteria.slice(0, 1))
          .pipe(Effect.flip))._tag,
      ).toBe("RayaGoal.ExistsError")
      expect((yield* setup(storage, () => rows).get(sessionID))?.criteria).toEqual(criteria)
      expect((yield* goals.create(sessionID, "Prepare a verified report").pipe(Effect.flip))._tag).toBe(
        "RayaGoal.ExistsError",
      )
      yield* goals.revise(sessionID, "Prepare the report with additional context")
      expect((yield* goals.get(sessionID))?.criteria).toEqual(criteria)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = data.rows
      const requirements = criteria.map((item) => ({
        criterionID: item.id,
        requirement: item.description,
        passed: true,
        evidence: [{ callID: data.part!.callID, summary: "The stored check reports success." }],
      }))
      for (const rejected of [
        [requirements[0]],
        [...requirements, requirements[0]],
        [{ ...requirements[0], criterionID: "invented" }, requirements[1]],
        [{ ...requirements[0], requirement: "A weaker requirement" }, requirements[1]],
        [{ ...requirements[0], evidence: [] }, requirements[1]],
        [{ ...requirements[0], passed: false }, requirements[1]],
      ]) {
        expect(
          (yield* goals
            .update(sessionID, { status: "complete", requirements: rejected, summary: "Report complete" })
            .pipe(Effect.flip))._tag,
        ).toBe("RayaGoal.AuditError")
        const saved = yield* goals.get(sessionID)
        expect(saved?.status).toBe("active")
        expect(saved?.criteria).toEqual(criteria)
        expect(saved?.auditAttempt?.accepted).toBe(false)
      }
      const complete = yield* setup(storage, () => rows).update(sessionID, {
        status: "complete",
        requirements,
        summary: "Report checks passed",
      })
      expect(complete.status).toBe("complete")
      expect(complete.audit?.requirements.map((item) => item.criterionID)).toEqual(["sources", "coverage"])
    }),
  )

  it.live("ambiguous provider call IDs require an exact successful tool-result identity", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_evidence_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Verify the command result")
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const part = data.part!
      if (part.state.status !== "completed") throw new Error("Expected completed fixture")
      const failed: MessageV2.ToolPart = {
        ...part,
        id: PartID.ascending(),
        state: { ...part.state, metadata: { exit: 1 }, output: "failed" },
      }
      const submit = (evidence: RayaGoal.Evidence) =>
        goals.update(sessionID, {
          status: "complete",
          summary: "Command verified",
          requirements: [{ requirement: "The command succeeds", passed: true, evidence: [evidence] }],
        })
      const evidence = { callID: part.callID, summary: "The selected stored command succeeded." }
      for (const parts of [
        [part, failed],
        [failed, part],
      ]) {
        rows = [data.rows[0], { ...data.rows[1], parts }]
        expect((yield* submit(evidence).pipe(Effect.flip)).message).toContain("ambiguous")
        expect((yield* submit({ ...evidence, messageID: part.messageID }).pipe(Effect.flip)).message).toContain(
          "partID",
        )
        expect((yield* goals.get(sessionID))?.status).toBe("active")
      }
      expect(yield* goals.evidence(sessionID)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callID: part.callID, messageID: part.messageID, partID: part.id, sessionID }),
          expect.objectContaining({ callID: failed.callID, partID: failed.id, exit: 1 }),
        ]),
      )
      expect((yield* submit({ ...evidence, partID: failed.id }).pipe(Effect.flip)).message).toContain(
        "did not exit successfully",
      )
      expect(
        (yield* submit({ ...evidence, partID: part.id, messageID: MessageID.ascending() }).pipe(Effect.flip)).message,
      ).toContain("not a completed")
      expect(
        (yield* submit({ ...evidence, partID: part.id, sessionID: SessionID.make("ses_wrong") }).pipe(Effect.flip))
          .message,
      ).toContain("not a completed")
      const accepted = yield* submit({ ...evidence, partID: part.id })
      expect(accepted.status).toBe("complete")
      expect(accepted.audit?.requirements[0].evidence[0]).toEqual({
        ...evidence,
        record: { version: 1, digest: digest(part), at: expect.any(Number) },
        partID: part.id,
        messageID: part.messageID,
        sessionID,
      })
      expect((yield* setup(storage, () => rows).get(sessionID))?.audit).toEqual(accepted.audit)
    }),
  )

  it.live("completes only when every requirement cites real green command evidence", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Complete only after the test passes")
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = data.rows
      expect(yield* goals.evidence(sessionID)).toEqual([
        expect.objectContaining({ messageID: data.part!.messageID, callID: data.part!.callID, exit: 0 }),
      ])

      const complete = yield* goals.update(sessionID, {
        status: "complete",
        audit: {
          summary: "The required command passed.",
          requirements: [
            {
              requirement: "The test command passes",
              passed: true,
              evidence: [
                {
                  callID: data.part!.callID,
                  summary: "The persisted bash result exited with code 0.",
                },
              ],
            },
          ],
        },
      })
      expect(complete.status).toBe("complete")
      expect(complete.audit?.requirements).toHaveLength(1)
      expect(complete.audit?.requirements[0].evidence[0]).toMatchObject({
        partID: data.part!.id,
        messageID: data.part!.messageID,
        sessionID,
      })
    }),
  )

  // raya_change - the Auto orchestrator delegates the real work to a subagent, so
  // the proving tool call lives in a child session. Evidence gathering and the
  // completion audit must see it, otherwise a genuinely finished goal is forced to
  // blocked because none of its evidence is "eligible".
  it.live("accepts evidence from a delegated subagent child session", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const parentID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const childID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let childRows: MessageV2.WithParts[] = []
      let parentRows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => [], {
        messagesFor: (id) => (id === childID ? childRows : parentRows),
        children: (id) => (id === parentID ? [{ id: childID } as unknown as Session.Info] : []),
      })
      yield* Effect.addFinalizer(() => goals.clear(parentID))
      yield* goals.create(parentID, "Create jesus.txt via a delegated agent")
      const child = transcript({ sessionID: childID, tool: "write", output: "wrote jesus.txt" })
      childRows = child.rows
      const parent = transcript({ sessionID: parentID, tool: "bash", exit: 1 })
      parentRows = parent.rows.map((row) => ({
        ...row,
        parts: row.parts.map((part) => (part.type === "tool" ? { ...part, callID: child.part!.callID } : part)),
      }))
      parentRows.push(
        ...transcript({
          sessionID: parentID,
          tool: "task",
          metadata: { parentSessionId: parentID, sessionId: childID, childMessageID: child.rows[0].info.id },
        }).rows,
      )

      expect(yield* goals.evidence(parentID)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callID: child.part!.callID, sessionID: childID }),
          expect.objectContaining({ callID: child.part!.callID, sessionID: parentID }),
        ]),
      )
      expect(
        (yield* goals
          .update(parentID, {
            status: "complete",
            summary: "Created",
            requirements: [
              {
                requirement: "The file is created by the subagent",
                passed: true,
                evidence: [{ callID: child.part!.callID, summary: "The write completed." }],
              },
            ],
          })
          .pipe(Effect.flip)).message,
      ).toContain("ambiguous")

      const complete = yield* goals.update(parentID, {
        status: "complete",
        audit: {
          summary: "The delegated subagent write created the file.",
          requirements: [
            {
              requirement: "The file is created by the subagent",
              passed: true,
              evidence: [
                {
                  callID: child.part!.callID,
                  messageID: child.part!.messageID,
                  summary: "The child-session write completed.",
                },
              ],
            },
          ],
        },
      })
      expect(complete.status).toBe("complete")
      expect(complete.audit?.requirements[0].evidence[0]).toMatchObject({ partID: child.part!.id, sessionID: childID })
    }),
  )

  it.live("delegation reports cannot prove completion but the child's actual work can", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const background of [true, false]) {
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const child = SessionID.make(`ses_child_${crypto.randomUUID()}`)
        const rows: MessageV2.WithParts[] = []
        const nested: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows, {
          messagesFor: (id) => (id === sessionID ? rows : nested),
          children: (id) => (id === sessionID ? [{ id: child } as Session.Info] : []),
        })
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Create and verify the delegated deliverable")
        const work = transcript({ sessionID: child, tool: "write", output: "Created the deliverable" })
        const report = transcript({
          sessionID,
          tool: "task",
          metadata: { parentSessionId: sessionID, sessionId: child, childMessageID: work.rows[0].info.id, background },
          output: background ? "Background task started" : "The child says everything is complete",
        })
        rows.push(...report.rows)
        expect(yield* goals.evidence(sessionID)).toEqual([])
        const submit = (part: MessageV2.ToolPart) =>
          goals.update(sessionID, {
            status: "complete",
            summary: "Deliverable created",
            requirements: [
              {
                requirement: "The deliverable is created",
                passed: true,
                evidence: [
                  { callID: part.callID, sessionID: part.sessionID, summary: "The referenced result confirms it" },
                ],
              },
            ],
          })
        const rejected = yield* submit(report.part!).pipe(Effect.flip)
        expect(rejected.message).toContain("not verified completion")
        expect(rejected.message).toContain("child's actual work or verification results")
        expect(yield* goals.get(sessionID)).toMatchObject({ status: "active", auditAttempt: { accepted: false } })
        nested.push(...work.rows)
        expect(yield* goals.evidence(sessionID)).toMatchObject([{ callID: work.part!.callID, sessionID: child }])
        expect((yield* submit(work.part!)).status).toBe("complete")
      }
    }),
  )

  it.live("completes when the audit summary lives on the top-level argument", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Accept a top-level completion summary")
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = data.rows
      const complete = yield* goals.update(sessionID, {
        status: "complete",
        summary: "The required command passed.",
        audit: {
          requirements: [
            {
              requirement: "The test command passes",
              passed: true,
              evidence: [
                {
                  callID: data.part!.callID,
                  summary: "The persisted bash result exited with code 0.",
                },
              ],
            },
          ],
        },
      })
      expect(complete.status).toBe("complete")
      expect(complete.audit?.summary).toBe("The required command passed.")
    }),
  )

  // raya_change - regression for the drawing-canvas.html goal loop: every provider attempt put
  // `requirements` at the top level (a sibling of status) instead of under `audit`. Effect's Struct
  // dropped the unknown key, so a valid completion decoded with audit=undefined and was rejected as
  // "requires an audit" seven times until the model self-blocked. The flattened shape must complete.
  it.live("completes when requirements are flattened to the top-level argument", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Accept a flattened top-level requirements array")
      const data = transcript({ sessionID, tool: "edit", output: "Edit applied successfully." })
      rows = data.rows
      const complete = yield* goals.update(sessionID, {
        status: "complete",
        summary: "Today's date was added as line 1 and verified.",
        requirements: [
          {
            requirement: "Add today's date as a comment at the top of the file",
            passed: true,
            evidence: [{ callID: data.part!.callID, summary: "Edit applied adding the date comment." }],
          },
        ],
      })
      expect(complete.status).toBe("complete")
      expect(complete.audit?.requirements).toHaveLength(1)
      expect(complete.audit?.summary).toBe("Today's date was added as line 1 and verified.")
    }),
  )

  it.live("resumes a blocked goal and then completes it", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Finish the remaining append")
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = data.rows
      yield* goals.update(sessionID, { status: "blocked", reason: "The append could not be delegated." })
      const resumed = yield* goals.update(sessionID, { status: "active" })
      expect(resumed.status).toBe("active")
      yield* goals.update(sessionID, { status: "blocked", reason: "Still missing the append." })
      const complete = yield* goals.update(sessionID, {
        status: "complete",
        summary: "The remaining append is verified.",
        audit: {
          requirements: [
            {
              requirement: "Append Hello World to the final file",
              passed: true,
              evidence: [{ callID: data.part!.callID, summary: "The append command exited 0." }],
            },
          ],
        },
      })
      expect(complete.status).toBe("complete")
    }),
  )

  // raya_change - blocking is idempotent: once recordTurn auto-blocks a goal, the model's
  // own update_goal(status="blocked") must succeed (updating the reason) instead of dead-ending.
  it.live("re-blocks an already blocked goal instead of rejecting", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Do the thing")
      yield* goals.update(sessionID, { status: "blocked", reason: "First block." })
      const again = yield* goals.update(sessionID, { status: "blocked", reason: "Still blocked, refined reason." })
      expect(again.status).toBe("blocked")
      expect(again.blockedReason).toBe("Still blocked, refined reason.")
    }),
  )

  // raya_change - the agent can self-pause when it hits an approval wall, and resume later
  it.live("lets the model pause an active goal and resume it", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Finish the append after approval")
      rows = transcript({ sessionID, tool: "bash", exit: 0 }).rows

      const paused = yield* goals.update(sessionID, { status: "paused", reason: "Waiting on the user to approve." })
      expect(paused.status).toBe("paused")
      expect(paused.progress.at(-1)?.message).toContain("Waiting on the user to approve.")

      const resumed = yield* goals.update(sessionID, { status: "active" })
      expect(resumed.status).toBe("active")
    }),
  )

  it.live("rejects pausing a goal that is not active", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Finish the append")
      rows = transcript({ sessionID, tool: "bash", exit: 0 }).rows
      yield* goals.update(sessionID, { status: "blocked", reason: "Cannot proceed." })

      const failed = yield* Effect.flip(goals.update(sessionID, { status: "paused" }))
      expect(failed).toBeInstanceOf(RayaGoal.AuditError)
    }),
  )

  it.live("rejects unmet evidence and blocks a no-tool goal turn", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Keep working until the command is green")
      let data = transcript({ sessionID, tool: "bash", exit: 1 })
      rows = data.rows

      const failed = yield* Effect.flip(
        goals.update(sessionID, {
          status: "complete",
          audit: {
            summary: "Attempted completion.",
            requirements: [
              {
                requirement: "The command passes",
                passed: true,
                evidence: [
                  {
                    messageID: data.part!.messageID,
                    callID: data.part!.callID,
                    summary: "The command ran.",
                  },
                ],
              },
            ],
          },
        }),
      )
      expect(failed).toBeInstanceOf(RayaGoal.AuditError)
      expect((yield* goals.get(sessionID))?.status).toBe("active")

      data = transcript({ sessionID })
      rows = data.rows
      const idle = yield* goals.recordTurn(sessionID)
      expect(idle?.productive).toBe(false)
      expect(idle?.retry).toBe(true)
      expect(idle?.state.usage.continuations).toBe(0)
      expect(idle?.state.status).toBe("active")
    }),
  )

  // raya_change - Milestone G smoke-gated goals require a genuine green host report
  it.live("completes a smoke-gated goal only from green browser smoke evidence", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Complete only when the smoke test passes")

      const audit = (part: MessageV2.ToolPart) => ({
        status: "complete" as const,
        audit: {
          summary: "The authenticated smoke test is green.",
          requirements: [
            {
              requirement: "The smoke test passes",
              passed: true,
              evidence: [{ callID: part.callID, summary: "The browser smoke report completed." }],
            },
          ],
        },
      })

      const command = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = command.rows
      const commandOnly = yield* Effect.flip(goals.update(sessionID, audit(command.part!)))
      expect(commandOnly).toBeInstanceOf(RayaGoal.AuditError)

      const failed = transcript({
        sessionID,
        tool: "browser_smoke_test",
        output: '{"passed":false,"failingStep":"checkout"}',
        metadata: {
          evidence: "raya-smoke-v1",
          passed: false,
          runID: "run_failed",
          artifact: "failed/report.json",
          failingStep: "checkout",
        },
      })
      rows = failed.rows
      const red = yield* Effect.flip(goals.update(sessionID, audit(failed.part!)))
      expect(red).toBeInstanceOf(RayaGoal.AuditError)
      expect(red.message).toContain("checkout")
      expect((yield* goals.get(sessionID))?.status).toBe("active")

      const passed = transcript({
        sessionID,
        tool: "browser_smoke_test",
        output: '{"passed":true}',
        metadata: {
          evidence: "raya-smoke-v1",
          passed: true,
          runID: "run_passed",
          artifact: "passed/report.json",
        },
      })
      rows = passed.rows
      expect(yield* goals.evidence(sessionID)).toEqual([
        expect.objectContaining({
          callID: passed.part!.callID,
          smoke: expect.objectContaining({ passed: true, runID: "run_passed", artifact: "passed/report.json" }),
        }),
      ])
      const complete = yield* goals.update(sessionID, audit(passed.part!))
      expect(complete.status).toBe("complete")
    }),
  )

  it.live("accounts each completed message once across reloads and same-user retries", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Continue with new evidence")
      const first = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = first.rows
      const initial = yield* goals.recordTurn(sessionID, first.rows[1].info.id)
      expect(initial?.state.usage.turns).toBe(1)
      expect(initial?.state.usage.toolCalls).toBe(1)
      expect(yield* goals.recordTurn(sessionID, first.rows[1].info.id)).toBeUndefined()
      expect(yield* setup(storage, () => rows).recordTurn(sessionID)).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(initial?.state)

      const second = transcript({ sessionID, tool: "bash", exit: 0, output: "New evidence" })
      if (second.rows[1].info.role !== "assistant") throw new Error("Expected assistant")
      second.rows[1].info.parentID = first.rows[0].info.id
      rows = [...rows, second.rows[1]]
      expect(yield* goals.recordTurn(sessionID, first.rows[1].info.id)).toBeUndefined()
      expect(yield* goals.recordTurn(sessionID, MessageID.ascending())).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(initial?.state)
      const retry = yield* goals.recordTurn(sessionID, second.rows[1].info.id)
      expect(retry?.productive).toBe(true)
      expect(retry?.state.usage.turns).toBe(2)
      expect(retry?.state.usage.toolCalls).toBe(2)
      expect(retry?.state.accounted?.messages).toEqual([first.rows[1].info.id, second.rows[1].info.id])

      const third = transcript({ sessionID, tool: "bash", exit: 0, output: "Third evidence" })
      third.rows[0].info.time.created = first.rows[0].info.time.created + 1
      rows = [...rows, ...third.rows]
      expect(yield* goals.recordTurn(sessionID, second.rows[1].info.id)).toBeUndefined()
      const next = yield* goals.recordTurn(sessionID, third.rows[1].info.id)
      expect(next?.state.usage.toolCalls).toBe(3)
      expect(next?.state.accounted).toEqual({ userID: third.rows[0].info.id, messages: [third.rows[1].info.id] })
    }),
  )

  it.live("commits only one accounting result for concurrent copies of a turn", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let reads = 0
      const goals = RayaGoal.make({
        storage,
        sessions: {
          children: () => Effect.succeed([]),
          messages: () =>
            Effect.gen(function* () {
              reads += 1
              if (reads === 2) yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return data.rows
            }),
        },
      })
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Count the turn once")
      const first = yield* goals.recordTurn(sessionID, data.rows[1].info.id).pipe(Effect.exit, Effect.forkChild)
      const second = yield* goals.recordTurn(sessionID, data.rows[1].info.id).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Deferred.succeed(release, undefined)
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)]
      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      expect(results.filter(Exit.isFailure)).toHaveLength(1)
      const saved = yield* goals.get(sessionID)
      expect(saved?.usage.turns).toBe(1)
      expect(saved?.usage.toolCalls).toBe(1)
      expect(yield* goals.recordTurn(sessionID, data.rows[1].info.id)).toBeUndefined()
    }),
  )

  it.live("bounds changing failures and resets recovery after a successful result", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const kind of ["exit", "missing", "error", "unknown", "recover"] as const) {
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        let rows: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        const created = yield* goals.create(sessionID, "Recover from failures with evidence")
        for (const count of [1, 2, 3]) {
          const success = kind === "recover" && count === 3
          const data = transcript({
            sessionID,
            tool: "bash",
            exit: success ? 0 : kind === "missing" ? undefined : 1,
            output: `Distinct result ${count}`,
          })
          data.rows[0].info.time.created = created.createdAt + count
          if (kind === "error" || kind === "unknown") {
            data.part!.state = {
              status: "error",
              input: {},
              error: kind === "unknown" ? `Unknown tool: missing_${count}` : `Failure ${count}`,
              time: { start: Date.now(), end: Date.now() },
            }
          }
          rows = [...rows, ...data.rows]
          const result = yield* goals.recordTurn(sessionID, data.rows[1].info.id)
          expect(result?.productive).toBe(success)
          expect(result?.retry).toBe(!success && count < 3)
          expect(result?.state.usage.retries).toBe(success ? 0 : count)
          expect(result?.state.status).toBe(!success && count === 3 ? "blocked" : "active")
          expect(result?.state.usage.toolCalls).toBe(count)
          if (!success && count === 3) expect(result?.state.blockedReason).toContain("without a successful tool result")
        }
      }
    }),
  )

  it.live("does not continue or consume a receipt while a tool remains pending or running", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const [status, control] of [
        ["pending", false],
        ["running", false],
        ["running", true],
      ] as const) {
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const data = transcript({ sessionID, tool: "bash", exit: 0 })
        const finished = data.part!.state
        data.part!.state =
          status === "pending" ? { status, input: {}, raw: "{}" } : { status, input: {}, time: { start: Date.now() } }
        if (control) {
          data.rows[1].parts.push({
            ...data.part!,
            id: PartID.ascending(),
            callID: crypto.randomUUID(),
            state: finished,
          })
          data.part!.tool = "update_goal"
        }
        const goals = setup(storage, () => data.rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        const created = yield* goals.create(sessionID, "Wait for the tool's outcome")
        const waiting = yield* goals.recordTurn(sessionID, data.rows[1].info.id)
        expect(waiting?.productive).toBe(false)
        expect(waiting?.retry).toBe(false)
        expect(yield* goals.get(sessionID)).toEqual(created)
        data.part!.state = finished
        const result = yield* goals.recordTurn(sessionID, data.rows[1].info.id)
        expect(result?.productive).toBe(true)
        expect(result?.state.usage.toolCalls).toBe(1)
        expect(result?.state.usage.turns).toBe(1)
        expect(yield* goals.recordTurn(sessionID, data.rows[1].info.id)).toBeUndefined()
      }
    }),
  )

  it.live("blocks a continuation that repeats identical tool work", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Do not thrash unchanged verification")

      const first = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = first.rows
      expect((yield* goals.recordTurn(sessionID))?.state.status).toBe("active")

      const second = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = [...first.rows, ...second.rows]
      const stalled = yield* goals.recordTurn(sessionID)
      expect(stalled?.productive).toBe(false)
      expect(stalled?.state.status).toBe("blocked")
      expect(stalled?.state.blockedReason).toContain("repeated the same tool work")
    }),
  )

  it.live("detects repeated work despite reused provider call IDs without rejecting new results", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      for (const changed of [false, true]) {
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        let rows: MessageV2.WithParts[] = []
        const goals = setup(storage, () => rows)
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Verify progress without repeating unchanged work")
        const first = transcript({ sessionID, tool: "bash", exit: 0 })
        rows = first.rows
        const initial = yield* goals.recordTurn(sessionID)
        expect(initial?.productive).toBe(true)
        expect(initial?.state.status).toBe("active")

        const second = transcript({
          sessionID,
          tool: "bash",
          exit: 0,
          output: changed ? "new verification evidence" : undefined,
        })
        second.part!.callID = first.part!.callID
        second.rows[0].info.time.created = first.rows[0].info.time.created + 1
        rows = [...first.rows, ...second.rows]
        const result = yield* goals.recordTurn(sessionID)
        expect(result?.productive).toBe(changed)
        expect(result?.state.status).toBe(changed ? "active" : "blocked")
        expect(result?.state.usage.toolCalls).toBe(2)
        expect((yield* setup(storage, () => rows).get(sessionID))?.status).toBe(changed ? "active" : "blocked")
        if (!changed) expect(result?.state.blockedReason).toContain("repeated the same tool work")
      }
    }),
  )

  // raya_change - malformed provider tool markup must not repeat completed work
  it.live("blocks textual completion when update_goal did not execute", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({
        sessionID,
        tool: "bash",
        exit: 0,
        text: `The task is complete. Nothing further is needed.
<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="update_goal"></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>`,
      })
      const goals = setup(storage, () => data.rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Create one temporary test file")

      const result = yield* goals.recordTurn(sessionID)
      expect(result?.productive).toBe(false)
      expect(result?.state.status).toBe("blocked")
      expect(result?.state.blockedReason).toContain("without successfully calling update_goal")
    }),
  )

  it.live("does not dispatch duplicate or stale completion events while a goal remains active", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const goals = setup(storage, () => data.rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Continue once per completed turn")
      let close:
        | ((event: {
            properties: { sessionID: SessionID; messageID: MessageID; reason: "completed" }
          }) => Fiber.Fiber<unknown, unknown>)
        | undefined
      const bus = {
        subscribeCallback: (_event, callback) => {
          close = callback as typeof close
          return Effect.succeed(() => {})
        },
      } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
      let runs = 0
      yield* RayaGoalContinuation.subscribe({
        bus,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed(data.rows),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async () => void runs++,
      })
      if (!close) throw new Error("Missing turn-close subscription")
      yield* Fiber.join(close({ properties: { sessionID, messageID: MessageID.ascending(), reason: "completed" } }))
      expect(runs).toBe(0)
      const event = { properties: { sessionID, messageID: data.rows[1].info.id, reason: "completed" as const } }
      yield* Fiber.join(close(event))
      expect(runs).toBe(1)
      yield* Fiber.join(close(event))
      expect(runs).toBe(1)
      const saved = yield* goals.get(sessionID)
      expect(saved?.status).toBe("active")
      expect(saved?.usage.turns).toBe(1)
      expect(saved?.usage.continuations).toBe(1)
    }),
  )

  it.live("starts one idle continuation and stops after completion", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      let rows: MessageV2.WithParts[] = []
      const goals = setup(storage, () => rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Continue once and complete on green evidence")
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      rows = data.rows

      let close: ((event: { properties: { sessionID: SessionID; reason: "completed" } }) => unknown) | undefined
      const bus = {
        subscribeCallback: (_event, callback) => {
          close = callback as typeof close
          return Effect.succeed(() => {})
        },
      } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
      let runs = 0
      yield* RayaGoalContinuation.subscribe({
        bus,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed(rows),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async () => {
          runs += 1
          await Effect.runPromise(
            goals.update(sessionID, {
              status: "complete",
              audit: {
                summary: "The green command proves the objective.",
                requirements: [
                  {
                    requirement: "The command passes",
                    passed: true,
                    evidence: [
                      {
                        messageID: data.part!.messageID,
                        callID: data.part!.callID,
                        summary: "The command exited with code 0.",
                      },
                    ],
                  },
                ],
              },
            }),
          )
        },
      })

      close?.({ properties: { sessionID, reason: "completed" } })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const goal = yield* goals.get(sessionID)
          return runs === 1 && goal?.status === "complete" ? goal : undefined
        }),
        "goal continuation did not complete",
      )
      close?.({ properties: { sessionID, reason: "completed" } })
      yield* Effect.sleep(25)
      expect(runs).toBe(1)
      expect((yield* goals.get(sessionID))?.usage.continuations).toBe(1)
    }),
  )

  it.live("retries a provider stream error while the goal is still active", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const assistant = data.rows[1]!.info
      if (assistant.role === "assistant") {
        assistant.error = {
          name: "UnknownError",
          data: { message: "ProviderShared.stream: Failed to read deepseek-byok/openai-compatible-chat stream" },
        }
      }
      const goals = setup(storage, () => data.rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      const capture = yield* observer
      expect(yield* capture(sessionID)).toBe("none")
      yield* goals.create(sessionID, "Keep going after a dropped stream")
      const original = yield* capture(sessionID)
      const revised = yield* goals.revise(sessionID, "Continue the new direction")
      expect(original).not.toBe(revised.intent)
      let close:
        | ((event: {
            properties: {
              sessionID: SessionID
              reason: "completed" | "error" | "interrupted"
              goalIntent?: string
              messageID?: MessageID
            }
          }) => unknown)
        | undefined
      const bus = {
        subscribeCallback: (_event, callback) => {
          close = callback as typeof close
          return Effect.succeed(() => {})
        },
      } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
      let runs = 0
      yield* RayaGoalContinuation.subscribe({
        bus,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed(data.rows),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async () => void runs++,
      })

      close?.({ properties: { sessionID, reason: "error", goalIntent: original } })
      close?.({ properties: { sessionID, reason: "error", goalIntent: "none" } })
      yield* Effect.sleep(50)
      expect(runs).toBe(0)
      expect((yield* goals.get(sessionID))?.usage.retries).toBe(0)
      close?.({
        properties: { sessionID, reason: "error", goalIntent: revised.intent, messageID: data.rows[1].info.id },
      })
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const goal = yield* goals.get(sessionID)
          return runs === 1 && goal?.status === "active" && goal.usage.retries === 1 ? goal : undefined
        }),
        "goal did not retry after a stream error",
      )
      expect((yield* goals.get(sessionID))?.progress.at(-1)?.message).toContain("provider stream dropped")
      close?.({
        properties: { sessionID, reason: "error", goalIntent: revised.intent, messageID: data.rows[1].info.id },
      })
      yield* Effect.sleep(25)
      expect((yield* goals.get(sessionID))?.usage.retries).toBe(1)
      close?.({ properties: { sessionID, reason: "interrupted" } })
      yield* Effect.sleep(25)
      expect(runs).toBe(1)
    }),
  )

  for (const action of ["control", "edit", "model", "steer", "combined", "paused"] as const)
    it.live(`renews recovery on resume and steering without erasing usage or replay receipts: ${action}`, () =>
      Effect.gen(function* () {
        const storage = yield* Storage.Service
        const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
        const goals = setup(storage, () => [])
        yield* Effect.addFinalizer(() => goals.clear(sessionID))
        yield* goals.create(sessionID, "Recover the original objective")
        for (const count of [1, 2, 3]) yield* goals.retried(sessionID, "a stream error", `error-${count}`)
        if (action === "paused") yield* goals.control(sessionID, "paused")
        if (action !== "paused") yield* goals.retried(sessionID, "a stream error", "error-4")
        const stopped = yield* goals.get(sessionID)
        if (!stopped) throw new Error("Missing stopped goal")
        expect(stopped?.usage.retries).toBe(3)
        expect(stopped?.status).toBe(action === "paused" ? "paused" : "blocked")
        if (action === "control" || action === "paused") yield* goals.control(sessionID, "active")
        if (action === "edit") yield* goals.edit(sessionID, { status: "active", expectedIntent: stopped?.intent })
        if (action === "model") yield* goals.update(sessionID, { status: "active" })
        if (action === "steer") yield* goals.revise(sessionID, "Revised objective")
        if (action === "combined")
          yield* goals.edit(sessionID, {
            objective: "Revised objective",
            status: "active",
            expectedIntent: stopped?.intent,
          })
        const resumed = yield* setup(storage, () => []).get(sessionID)
        expect(resumed?.status).toBe("active")
        expect(resumed?.usage).toEqual({ ...stopped.usage, retries: 0 })
        expect(resumed?.blockedReason).toBeUndefined()
        expect(resumed?.retryEvents).toEqual(stopped?.retryEvents)
        expect(yield* goals.retried(sessionID, "a stream error", "error-3")).toBeUndefined()
        expect(yield* goals.get(sessionID)).toEqual(resumed)
        const next = yield* goals.retried(sessionID, "a new error", "new-error")
        expect(next?.status).toBe("active")
        expect(next?.usage.retries).toBe(1)
        expect(next?.usage.continuations).toBe(4)
      }),
    )

  it.live("does not renew recovery through active no-op edits or pause alone", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Original objective")
      yield* goals.retried(sessionID, "an error", "first")
      expect((yield* goals.control(sessionID, "active")).usage.retries).toBe(1)
      expect((yield* goals.revise(sessionID, "Original objective")).usage.retries).toBe(1)
      expect((yield* goals.edit(sessionID, { status: "active" })).state.usage.retries).toBe(1)
      expect((yield* goals.edit(sessionID, { objective: "Original objective" })).state.usage.retries).toBe(1)
      expect((yield* goals.control(sessionID, "paused")).usage.retries).toBe(1)
    }),
  )

  it.live("persists provider-error receipts across reloads and preserves them through resume", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Retry each provider failure once")
      const first = yield* goals.retried(sessionID, "a stream error", "first")
      expect(first?.usage.retries).toBe(1)
      expect(yield* setup(storage, () => []).retried(sessionID, "a stream error", "first")).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(first)
      const concurrent = yield* Effect.all(
        [goals, setup(storage, () => [])].map((service) =>
          service.retried(sessionID, "a stream error", "second").pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )
      expect(concurrent.filter((result) => Exit.isSuccess(result) && result.value !== undefined)).toHaveLength(1)
      expect((yield* goals.get(sessionID))?.usage.retries).toBe(2)
      const third = yield* goals.retried(sessionID, "a stream error", "third")
      expect(third?.status).toBe("active")
      expect(third?.usage.continuations).toBe(3)
      expect(yield* goals.retried(sessionID, "a stream error", "first")).toBeUndefined()
      expect(yield* goals.retried(sessionID, "a stream error", "third")).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(third)
      const stopped = yield* goals.retried(sessionID, "a stream error", "fourth")
      expect(stopped?.status).toBe("blocked")
      expect(stopped?.usage.continuations).toBe(3)
      expect(stopped?.usage.retries).toBe(3)
      expect(stopped?.retryEvents).toEqual(["first", "second", "third", "fourth"])
      yield* goals.control(sessionID, "active")
      const resumed = yield* goals.get(sessionID)
      expect(yield* setup(storage, () => []).retried(sessionID, "a stream error", "fourth")).toBeUndefined()
      expect(yield* goals.get(sessionID)).toEqual(resumed)
    }),
  )

  it.live("blocks after exhausting provider-error retries", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const goals = setup(storage, () => data.rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Stop after repeated provider errors")
      let close:
        | ((event: {
            id: string
            properties: { sessionID: SessionID; reason: "error" }
          }) => Fiber.Fiber<unknown, unknown>)
        | undefined
      const bus = {
        subscribeCallback: (_event, callback) => {
          close = callback as typeof close
          return Effect.succeed(() => {})
        },
      } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
      let runs = 0
      yield* RayaGoalContinuation.subscribe({
        bus,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed(data.rows),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async () => void runs++,
      })

      for (const count of [1, 2, 3] as const) {
        if (!close) throw new Error("Missing turn-close subscription")
        const event = { id: `retry-${count}`, properties: { sessionID, reason: "error" as const } }
        yield* Fiber.join(close(event))
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const goal = yield* goals.get(sessionID)
            return goal?.usage.retries === count ? goal : undefined
          }),
          `goal retry ${count} did not start`,
        )
        const prior = yield* goals.get(sessionID)
        yield* Fiber.join(close(event))
        expect(yield* goals.get(sessionID)).toEqual(prior)
        expect(runs).toBe(count)
      }
      if (!close) throw new Error("Missing turn-close subscription")
      yield* Fiber.join(close({ id: "retry-4", properties: { sessionID, reason: "error" } }))
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const goal = yield* goals.get(sessionID)
          return goal?.status === "blocked" ? goal : undefined
        }),
        "goal did not block after exhausting retries",
      )
      expect(runs).toBe(RayaGoalContinuation.limit)
      expect((yield* goals.get(sessionID))?.blockedReason).toContain(`${RayaGoalContinuation.limit} provider errors`)
    }),
  )

  // raya_change - Milestone I goal-continuation setting
  it.live("respects a disabled automatic continuation default", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const sessionID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const data = transcript({ sessionID, tool: "bash", exit: 0 })
      const goals = setup(storage, () => data.rows)
      yield* Effect.addFinalizer(() => goals.clear(sessionID))
      yield* goals.create(sessionID, "Stay active without automatic continuation")
      let close: ((event: { properties: { sessionID: SessionID; reason: "completed" } }) => unknown) | undefined
      const bus = {
        subscribeCallback: (_event, callback) => {
          close = callback as typeof close
          return Effect.succeed(() => {})
        },
      } as Pick<Bus.Interface, "subscribeCallback"> as Bus.Interface
      let runs = 0
      yield* RayaGoalContinuation.subscribe({
        bus,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed(data.rows),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        enabled: () => Effect.succeed(false),
        run: async () => void runs++,
      })

      close?.({ properties: { sessionID, reason: "completed" } })
      yield* Effect.sleep(50)
      expect(runs).toBe(0)
      expect((yield* goals.get(sessionID))?.status).toBe("active")
    }),
  )

  it.live("goal reads isolate malformed records and cleanup failures", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const goals = setup(storage, () => [])
      const bad = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const good = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const old = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      yield* Effect.addFinalizer(() => Effect.forEach([bad, good, old], (id) => goals.clear(id), { discard: true }))
      const invalid = { status: "broken", objective: "Retain evidence" }
      const now = Date.now()
      const state = {
        objective: "Readable goal",
        status: "active",
        createdAt: now,
        updatedAt: now,
        usage: { turns: 0, continuations: 0, toolCalls: 0 },
        progress: [],
      }
      yield* storage.write(["raya", "goal", bad], invalid)
      yield* storage.write(["raya", "goal", good], state)
      yield* storage.write(["raya", "goal", old], {
        ...state,
        status: "complete",
        updatedAt: now - 31 * 24 * 60 * 60 * 1000,
      })
      expect((yield* goals.get(good))?.objective).toBe("Readable goal")
      expect(yield* goals.get(old)).toBeUndefined()
      expect(Exit.isFailure(yield* goals.get(bad).pipe(Effect.exit))).toBe(true)
      expect(yield* storage.read(["raya", "goal", bad])).toEqual(invalid)
      const expired = { ...state, status: "complete", updatedAt: now - 31 * 24 * 60 * 60 * 1000 }
      yield* storage.write(["raya", "goal", old], expired)
      const failed = setup(
        {
          ...storage,
          remove: (key) => (key.at(-1) === old ? Effect.die("Cleanup write unavailable") : storage.remove(key)),
        },
        () => [],
      )
      expect((yield* failed.get(good))?.objective).toBe(state.objective)
      expect(yield* storage.read(["raya", "goal", old])).toEqual(expired)
      const unlisted = setup({ ...storage, list: () => Effect.die("Cleanup scan unavailable") }, () => [])
      expect((yield* unlisted.get(good))?.objective).toBe(state.objective)
      const interrupted = setup({ ...storage, list: () => Effect.interrupt }, () => [])
      const exit = yield* interrupted.get(good).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(yield* storage.read(["raya", "goal", good])).toEqual(state)
    }),
  )

  it.live("expires completed goals after one month without pruning blocked work", () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const goals = setup(storage, () => [])
      const doneID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const blockedID = SessionID.make(`ses_goal_${crypto.randomUUID()}`)
      const old = Date.now() - 31 * 24 * 60 * 60 * 1000
      const state = {
        objective: "Retention fixture",
        createdAt: old,
        updatedAt: old,
        usage: { turns: 1, continuations: 0, toolCalls: 1 },
        progress: [{ at: old, kind: "status" as const, message: "Goal fixture." }],
      }
      yield* Effect.addFinalizer(() =>
        Effect.all([goals.clear(doneID).pipe(Effect.ignore), goals.clear(blockedID).pipe(Effect.ignore)]).pipe(
          Effect.asVoid,
        ),
      )
      yield* storage.write(["raya", "goal", doneID], { ...state, status: "complete" }).pipe(Effect.orDie)
      yield* storage.write(["raya", "goal", blockedID], { ...state, status: "blocked" }).pipe(Effect.orDie)

      expect((yield* goals.get(blockedID))?.status).toBe("blocked")
      expect((yield* storage.list(["raya", "goal"])).some((path) => path.at(-1) === doneID)).toBe(false)
      expect(yield* goals.get(doneID)).toBeUndefined()
    }),
  )
})
