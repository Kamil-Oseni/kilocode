import { expect } from "bun:test"
import { Cause, Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BackgroundJob } from "@/background/job"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID } from "@/session/schema"
import { Storage } from "@/storage/storage"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { RayaChief } from "@/kilocode/chief"
import { ChiefVerification } from "@/kilocode/chief/verification"
import { RayaGoal } from "@/kilocode/goal"
import * as GoalGate from "@/kilocode/goal/tool-gate"
import { goalTools } from "@/kilocode/tool/goal"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { database, storage } from "./fixtures/effect-profile"

const model = ProviderTest.model()
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      BackgroundJob.node,
      Agent.node,
      Truncate.node,
      EventV2Bridge.node,
      Session.node,
      SessionRunState.node,
      SessionProjector.node,
      Storage.node,
      Database.node,
      CrossSpawnSpawner.node,
      FSUtil.node,
      Git.node,
    ]),
    [
      [Database.node, database],
      [Storage.node, storage],
    ],
  ),
)

// Surrounding canonical rows are fixture-authored; observation, job completion,
// goal inspection, and refusal all use the actual production services.
const fixture = Effect.fn(function* () {
  const sessions = yield* Session.Service
  const store = yield* Storage.Service
  const jobs = yield* BackgroundJob.Service
  const runs = yield* SessionRunState.Service
  const parent = yield* sessions.create()
  const request = "Write the authorized file and verify the saved bytes using Read"
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "user",
    agent: "auto",
    model: { providerID: model.providerID, modelID: model.id },
    time: { created: Date.now() },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: parent.id,
    messageID: user.id,
    type: "text",
    text: request,
  })
  const goals = RayaGoal.make({ sessions, storage: store })
  const goal = yield* goals.create(parent.id, request, user.id)
  expect((yield* goals.initial(parent.id, goal.intent ?? "unset", "actual-inspection-fixture"))?.inputs).toContain(
    user.id,
  )
  const assistant = Effect.fn(function* (sessionID = parent.id, parentID = user.id) {
    return yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID,
      parentID,
      role: "assistant",
      agent: "auto",
      mode: "auto",
      cost: 0,
      path: { cwd: parent.directory, root: parent.directory },
      providerID: model.providerID,
      modelID: model.id,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
    })
  })
  const source = yield* assistant()
  const child = yield* sessions.create({ parentID: parent.id })
  const initial = yield* sessions.updateMessage({
    ...user,
    id: MessageID.ascending(),
    sessionID: child.id,
    time: { created: Date.now() },
  })
  const call = "actual-foreground-inspection-worker"
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: parent.id,
    messageID: source.id,
    type: "tool",
    tool: "task",
    callID: call,
    state: {
      status: "running",
      input: { brief: { objective: request }, access: "edit" },
      time: { start: Date.now() },
      metadata: { parentSessionId: parent.id, sessionId: child.id, childMessageID: initial.id },
    },
  })
  yield* sessions.setMetadata({
    sessionID: parent.id,
    metadata: { [RayaChief.requestKey]: request, [RayaChief.phaseKey]: "task" },
  })
  const input = { sessions, storage: store, sessionID: parent.id, messageID: source.id, callID: call, request }
  yield* ChiefVerification.reserve({ ...input, userID: user.id })
  yield* jobs.start({
    id: child.id,
    type: "task",
    metadata: { background: false },
    origin: {
      sessionID: parent.id,
      messageID: source.id,
      callID: call,
      childSessionID: child.id,
      childMessageID: initial.id,
    },
    run: Effect.gen(function* () {
      const terminal = yield* assistant(child.id, initial.id)
      yield* sessions.updateMessage({
        ...terminal,
        finish: "stop",
        time: { ...terminal.time, completed: Date.now() },
      })
      return "Worker wrote the file but still needs the missing Read"
    }),
  })
  expect((yield* jobs.wait({ id: child.id })).info?.status).toBe("completed")
  const observation = yield* ChiefVerification.foreground({
    ...input,
    background: jobs,
    childID: child.id,
    inputID: initial.id,
  })
  expect(observation.child?.sessionID).toBe(child.id)
  yield* sessions.updatePart({
    ...part,
    state: {
      status: "completed",
      input: { brief: { objective: request }, access: "edit" },
      output: "Worker wrote the file but still needs the missing Read",
      title: "Worker completed",
      metadata: { parentSessionId: parent.id, sessionId: child.id, childMessageID: initial.id },
      time: { start: source.time.created, end: Date.now() },
    },
  })
  const get = yield* goalTools(goals, sessions).get.pipe(Effect.flatMap(Tool.init))
  const inspect = Effect.fn(function* (message: typeof source) {
    const start = Date.now()
    const captured = yield* get.execute(
      {},
      {
        sessionID: parent.id,
        messageID: message.id,
        callID: "actual-inspection",
        agent: "auto",
        abort: new AbortController().signal,
        messages: [],
        ask: () => Effect.void,
        metadata: () => Effect.void,
      },
    )
    const output = JSON.parse(captured.output)
    expect(output.goal.intent).toBe(goal.intent)
    return yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: parent.id,
      messageID: message.id,
      type: "tool",
      tool: "get_goal",
      callID: "actual-inspection",
      state: {
        status: "completed",
        input: {},
        output: captured.output,
        title: captured.title,
        metadata: captured.metadata,
        time: { start, end: Date.now() },
      },
    })
  })
  const resume = (
    message: typeof source,
    objective = "Read the authorized file in full to finish missing verification",
  ) =>
    ChiefVerification.reuse({
      sessions,
      storage: store,
      background: jobs,
      sessionID: parent.id,
      messageID: message.id,
      agent: "auto",
      planned: false,
      taskID: child.id,
      objective,
    })
  const snapshot = () =>
    Effect.all({
      parent: sessions.get(parent.id),
      rows: sessions.messages({ sessionID: parent.id }),
      child: sessions.messages({ sessionID: child.id }),
      job: jobs.get(child.id),
      goal: goals.get(parent.id),
    })
  return { sessions, parent, child, user, goals, runs, assistant, inspect, resume, snapshot }
})

it.instance(
  "foreground recovery refuses missing and same-envelope goal inspection without changing persisted work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const current = yield* f.assistant()
      const before = yield* f.snapshot()
      const missing = yield* f.resume(current).pipe(Effect.exit)
      expect(missing._tag).toBe("Failure")
      if (missing._tag !== "Failure") throw new Error("Missing inspection must refuse")
      expect(Cause.pretty(missing.cause)).toContain("Inspect this original goal with get_goal in an earlier turn")
      expect(yield* f.snapshot()).toEqual(before)
      yield* f.inspect(current)
      const inspected = yield* f.snapshot()
      const together = yield* f.resume(current).pipe(Effect.exit)
      expect(together._tag).toBe("Failure")
      if (together._tag !== "Failure") throw new Error("Same-envelope inspection must refuse")
      expect(Cause.pretty(together.cause)).toContain("Do not issue get_goal and Task recovery together")
      expect(yield* f.snapshot()).toEqual(inspected)
      expect(yield* f.sessions.children(f.parent.id)).toHaveLength(1)
    }),
  { timeout: 15_000 },
)

it.instance(
  "earlier real goal inspection admits missing Read and byte correction in the same worker",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.inspect(yield* f.assistant())
      const current = yield* f.assistant()
      const before = yield* f.snapshot()
      expect(yield* f.resume(current)).toBe(true)
      expect(
        yield* f.resume(current, "Correct the authorized target's wrong final newline, then verify full saved bytes"),
      ).toBe(true)
      expect(yield* f.snapshot()).toEqual(before)
    }),
  { timeout: 15_000 },
)

it.instance(
  "foreground recovery refuses altered persisted inspection proof without changing worker state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const inspection = yield* f.inspect(yield* f.assistant())
      if (inspection.type !== "tool" || inspection.state.status !== "completed")
        throw new Error("Actual completed goal inspection required")
      yield* f.sessions.updatePart({
        ...inspection,
        state: {
          ...inspection.state,
          metadata: {
            ...inspection.state.metadata,
            [GoalGate.key]: {
              version: 1,
              sessionID: f.parent.id,
              messageID: inspection.messageID,
              digest: "0".repeat(64),
            },
          },
        },
      })
      const current = yield* f.assistant()
      const before = yield* f.snapshot()
      const denied = yield* f.resume(current).pipe(Effect.exit)
      expect(denied._tag).toBe("Failure")
      if (denied._tag !== "Failure") throw new Error("Altered inspection proof must refuse")
      expect(Cause.pretty(denied.cause)).toContain("Inspect this original goal with get_goal in an earlier turn")
      expect(yield* f.snapshot()).toEqual(before)
    }),
  { timeout: 15_000 },
)

it.instance(
  "recovery inspection fencing preserves new authored steering and unarmed sessions",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const user = yield* f.sessions.updateMessage({
        ...f.user,
        id: MessageID.ascending(),
        time: { created: Date.now() },
      })
      yield* f.sessions.updatePart({
        id: PartID.ascending(),
        sessionID: f.parent.id,
        messageID: user.id,
        type: "text",
        text: "A new authorized request with different work",
      })
      expect(yield* f.resume(yield* f.assistant(f.parent.id, user.id))).toBe(false)
      const unarmed = yield* fixture()
      const goal = yield* unarmed.goals.get(unarmed.parent.id)
      if (!goal?.intent) throw new Error("Original goal intent required to stop")
      yield* unarmed.goals.stop(unarmed.parent.id, goal.intent, unarmed.runs)
      expect(yield* unarmed.goals.get(unarmed.parent.id)).toBeUndefined()
      expect(yield* unarmed.resume(yield* unarmed.assistant())).toBe(false)
    }),
  { timeout: 15_000 },
)
