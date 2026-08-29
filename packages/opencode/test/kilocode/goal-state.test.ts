// raya_change - Milestone A goal persistence, audit, and continuation eligibility
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RayaGoal } from "@/kilocode/goal"
import { RayaGoalContinuation } from "@/kilocode/goal/continuation"
import { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import * as ToolJsonSchema from "@/tool/json-schema"
import { testEffect } from "../lib/effect"
import { pollWithTimeout } from "../lib/effect"
import type { Bus } from "@/bus"

const it = testEffect(LayerNode.compile(LayerNode.group([Storage.node, FSUtil.node, CrossSpawnSpawner.node])))

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
  test("emits provider-compatible object parameters for update_goal", () => {
    expect(ToolJsonSchema.fromSchema(RayaGoal.ModelUpdate).type).toBe("object")
  })

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
      let directory = ""
      yield* RayaGoalContinuation.resume({
        sessionID,
        storage,
        sessions: {
          get: () => Effect.succeed({ directory: process.cwd() }),
          messages: () => Effect.succeed([]),
          children: () => Effect.succeed([]),
        } as unknown as Pick<Session.Interface, "get" | "messages" | "children">,
        run: async (_sid, _goal, dir) => {
          directory = dir
        },
      })
      expect((yield* goals.get(sessionID))?.status).toBe("active")
      expect((yield* goals.get(sessionID))?.usage.continuations).toBe(1)
      expect(directory).toBe(process.cwd())
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
      const goals = setup(storage, () => [], {
        messagesFor: (id) => (id === childID ? childRows : []),
        children: (id) => (id === parentID ? [{ id: childID } as unknown as Session.Info] : []),
      })
      yield* Effect.addFinalizer(() => goals.clear(parentID))
      yield* goals.create(parentID, "Create jesus.txt via a delegated agent")
      const child = transcript({ sessionID: childID, tool: "write", output: "wrote jesus.txt" })
      childRows = child.rows

      expect(yield* goals.evidence(parentID)).toEqual([
        expect.objectContaining({ callID: child.part!.callID }),
      ])

      const complete = yield* goals.update(parentID, {
        status: "complete",
        audit: {
          summary: "The delegated subagent write created the file.",
          requirements: [
            {
              requirement: "The file is created by the subagent",
              passed: true,
              evidence: [{ callID: child.part!.callID, summary: "The child-session write completed." }],
            },
          ],
        },
      })
      expect(complete.status).toBe("complete")
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
      expect(idle?.state.usage.continuations).toBe(0)
      expect(idle?.state.status).toBe("blocked")
      expect(idle?.state.blockedReason).toContain("without work")
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
