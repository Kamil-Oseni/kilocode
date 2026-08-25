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

function transcript(input: { sessionID: SessionID; tool?: string; exit?: number }) {
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
          output: input.exit === 0 ? "all checks passed" : "check failed",
          title: "verification",
          metadata: { exit: input.exit },
          time: { start: Date.now(), end: Date.now() },
        },
      }
    : undefined
  const rows: MessageV2.WithParts[] = [
    { info: user, parts: [] },
    { info: assistant, parts: part ? [part] : [] },
  ]
  return { rows, part }
}

function setup(storage: Storage.Interface, rows: () => MessageV2.WithParts[]) {
  return RayaGoal.make({
    storage,
    sessions: {
      messages: () => Effect.succeed(rows()),
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
      const goals = setup(storage, () => [])
      yield* Effect.addFinalizer(() => goals.clear(sessionID))

      const created = yield* goals.create(sessionID, "Ship verified goal mode")
      expect(created.status).toBe("active")
      expect((yield* goals.create(sessionID, "Ship verified goal mode")).createdAt).toBe(created.createdAt)
      yield* goals.control(sessionID, "paused")

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
        } as unknown as Pick<Session.Interface, "get" | "messages">,
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

  it.live("rejects unmet or failed evidence and suppresses no-tool continuation", () =>
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

      const blocked = yield* goals.update(sessionID, {
        status: "blocked",
        reason: "The required external service is unavailable.",
      })
      expect(blocked.status).toBe("blocked")
      expect(blocked.blockedReason).toContain("unavailable")
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
        } as unknown as Pick<Session.Interface, "get" | "messages">,
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
})
