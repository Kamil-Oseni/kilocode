import { afterAll, expect } from "bun:test"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { Codec } from "@/kilocode/task/schema"
import * as Artifact from "@/kilocode/goal/artifact"
import { read } from "@/kilocode/goal/read-artifact"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { remove as cleanup } from "./cleanup"
import { tmpdirScoped } from "../fixture/fixture"

// Override only this Effect graph's database; never change the process-global
// profile selector or open an installed/user database.
const db = path.join(os.tmpdir(), `raya-final-report-${process.pid}-${crypto.randomUUID()}.sqlite`)
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
const text = "  A final answer with é and an exact CRLF.\r\nNo numbered read prefix.\n "
const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

// Real Session/Storage/SQLite and the production runner; only the already-accepted
// audit is seeded. These tests do not assert that a prose audit proves its claims.
const seed = Effect.fn("FinalReportTest.seed")(function* () {
  const storage = yield* Storage.Service
  const database = yield* Database.Service
  const sessions = yield* Session.Service
  const goals = RayaGoal.make({ storage, sessions })
  const runner = RayaTaskRunner.make({ storage, database, sessions })
  const target = yield* sessions.create({ title: "Original Routine reports" })
  const agent = yield* runner.tasks.create({
    name: "Final report fixture",
    objective: "Return the requested exact result",
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
    undefined,
    undefined,
    undefined,
    {
      agentID: agent.id,
      runID: id,
      sessionID: chat.id,
    },
  )
  const active = yield* goals.initial(chat.id, created.intent!, "final-report-fixture")
  if (!active?.dispatch) throw new Error("The actual original Goal dispatch was not admitted")
  const at = Math.max(Date.now(), active.dispatch.startedAt ?? 0)
  const answer = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: chat.id,
    role: "assistant",
    parentID: user.id,
    agent: "build",
    mode: "build",
    modelID: ref.modelID,
    providerID: ref.providerID,
    path: { cwd: "/fixture", root: "/fixture" },
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: at, completed: at },
    finish: "stop",
  })
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: answer.id,
    type: "text",
    text,
  })
  const finished = yield* goals.finished(chat.id, answer.id)
  if (!finished?.dispatch || finished.dispatch.phase !== "finished") throw new Error("Actual final bookkeeping failed")
  const goal = {
    ...finished,
    status: "complete" as const,
    activeAt: undefined,
    audit: {
      summary: "Audit paraphrase, deliberately different from the final answer",
      verifiedAt: at,
      requirements: [],
    },
  }
  yield* storage.replace(["raya", "goal", chat.id], goal satisfies RayaGoal.State)
  const run = yield* runner.tasks.record({
    id,
    agentID: agent.id,
    sessionID: chat.id,
    at: created.createdAt,
    status: "running",
    scheduleVersion: agent.scheduleVersion ?? 1,
    trigger,
    goalCreatedAt: created.createdAt,
    trace: {
      version: 1,
      goalCreatedAt: created.createdAt,
      turns: [{ turnID: user.id, messages: [{ messageID: answer.id, actions: [] }] }],
    },
  })
  yield* RayaTaskSnapshot.make({ storage }).save({
    version: 2,
    runID: id,
    agentID: agent.id,
    sessionID: chat.id,
    at: run.at,
    definition: agent,
    objective: goal.objective,
  })
  return { storage, database, sessions, goals, runner, agent, chat, user, answer, part, goal, run }
})

it.instance(
  "Routine reports persist the exact owned final answer and its original provenance, not the earlier audit paraphrase",
  () =>
    Effect.gen(function* () {
      const ctx = yield* seed()
      yield* ctx.runner.settle(ctx.chat.id)
      const rows = yield* ctx.runner.tasks.runsFor(ctx.agent.id)
      const row = rows.find((row) => row.id === ctx.run.id)
      expect(row?.status).toBe("complete")
      expect(row?.outcome?.summary).toBe(text)
      expect(row?.outcome).toMatchObject({
        report: {
          version: 1,
          sessionID: ctx.chat.id,
          messageID: ctx.answer.id,
          parentID: ctx.user.id,
          at: ctx.answer.time.completed,
          partIDs: [ctx.part.id],
          dispatchID: ctx.goal.dispatch!.id,
          goalCreatedAt: ctx.goal.createdAt,
          goalIntent: ctx.goal.intent,
          sha256: createHash("sha256").update(text).digest("hex"),
        },
      })
      const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
      const events = yield* ctx.runner.tasks.eventsFor(ctx.agent.id)
      // Reconstruct the production service over its saved state. This checks
      // idempotent recovery, not a cold-process or elapsed-timer acceptance gate.
      const recovered = RayaTaskRunner.make(ctx)
      yield* recovered.settle(ctx.chat.id)
      expect(yield* recovered.tasks.runsFor(ctx.agent.id)).toEqual(rows)
      expect(yield* recovered.tasks.eventsFor(ctx.agent.id)).toEqual(events)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
    }),
)

for (const defect of [
  "parent",
  "unfinished",
  "error",
  "tool-only",
  "foreign",
  "new-goal",
  "dispatch",
  "not-finished",
] as const) {
  it.instance(`Routine final projection refuses ${defect} evidence without borrowing another answer`, () =>
    Effect.gen(function* () {
      const ctx = yield* seed()
      if (defect === "parent") yield* ctx.sessions.updateMessage({ ...ctx.answer, parentID: MessageID.ascending() })
      if (defect === "unfinished")
        yield* ctx.sessions.updateMessage({ ...ctx.answer, time: { created: ctx.answer.time.created } })
      if (defect === "error")
        yield* ctx.sessions.updateMessage({
          ...ctx.answer,
          error: { name: "UnknownError", data: { message: "Original answer failed" } },
        })
      if (defect === "tool-only") {
        yield* ctx.sessions.removePart({ sessionID: ctx.chat.id, messageID: ctx.answer.id, partID: ctx.part.id })
        yield* ctx.sessions.updatePart({
          id: PartID.ascending(),
          sessionID: ctx.chat.id,
          messageID: ctx.answer.id,
          type: "tool",
          tool: "read",
          callID: "original-read",
          state: {
            status: "completed",
            input: {},
            output: "Tool output is not a final answer",
            title: "Read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
      }
      if (defect === "foreign") {
        const other = yield* ctx.sessions.create({ title: "Foreign conversation" })
        const answer = yield* ctx.sessions.updateMessage({
          ...ctx.answer,
          id: MessageID.ascending(),
          sessionID: other.id,
        })
        yield* ctx.sessions.updatePart({
          ...ctx.part,
          id: PartID.ascending(),
          messageID: answer.id,
          sessionID: other.id,
          text: "Foreign final answer",
        })
        yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
          ...ctx.goal,
          dispatch: { ...ctx.goal.dispatch!, assistantID: answer.id },
        })
      }
      if (defect === "new-goal")
        yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
          ...ctx.goal,
          createdAt: ctx.goal.createdAt + 1,
          intent: crypto.randomUUID(),
        })
      if (defect === "dispatch")
        yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
          ...ctx.goal,
          dispatch: { ...ctx.goal.dispatch!, messageID: MessageID.ascending() },
        })
      if (defect === "not-finished")
        yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
          ...ctx.goal,
          dispatch: {
            ...ctx.goal.dispatch!,
            phase: "started",
            assistantID: undefined,
            finishedAt: undefined,
            outcome: undefined,
          },
        })
      yield* ctx.runner.settle(ctx.chat.id)
      expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)).toEqual(ctx.run)
    }),
  )
}

it.instance(
  "an early settlement hint waits, then the real original TurnClose observation finishes bookkeeping without replay",
  () =>
    Effect.gen(function* () {
      const ctx = yield* seed()
      yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
        ...ctx.goal,
        dispatch: {
          ...ctx.goal.dispatch!,
          phase: "started",
          assistantID: undefined,
          finishedAt: undefined,
          outcome: undefined,
        },
      })
      yield* ctx.runner.settle(ctx.chat.id)
      expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)).toEqual(ctx.run)
      yield* ctx.runner.observe(ctx.chat.id, {
        reason: "completed",
        messageID: ctx.answer.id,
        goalIntent: ctx.goal.intent,
      })
      const finished = yield* ctx.goals.get(ctx.chat.id)
      expect(finished?.dispatch?.assistantID).toBe(ctx.answer.id)
      const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
      yield* RayaTaskRunner.make(ctx).settle(ctx.chat.id)
      expect(
        (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)?.outcome?.summary,
      ).toBe(text)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
    }),
)

for (const defect of ["child", "intent", "message", "new-goal"] as const) {
  it.instance(`TurnClose bookkeeping refuses a ${defect} event and cannot finish another original dispatch`, () =>
    Effect.gen(function* () {
      const ctx = yield* seed()
      const goal = {
        ...ctx.goal,
        ...(defect === "new-goal" ? { createdAt: ctx.goal.createdAt + 1, intent: crypto.randomUUID() } : {}),
        dispatch: {
          ...ctx.goal.dispatch!,
          phase: "started" as const,
          assistantID: undefined,
          finishedAt: undefined,
          outcome: undefined,
        },
      }
      yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], goal)
      yield* ctx.runner.observe(ctx.chat.id, {
        reason: "completed",
        messageID: defect === "message" ? MessageID.ascending() : ctx.answer.id,
        goalIntent: defect === "intent" ? crypto.randomUUID() : ctx.goal.intent,
        ...(defect === "child" ? { parentID: ctx.chat.id } : {}),
      })
      expect((yield* ctx.goals.get(ctx.chat.id))?.dispatch).toEqual(goal.dispatch)
      yield* ctx.runner.settle(ctx.chat.id)
      expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)?.status).toBe(
        "running",
      )
    }),
  )
}

it.instance(
  "new report verification records only the saved criterion check kind and does not upgrade prose claims",
  () =>
    Effect.gen(function* () {
      const ctx = yield* seed()
      const criteria: NonNullable<RayaGoal.State["criteria"]> = [
        { id: "prose", description: "Model reviewed its answer", verification: "Review cited references" },
        {
          id: "command",
          description: "Saved command",
          verification: "Run the saved command",
          check: { kind: "command", command: "fixture-check", directory: "/fixture" },
        },
        {
          id: "bytes",
          description: "Saved equality",
          verification: "Compare saved files",
          check: {
            kind: "byte-equality",
            source: { path: "/fixture/source", canonical: "/fixture/source", sha256: "a".repeat(64), bytes: 1 },
            target: { path: "/fixture/target", canonical: "/fixture/target" },
          },
        },
      ]
      // Projection of an already-saved audit only. Existing Goal validators own
      // execution/evidence validation; no command or byte check is run here.
      yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
        ...ctx.goal,
        criteria,
        audit: {
          ...ctx.goal.audit,
          requirements: criteria.map((criterion) => ({
            criterionID: criterion.id,
            requirement: criterion.description,
            passed: true,
            evidence: [],
          })),
        },
      } satisfies RayaGoal.State)
      yield* ctx.runner.settle(ctx.chat.id)
      const row = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
      expect(row?.outcome?.verification?.requirements.map((item) => item.basis)).toEqual([
        "model-audit",
        "command",
        "byte-equality",
      ])
      const legacy = yield* Schema.decodeUnknownEffect(Codec.Outcome)({
        kind: "notify",
        summary: "Old report",
        cost: 0,
        verification: {
          at: 1,
          requirements: [{ requirement: "Old claim", required: true, passed: true, evidence: [] }],
        },
      })
      expect(legacy.verification?.requirements[0]?.basis).toBeUndefined()
    }),
)

it.instance(
  "a real Goal replacement at the delegated Run transition boundary cannot publish or retire its predecessor",
  () =>
    Effect.gen(function* () {
      const ctx = yield* seed()
      const execution = RayaTaskExecution.make(ctx.storage)
      yield* execution.enter(ctx.run, Effect.void)
      const owner = yield* execution.receipt(ctx.run)
      expect(owner?.state).toBe("idle")
      const events = yield* ctx.runner.tasks.eventsFor(ctx.agent.id)
      const state: { armed: boolean; held: boolean; replacement?: RayaGoal.State } = { armed: false, held: false }
      const storage: Storage.Interface = {
        ...ctx.storage,
        create: (key, value) =>
          Effect.gen(function* () {
            if (state.armed && !state.held && key[0] === "raya" && key[1] === "mutation-agent-claims") {
              state.held = true
              // Hold actual storage admission before the Run mutation claim exists.
              // Commit an independent real Goal replacement before resuming its CAS.
              state.replacement = yield* ctx.goals
                .create(ctx.chat.id, "A new user-directed assignment")
                .pipe(Effect.orDie)
            }
            return yield* ctx.storage.create(key, value)
          }),
      }
      const runner = RayaTaskRunner.make({
        storage,
        database: ctx.database,
        sessions: {
          create: ctx.sessions.create,
          get: ctx.sessions.get,
          children: ctx.sessions.children,
          messages: (input) =>
            ctx.sessions.messages(input).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  state.armed = true
                }),
              ),
            ),
        },
      })
      yield* runner.settle(ctx.chat.id)
      expect(state.held).toBe(true)
      expect(state.replacement?.intent).not.toBe(ctx.goal.intent)
      expect((yield* ctx.goals.get(ctx.chat.id))?.intent).toBe(state.replacement?.intent)
      expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)).toEqual(ctx.run)
      expect(yield* ctx.runner.tasks.eventsFor(ctx.agent.id)).toEqual(events)
      expect(yield* execution.receipt(ctx.run)).toEqual(owner)
      const report = yield* ctx.storage
        .read(["raya", "routine-reports", createHash("sha256").update(ctx.run.id).digest("hex")])
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
      expect(report).toBeUndefined()
    }),
)

it.instance("actual accepted Goal audit and current captured reads persist their precise verification basis", () =>
  Effect.gen(function* () {
    const ctx = yield* seed()
    const fs = yield* FSUtil.Service
    const dir = yield* tmpdirScoped()
    const source = path.join(dir, "source.txt")
    const target = path.join(dir, "target.txt")
    yield* fs.writeFileString(source, "Original bytes\r\n")
    yield* fs.writeFileString(target, "Original bytes\r\n")
    const baseline = yield* Artifact.capture(fs, source)
    if (baseline.status !== "captured") throw new Error("Actual byte baseline required")
    const command = process.platform === "win32" ? "exit /b 0" : "true"
    const start = Date.now()
    const exit = yield* Effect.promise(
      () =>
        Bun.spawn(process.platform === "win32" ? ["cmd", "/d", "/s", "/c", command] : ["sh", "-c", command], {
          cwd: dir,
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
    )
    expect(exit).toBe(0)
    const bash = yield* ctx.sessions.updatePart({
      id: PartID.ascending(),
      sessionID: ctx.chat.id,
      messageID: ctx.answer.id,
      type: "tool",
      callID: "saved-command",
      tool: "bash",
      state: {
        status: "completed",
        input: { command, workdir: dir },
        output: "",
        title: "Saved check",
        metadata: { exit },
        time: { start, end: Date.now() },
      },
    })
    const reads: SessionV1.ToolPart[] = []
    for (const file of [source, target]) {
      const object = yield* KiloReadObject.file(file)
      const result = yield* KiloReadObject.use(object, (bound) =>
        read(fs, bound, Effect.succeed({ output: "Inspected saved artifact", metadata: {} })),
      )
      reads.push(
        yield* ctx.sessions.updatePart({
          id: PartID.ascending(),
          sessionID: ctx.chat.id,
          messageID: ctx.answer.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: file },
            output: result.output,
            title: "Read",
            metadata: result.metadata,
            time: { start: Date.now(), end: Date.now() },
          },
        }),
      )
    }
    const criteria: NonNullable<RayaGoal.State["criteria"]> = [
      { id: "prose", description: "Model reviewed references", verification: "Read the source" },
      {
        id: "command",
        description: "Saved command succeeded",
        verification: "Run the exact saved command",
        check: { kind: "command", command, directory: dir },
      },
      {
        id: "bytes",
        description: "Saved files have identical bytes",
        verification: "Compare the current raw bytes",
        check: {
          kind: "byte-equality",
          source: { path: source, canonical: baseline.canonical, sha256: baseline.sha256, bytes: baseline.bytes! },
          target: { path: target, canonical: target },
        },
      },
    ]
    yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
      ...ctx.goal,
      status: "active",
      activeAt: Date.now(),
      criteria,
      audit: undefined,
    } satisfies RayaGoal.State)
    const evidence = (parts: readonly SessionV1.ToolPart[]) =>
      parts.map((part) => ({
        callID: part.callID,
        messageID: part.messageID,
        partID: part.id,
        sessionID: part.sessionID,
        summary: "Recorded completed check",
      }))
    const accepted = yield* ctx.goals.update(ctx.chat.id, {
      status: "complete",
      audit: {
        summary: "Accepted audit, not the final answer",
        requirements: criteria.map((criterion) => ({
          criterionID: criterion.id,
          requirement: criterion.description,
          passed: true,
          evidence: evidence(
            criterion.id === "command" ? [bash] : criterion.id === "prose" ? reads.slice(0, 1) : reads,
          ),
        })),
      },
    })
    expect(accepted.status).toBe("complete")
    expect(accepted.audit?.requirements.every((item) => item.evidence.every((entry) => entry.record?.digest))).toBe(
      true,
    )
    yield* ctx.runner.settle(ctx.chat.id)
    const row = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
    expect(row?.outcome?.summary).toBe(text)
    expect(row?.outcome?.verification?.requirements.map((item) => item.basis)).toEqual([
      "model-audit",
      "command",
      "byte-equality",
    ])
  }),
)
