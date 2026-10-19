import { afterAll, expect } from "bun:test"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaGoal } from "@/kilocode/goal"
import { read } from "@/kilocode/goal/read-artifact"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { remove as cleanup } from "./cleanup"

const db = path.join(os.tmpdir(), `raya-review-report-${process.pid}-${crypto.randomUUID()}.sqlite`)
afterAll(async () => {
  await Promise.all([db, `${db}-wal`, `${db}-shm`].map(cleanup))
}, 30_000)
const root = LayerNode.group([
  Bus.node,
  Database.node,
  Session.node,
  SessionProjector.node,
  Storage.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
  FSUtil.node,
])
const env = AppNodeBuilder.build(root, [
  [Database.node, Database.layerFromPath(db)],
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
])
const it = testEffect(env.pipe(Layer.provide(RuntimeFlags.layer())))
const text = "Original answer awaiting human acceptance.\r\n "

// All Goal state transitions, evidence validation, messages and Run writes are
// production services. Only later tampering cases intentionally corrupt storage.
const seed = Effect.fn("ReviewedFinalReportTest.seed")(function* () {
  const storage = yield* Storage.Service
  const database = yield* Database.Service
  const sessions = yield* Session.Service
  const fs = yield* FSUtil.Service
  const dir = yield* tmpdirScoped()
  const file = path.join(dir, "reference.txt")
  yield* fs.writeFileString(file, "Reference inspected for human review\r\n")
  const runner = RayaTaskRunner.make({ storage, database, sessions })
  const goals = RayaGoal.make({ storage, sessions })
  const target = yield* sessions.create({ title: "Reviewed reports" })
  const agent = yield* runner.tasks.create({
    name: "Reviewed worker",
    objective: "Prepare an answer for human acceptance",
    access: "brief",
    memoryScope: "session",
    schedule: { kind: "manual" },
    sourceSessionID: target.id,
    reportSessionID: target.id,
  })
  const id = crypto.randomUUID()
  const trigger = { kind: "manual" as const }
  const chat = yield* sessions.create({
    metadata: {
      rayaRoutine: { version: 2, agentID: agent.id, runID: id, scheduleVersion: agent.scheduleVersion ?? 1, trigger },
    },
  })
  const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const created = yield* goals.create(
    chat.id,
    agent.objective,
    user.id,
    undefined,
    undefined,
    [
      {
        id: "human",
        description: "Prepare referenced answer for review",
        verification: "Inspect the reference and request acceptance",
        review: true,
      },
    ],
    undefined,
    undefined,
    { agentID: agent.id, runID: id, sessionID: chat.id },
  )
  const active = yield* goals.initial(chat.id, created.intent!, "review-report-fixture")
  if (!active?.dispatch) throw new Error("Original review dispatch required")
  const answer = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    parentID: user.id,
    role: "assistant",
    agent: "build",
    mode: "build",
    modelID: ref.modelID,
    providerID: ref.providerID,
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  })
  const object = yield* KiloReadObject.file(file)
  const result = yield* KiloReadObject.use(object, (bound) =>
    read(fs, bound, Effect.succeed({ output: "Reference inspected", metadata: {} })),
  )
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: answer.id,
    type: "tool",
    tool: "read",
    callID: crypto.randomUUID(),
    state: {
      status: "completed",
      input: { filePath: file },
      title: "Read",
      output: result.output,
      metadata: result.metadata,
      time: { start: Date.now(), end: Date.now() },
    },
  })
  const run = yield* runner.tasks.record({
    id,
    agentID: agent.id,
    sessionID: chat.id,
    at: created.createdAt,
    goalCreatedAt: created.createdAt,
    status: "running",
    scheduleVersion: agent.scheduleVersion ?? 1,
    trigger,
  })
  yield* RayaTaskSnapshot.make({ storage }).save({
    version: 2,
    runID: id,
    agentID: agent.id,
    sessionID: chat.id,
    at: run.at,
    definition: agent,
    objective: created.objective,
  })
  // An ordinary active TurnClose hint must never steal GoalContinuation's
  // bookkeeping. Incomplete assistant has no final output yet.
  yield* runner.observe(chat.id, { reason: "completed", messageID: answer.id, goalIntent: created.intent })
  expect((yield* goals.get(chat.id))?.dispatch?.phase).toBe("started")
  const pending = yield* goals.update(chat.id, {
    status: "complete",
    audit: {
      summary: "Reference ready for human judgment",
      requirements: [
        {
          criterionID: "human",
          requirement: "Prepare referenced answer for review",
          passed: true,
          evidence: [
            {
              callID: part.callID,
              messageID: answer.id,
              partID: part.id,
              sessionID: chat.id,
              summary: "Current captured reference was inspected",
            },
          ],
        },
      ],
    },
  })
  expect(pending.status).toBe("paused")
  expect(pending.review?.status).toBe("pending")
  expect(pending.intent).not.toBe(created.intent)
  expect(pending.audit?.requirements[0]?.evidence[0]?.record?.digest).toBeString()
  const at = Date.now()
  yield* sessions.updateMessage({ ...answer, time: { ...answer.time, completed: at }, finish: "stop" })
  const final = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: answer.id,
    type: "text",
    text,
  })
  return {
    storage,
    database,
    sessions,
    goals,
    runner,
    created,
    active,
    pending,
    agent,
    chat,
    user,
    answer,
    final,
    run,
    at,
  }
})

for (const mode of ["direct", "observe"] as const) {
  it.instance(
    `explicit review acceptance preserves the original final answer across authority rotations (${mode})`,
    () =>
      Effect.gen(function* () {
        const ctx = yield* seed()
        if (mode === "direct") yield* ctx.goals.finished(ctx.chat.id, ctx.answer.id)
        if (mode === "observe")
          yield* ctx.runner.observe(ctx.chat.id, {
            reason: "completed",
            messageID: ctx.answer.id,
            goalIntent: ctx.created.intent,
          })
        const ready = yield* ctx.goals.get(ctx.chat.id)
        const accepted = yield* ctx.goals.edit(ctx.chat.id, { accept: true, expectedIntent: ready?.intent })
        expect(accepted.state.status).toBe("complete")
        expect(accepted.state.intent).not.toBe(ctx.created.intent)
        expect(accepted.state.intent).not.toBe(ctx.pending.intent)
        yield* ctx.runner.settle(ctx.chat.id)
        const row = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
        if (!row) throw new Error("The original reviewed Routine run is missing")
        expect(row?.status).toBe("complete")
        expect(row?.outcome?.summary).toBe(text)
        expect(row?.outcome?.report).toMatchObject({
          messageID: ctx.answer.id,
          parentID: ctx.user.id,
          at: ctx.at,
          goalIntent: ctx.created.intent,
          acceptedIntent: accepted.state.intent,
          dispatchID: ctx.active.dispatch!.id,
          partIDs: [ctx.final.id],
        })
        expect(accepted.state.review).toMatchObject({
          status: "accepted",
          source: {
            goalCreatedAt: ctx.created.createdAt,
            intent: ctx.created.intent,
            dispatchID: ctx.active.dispatch!.id,
            messageID: ctx.user.id,
          },
        })
        const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
        yield* RayaTaskRunner.make(ctx).settle(ctx.chat.id)
        expect(yield* ctx.runner.tasks.runsFor(ctx.agent.id)).toContainEqual(row)
        expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      }),
  )
}

for (const defect of ["dispatch", "source", "missing", "intent", "message"] as const) {
  it.instance(
    `explicit acceptance refuses ${defect} review provenance and never upgrades legacy or foreign output`,
    () =>
      Effect.gen(function* () {
        const ctx = yield* seed()
        yield* ctx.goals.finished(ctx.chat.id, ctx.answer.id)
        const ready = yield* ctx.goals.get(ctx.chat.id)
        if (!ready?.dispatch || !ready.review) throw new Error("Actual pending original review required")
        const source = {
          goalCreatedAt: ctx.created.createdAt,
          dispatchID: ctx.active.dispatch!.id,
          intent: ctx.created.intent,
          messageID: ctx.user.id,
        }
        yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
          ...ready,
          ...(defect === "dispatch" ? { dispatch: { ...ready.dispatch, id: crypto.randomUUID() } } : {}),
          review: {
            ...ready.review,
            source:
              defect === "missing"
                ? undefined
                : {
                    ...source,
                    ...(defect === "source" ? { goalCreatedAt: source.goalCreatedAt + 1 } : {}),
                    ...(defect === "intent" ? { intent: crypto.randomUUID() } : {}),
                    ...(defect === "message" ? { messageID: MessageID.ascending() } : {}),
                  },
          },
        })
        const result = yield* ctx.goals
          .edit(ctx.chat.id, { accept: true, expectedIntent: ready.intent })
          .pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect((yield* ctx.goals.get(ctx.chat.id))?.status).toBe("paused")
        yield* ctx.runner.settle(ctx.chat.id)
        expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)?.status).toBe(
          "running",
        )
      }),
  )
}
