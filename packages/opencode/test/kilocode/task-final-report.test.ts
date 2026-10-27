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
import { Effect, Exit, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { RayaTaskSnapshot } from "@/kilocode/task/snapshot"
import { RayaTaskExecution } from "@/kilocode/task/execution"
import { RayaTaskQueue } from "@/kilocode/task/queue"
import { RayaTaskInbox } from "@/kilocode/task/inbox"
import { RayaRoutineReports } from "@/kilocode/task/projection"
import { Codec } from "@/kilocode/task/schema"
import * as Artifact from "@/kilocode/goal/artifact"
import { read } from "@/kilocode/goal/read-artifact"
import { KiloReadObject } from "@/kilocode/tool/read-object"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
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
  SessionRunState.node,
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
const seed = Effect.fn("FinalReportTest.seed")(function* (
  opts: {
    final?: boolean
    answer?: string
    timer?: boolean
    cron?: boolean
    unobserved?: boolean
    pending?: boolean
  } = {},
) {
  const storage = yield* Storage.Service
  const database = yield* Database.Service
  const sessions = yield* Session.Service
  const goals = RayaGoal.make({ storage, sessions })
  const runner = RayaTaskRunner.make({ storage, database, sessions })
  const queue = RayaTaskQueue.make(database)
  const scheduled = Date.now() + 60_000
  const source = opts.final
    ? yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const dir = yield* tmpdirScoped()
        const file = path.join(dir, "approved.txt")
        yield* fs.writeFileString(file, text)
        const canonical = yield* fs.realPath(file)
        return {
          fs,
          dir,
          file,
          contract: {
            kind: "file" as const,
            path: canonical,
            bytes: Buffer.byteLength(text),
            sha256: createHash("sha256").update(text).digest("hex"),
          },
        }
      })
    : undefined
  const target = yield* sessions.create({ title: "Original Routine reports" })
  const agent = yield* runner.tasks.create({
    name: "Final report fixture",
    objective: "Return the requested exact result",
    access: "brief",
    memoryScope: opts.final ? "role" : "session",
    schedule: opts.cron
      ? { kind: "cron", expr: "* * * * *", tz: "UTC" }
      : opts.timer
        ? { kind: "once", at: scheduled }
        : { kind: "manual" },
    enabled: opts.cron === true,
    sourceSessionID: target.id,
    reportSessionID: target.id,
    ...(source
      ? {
          output: {
            destination: "conversation" as const,
            description: "Return approved original text",
            criteria: [
              {
                id: "exact",
                description: "Return every original byte",
                verification: "Compare final text with approved full read",
              },
            ],
            final: source.contract,
          },
        }
      : {}),
  })
  const id = crypto.randomUUID()
  const trigger = opts.timer
    ? yield* Effect.gen(function* () {
        // A real queued/claimed occurrence fixture, not an elapsed-timer acceptance.
        yield* queue.publish({
          agentID: agent.id,
          version: agent.scheduleVersion ?? 1,
          occurrences: [{ at: scheduled, observedAt: scheduled, tz: "UTC" }],
        })
        const row = (yield* queue.pending(agent.id, agent.scheduleVersion ?? 1))[0]
        if (!row) throw new Error("Original published occurrence required")
        expect(
          yield* queue.claim({
            id: row.id,
            claimID: id,
            owner: "final-report-fixture",
            now: scheduled,
            until: scheduled + 180_000,
          }),
        ).toMatchObject({ state: "starting", claim_id: id, owner: "final-report-fixture" })
        return { kind: "timer" as const, id: row.id, scheduledAt: scheduled, observedAt: scheduled, tz: "UTC" }
      })
    : { kind: "manual" as const }
  const chat = yield* sessions.create({
    metadata: {
      rayaRoutine: { version: 2, agentID: agent.id, runID: id, scheduleVersion: agent.scheduleVersion ?? 1, trigger },
    },
  })
  if (trigger.kind === "timer")
    expect(yield* queue.link({ id: trigger.id, claimID: id, sessionID: chat.id, now: scheduled })).toBe(true)
  const prior = opts.unobserved
    ? undefined
    : yield* sessions.updateMessage({
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
    prior?.id,
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
  // Match native startup: arm first, then publish and bind the actual original input.
  const user =
    prior ??
    (yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: chat.id,
      role: "user",
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    }))
  if (opts.unobserved)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: user.id,
      type: "text",
      text: agent.objective,
    })
  const active = yield* goals.initial(chat.id, created.intent!, "final-report-fixture")
  if (!active?.dispatch) throw new Error("The actual original Goal dispatch was not admitted")
  const inspected = source
    ? yield* Effect.gen(function* () {
        const at = Date.now()
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: chat.id,
          role: "assistant",
          parentID: user.id,
          agent: "build",
          mode: "build",
          modelID: ref.modelID,
          providerID: ref.providerID,
          path: { cwd: source.dir, root: source.dir },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: at },
          finish: "tool-calls",
        })
        const object = yield* KiloReadObject.file(source.file)
        const result = yield* KiloReadObject.use(object, (bound) =>
          read(
            source.fs,
            bound,
            Effect.gen(function* () {
              const bytes = yield* Effect.tryPromise(() => bound.read())
              return {
                output: bytes.toString("utf8"),
                metadata: {
                  display: {
                    type: "file",
                    text: bytes
                      .toString("utf8")
                      .replace(/\r\n|\r/g, "\n")
                      .replace(/\n$/, ""),
                    lineStart: 1,
                    lineEnd: 3,
                    totalLines: 3,
                    truncated: false,
                  },
                },
              }
            }),
          ),
        )
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: chat.id,
          messageID: message.id,
          type: "tool",
          tool: "read",
          callID: crypto.randomUUID(),
          state: {
            status: "completed",
            input: { filePath: source.file },
            title: "Approved full read",
            output: result.output,
            metadata: result.metadata,
            time: { start: at, end: Date.now() },
          },
        })
        yield* sessions.updateMessage({ ...message, time: { ...message.time, completed: Date.now() } })
        return { message, part }
      })
    : undefined
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
    cost: opts.final ? 0.25 : 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: at, completed: at },
    finish: "stop",
  })
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: chat.id,
    messageID: answer.id,
    type: "text",
    text: opts.answer ?? text,
  })
  const finished = yield* goals.finished(chat.id, answer.id)
  if (!finished?.dispatch || finished.dispatch.phase !== "finished") throw new Error("Actual final bookkeeping failed")
  const goal = opts.pending
    ? finished
    : {
        ...finished,
        status: "complete" as const,
        activeAt: undefined,
        audit: {
          summary: "Audit paraphrase, deliberately different from the final answer",
          verifiedAt: at,
          requirements: [],
        },
      }
  if (!opts.pending) yield* storage.replace(["raya", "goal", chat.id], goal satisfies RayaGoal.State)
  const run = yield* runner.tasks.record({
    id,
    agentID: agent.id,
    sessionID: chat.id,
    at: created.createdAt,
    status: "running",
    scheduleVersion: agent.scheduleVersion ?? 1,
    trigger,
    goalCreatedAt: created.createdAt,
    trace: opts.unobserved
      ? undefined
      : {
          version: 1,
          goalCreatedAt: created.createdAt,
          turns: [
            {
              turnID: user.id,
              messages: [
                ...(inspected
                  ? [
                      {
                        messageID: inspected.message.id,
                        actions: [{ actionID: inspected.part.id, status: "completed" as const }],
                      },
                    ]
                  : []),
                { messageID: answer.id, actions: [] },
              ],
            },
          ],
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
  return {
    storage,
    database,
    sessions,
    goals,
    runner,
    agent,
    chat,
    user,
    answer,
    part,
    goal,
    run,
    source,
    inspected,
    queue,
  }
})

it.instance("retired ordinary terminal reports recover without replaying their original work", () =>
  Effect.gen(function* () {
    const runs = yield* SessionRunState.Service
    for (const status of ["blocked", "error", "stopped"] as const) {
      const ctx = yield* seed({ pending: true })
      const reports = RayaRoutineReports.make(ctx)
      const target = ctx.agent.reportSessionID
      if (!target) return yield* Effect.die(new Error("Missing original report destination"))
      yield* reports.publish({ agent: ctx.agent, run: ctx.run })
      const initial = (yield* reports.page({ sessionID: target })).items.find((card) => card.runID === ctx.run.id)
      if (!initial) return yield* Effect.die(new Error("Missing original running report"))
      const execution = RayaTaskExecution.make(ctx.storage)
      yield* execution.enter(ctx.run, Effect.void)
      const fault = { armed: true, hits: 0 }
      const storage: Storage.Interface = {
        ...ctx.storage,
        replace: (key, value) =>
          Effect.gen(function* () {
            if (
              fault.armed &&
              key[0] === "raya" &&
              key[1] === "routine-reports" &&
              key[2] === createHash("sha256").update(ctx.run.id).digest("hex") &&
              typeof value === "object" &&
              value !== null &&
              "status" in value &&
              value.status === status
            ) {
              fault.hits++
              return yield* Effect.die(new Error("Injected original terminal report failure"))
            }
            yield* ctx.storage.replace(key, value)
          }),
      }
      const original = RayaTaskRunner.make({ ...ctx, storage })
      if (status === "blocked")
        yield* ctx.goals.update(ctx.chat.id, { status: "blocked", reason: "An ordinary dependency is unavailable." })
      if (status === "error") yield* ctx.goals.clear(ctx.chat.id, ctx.goal.intent ?? "unset")
      if (status === "stopped") {
        const receipt = yield* original.stopGoal((tasks) =>
          ctx.goals.stop(ctx.chat.id, ctx.goal.intent ?? "unset", runs, undefined, undefined, {
            prepare: (id) =>
              tasks.prepare(id).pipe(Effect.mapError((err) => new RayaGoal.AuditError({ message: err.message }))),
            finish: (id, pin, finished) =>
              tasks
                .finish(id, pin, finished)
                .pipe(Effect.mapError((err) => new RayaGoal.AuditError({ message: err.message }))),
          }),
        )
        expect(receipt.phase).toBe("finished")
      }
      if (status !== "stopped") yield* original.settle(ctx.chat.id)
      expect(fault.hits).toBe(1)
      const terminal = (yield* original.tasks.runsFor(ctx.agent.id)).find((run) => run.id === ctx.run.id)
      if (!terminal) return yield* Effect.die(new Error("Missing actual terminal run"))
      expect(terminal.status).toBe(status)
      expect(yield* execution.receipt(ctx.run)).toBeUndefined()
      expect((yield* reports.page({ sessionID: target })).items.find((card) => card.id === initial.id)?.status).toBe(
        "running",
      )
      const prior = yield* ctx.goals.get(ctx.chat.id)
      if (prior) yield* ctx.goals.clear(ctx.chat.id, prior.intent ?? "unset")
      const replacement = yield* ctx.goals.create(ctx.chat.id, "A later owner request must not be replayed")
      const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
      const destination = yield* ctx.sessions.messages({ sessionID: target })
      const history = yield* original.tasks.runsFor(ctx.agent.id)
      fault.armed = false
      const fresh = RayaTaskRunner.make({ ...ctx, storage: { ...ctx.storage } })
      yield* fresh.revive()
      const recovered = (yield* reports.page({ sessionID: target })).items.find((card) => card.id === initial.id)
      if (!recovered) return yield* Effect.die(new Error("Missing recovered original report"))
      expect(recovered.status).toBe(status)
      expect(recovered.runRevision).toBe(terminal.revision)
      expect(recovered.reportSessionID).toBe(target)
      expect(recovered.summary).toBe(terminal.outcome?.summary ?? terminal.blockedReason ?? "")
      yield* fresh.revive()
      expect((yield* reports.page({ sessionID: target })).items.filter((card) => card.runID === ctx.run.id)).toEqual([
        recovered,
      ])
      expect(yield* fresh.tasks.runsFor(ctx.agent.id)).toEqual(history)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      expect(yield* ctx.sessions.messages({ sessionID: target })).toEqual(destination)
      expect(yield* ctx.goals.get(ctx.chat.id)).toEqual(replacement)
      expect(yield* execution.receipt(ctx.run)).toBeUndefined()
    }
  }),
)

it.instance("a completed routine repairs its original report after publication failure and execution retirement", () =>
  Effect.gen(function* () {
    const ctx = yield* seed()
    const reports = RayaRoutineReports.make(ctx)
    const target = ctx.agent.reportSessionID
    if (!target) return yield* Effect.die(new Error("Missing original report destination"))
    yield* reports.publish({ agent: ctx.agent, run: ctx.run })
    const initial = (yield* reports.page({ sessionID: target })).items.find((card) => card.runID === ctx.run.id)
    if (!initial) return yield* Effect.die(new Error("The original running report is unavailable"))
    expect(initial?.status).toBe("running")
    const execution = RayaTaskExecution.make(ctx.storage)
    yield* execution.enter(ctx.run, Effect.void)
    expect((yield* execution.receipt(ctx.run))?.state).toBe("idle")
    const fault = { armed: true, hits: 0 }
    const storage: Storage.Interface = {
      ...ctx.storage,
      replace: (key, value) =>
        Effect.gen(function* () {
          if (
            fault.armed &&
            key[0] === "raya" &&
            key[1] === "routine-reports" &&
            key[2] === createHash("sha256").update(ctx.run.id).digest("hex") &&
            typeof value === "object" &&
            value !== null &&
            "status" in value &&
            value.status === "complete"
          ) {
            fault.hits += 1
            return yield* Effect.die(new Error("Injected terminal requester-card write failure"))
          }
          yield* ctx.storage.replace(key, value)
        }),
    }
    const original = RayaTaskRunner.make({ ...ctx, storage })
    expect((yield* original.settle(ctx.chat.id).pipe(Effect.exit))._tag).toBe("Success")
    expect(fault.hits).toBe(1)
    const terminal = (yield* original.tasks.runsFor(ctx.agent.id)).find((run) => run.id === ctx.run.id)
    expect(terminal?.status).toBe("complete")
    expect(yield* execution.receipt(ctx.run)).toBeUndefined()
    expect((yield* reports.page({ sessionID: target })).items.find((card) => card.id === initial?.id)?.status).toBe(
      "running",
    )
    fault.armed = false
    const fresh = RayaTaskRunner.make({ ...ctx, storage: { ...ctx.storage } })
    const replacement = yield* ctx.goals.create(ctx.chat.id, "A newer owner goal must remain untouched")
    const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
    const destination = yield* ctx.sessions.messages({ sessionID: target })
    const runs = yield* fresh.tasks.runsFor(ctx.agent.id)
    yield* fresh.revive()
    const recovered = (yield* reports.page({ sessionID: target })).items.find((card) => card.id === initial?.id)
    if (!recovered) return yield* Effect.die(new Error("The original completed report is unavailable"))
    expect(yield* fresh.tasks.runsFor(ctx.agent.id)).toEqual(runs)
    expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
    expect(yield* execution.receipt(ctx.run)).toBeUndefined()
    expect(recovered?.status).toBe("complete")
    expect(recovered.id).toBe(initial.id)
    expect(recovered?.reportSessionID).toBe(target)
    expect(recovered?.runRevision).toBe(terminal?.revision)
    expect(yield* ctx.goals.get(ctx.chat.id)).toEqual(replacement)
    expect(yield* ctx.sessions.messages({ sessionID: target })).toEqual(destination)
    yield* fresh.revive()
    const repeated = (yield* reports.page({ sessionID: target })).items.filter((card) => card.runID === ctx.run.id)
    expect(repeated).toEqual([recovered])
    expect(yield* fresh.tasks.runsFor(ctx.agent.id)).toEqual(runs)
    expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
    expect(yield* ctx.sessions.messages({ sessionID: target })).toEqual(destination)
    expect(yield* ctx.goals.get(ctx.chat.id)).toEqual(replacement)
    expect(yield* execution.receipt(ctx.run)).toBeUndefined()
  }),
)

it.instance(
  "a blocked failed-final report recovers its exact card after publication failure and execution retirement",
  () =>
    Effect.gen(function* () {
      const answer = `Audit passed. ${text}`
      const ctx = yield* seed({ final: true, answer })
      const reports = RayaRoutineReports.make(ctx)
      const target = ctx.agent.reportSessionID
      if (!target) throw new Error("Original report destination required")
      yield* reports.publish({ agent: ctx.agent, run: ctx.run })
      const initial = (yield* reports.page({ sessionID: target })).items.find((card) => card.runID === ctx.run.id)
      if (!initial) throw new Error("Original running report required")
      expect(initial.status).toBe("running")
      const execution = RayaTaskExecution.make(ctx.storage)
      yield* execution.enter(ctx.run, Effect.void)
      const fault = { hits: 0 }
      const storage: Storage.Interface = {
        ...ctx.storage,
        replace: (key, value) =>
          Effect.gen(function* () {
            if (
              key[0] === "raya" &&
              key[1] === "routine-reports" &&
              key[2] === createHash("sha256").update(ctx.run.id).digest("hex") &&
              typeof value === "object" &&
              value !== null &&
              "status" in value &&
              value.status === "blocked"
            ) {
              fault.hits++
              return yield* Effect.die(new Error("Injected failed-final requester-card write failure"))
            }
            yield* ctx.storage.replace(key, value)
          }),
      }
      const original = RayaTaskRunner.make({ ...ctx, storage })
      expect((yield* original.settle(ctx.chat.id).pipe(Effect.exit))._tag).toBe("Success")
      expect(fault.hits).toBeGreaterThan(0)
      const runs = yield* original.tasks.runsFor(ctx.agent.id)
      const terminal = runs.find((run) => run.id === ctx.run.id)
      if (!terminal) throw new Error("Retained blocked run required")
      expect(terminal.status).toBe("blocked")
      expect(terminal.outcome?.summary).toBe(answer)
      expect(terminal.outcome?.delivery?.reason).toBe("final-mismatch")
      expect(terminal.outcome?.delivery?.status).toBe("mismatch")
      expect(terminal.outcome?.report).toMatchObject({
        messageID: ctx.answer.id,
        parentID: ctx.user.id,
        sha256: createHash("sha256").update(answer).digest("hex"),
      })
      expect(yield* execution.receipt(ctx.run)).toBeUndefined()
      expect((yield* reports.page({ sessionID: target })).items.find((card) => card.id === initial.id)?.status).toBe(
        "running",
      )
      const replacement = yield* ctx.goals.create(
        ctx.chat.id,
        "A newer owner Goal must not be used for historical report repair",
      )
      const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
      const destination = yield* ctx.sessions.messages({ sessionID: target })
      const memory = yield* original.tasks.recall(ctx.agent.id)
      const events = yield* original.tasks.eventsFor(ctx.agent.id)
      const fresh = RayaTaskRunner.make({ ...ctx, storage: { ...ctx.storage } })
      yield* fresh.revive()
      const recovered = (yield* reports.page({ sessionID: target })).items.find((card) => card.id === initial.id)
      if (!recovered) throw new Error("Recovered failed-final report required")
      expect(recovered.status).toBe("blocked")
      expect(recovered.summary).toBe(answer)
      expect(recovered.id).toBe(initial.id)
      expect(recovered.reportSessionID).toBe(target)
      expect(recovered.runRevision).toBe(terminal.revision)
      expect(recovered.revision).toBeGreaterThan(initial.revision)
      yield* fresh.revive()
      expect((yield* reports.page({ sessionID: target })).items.filter((card) => card.runID === ctx.run.id)).toEqual([
        recovered,
      ])
      expect(yield* fresh.tasks.runsFor(ctx.agent.id)).toEqual(runs)
      expect(yield* fresh.tasks.eventsFor(ctx.agent.id)).toEqual(events)
      expect(yield* fresh.tasks.recall(ctx.agent.id)).toEqual(memory)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      expect(yield* ctx.sessions.messages({ sessionID: target })).toEqual(destination)
      expect(yield* ctx.goals.get(ctx.chat.id)).toEqual(replacement)
      expect(yield* execution.receipt(ctx.run)).toBeUndefined()
    }),
)

it.instance(
  "failed frozen final output retains the original report without learning success or replaying on repeat settlement",
  () =>
    Effect.gen(function* () {
      const answer = `Audit passed. ${text}`
      const ctx = yield* seed({ final: true, answer, timer: true, cron: true })
      const execution = RayaTaskExecution.make(ctx.storage)
      yield* execution.enter(ctx.run, Effect.void)
      const inbox = RayaTaskInbox.make(ctx.database)
      const queued = yield* inbox.publish({
        agentID: ctx.agent.id,
        source: `original-followup:${ctx.run.id}`,
        kind: "user",
        body: "Owner-queued separate conversation must await explicit review",
      })
      const pending = yield* inbox.pending(ctx.agent.id)
      expect(pending?.id).toBe(queued.id)
      if (ctx.run.trigger?.kind !== "timer") throw new Error("Original timer fixture required")
      const cursor = yield* ctx.queue.cursor(ctx.agent.id, ctx.run.scheduleVersion ?? 1)
      const memory = yield* ctx.runner.tasks.recall(ctx.agent.id)
      const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
      yield* ctx.runner.settle(ctx.chat.id)
      const rows = yield* ctx.runner.tasks.runsFor(ctx.agent.id)
      const row = rows.find((row) => row.id === ctx.run.id)
      expect(row?.outcome?.delivery?.reason).toBe("final-mismatch")
      expect(row?.status).toBe("blocked")
      expect(row?.outcome?.summary).toBe(answer)
      expect(row?.outcome?.cost).toBe(0.25)
      expect(row?.outcome?.report).toMatchObject({
        messageID: ctx.answer.id,
        parentID: ctx.user.id,
        sha256: createHash("sha256").update(answer).digest("hex"),
      })
      expect(row?.outcome?.delivery).toMatchObject({
        version: 1,
        status: "mismatch",
        contract: ctx.source?.contract,
        final: {
          messageID: ctx.answer.id,
          bytes: Buffer.byteLength(answer),
          sha256: createHash("sha256").update(answer).digest("hex"),
        },
      })
      expect(yield* ctx.runner.tasks.recall(ctx.agent.id)).toEqual(memory)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      expect(yield* execution.receipt(ctx.run)).toBeUndefined()
      const occurrence = yield* ctx.queue.get(ctx.run.trigger.id)
      expect(occurrence).toMatchObject({ state: "complete", claim_id: ctx.run.id, session_id: ctx.chat.id })
      expect(yield* ctx.queue.cursor(ctx.agent.id, ctx.run.scheduleVersion ?? 1)).toEqual(cursor)
      expect(yield* inbox.pending(ctx.agent.id)).toEqual(pending)
      const page = yield* inbox.page(ctx.agent.id)
      expect(
        page.messages.filter((message) => message.kind === "report" && message.sessionID === ctx.chat.id),
      ).toHaveLength(1)
      const events = yield* ctx.runner.tasks.eventsFor(ctx.agent.id)
      const recovered = RayaTaskRunner.make(ctx)
      yield* recovered.settle(ctx.chat.id)
      yield* recovered.settle(ctx.chat.id)
      yield* recovered.revive()
      expect(yield* recovered.tasks.runsFor(ctx.agent.id)).toEqual(rows)
      expect(yield* recovered.tasks.eventsFor(ctx.agent.id)).toEqual(events)
      expect(yield* recovered.tasks.recall(ctx.agent.id)).toEqual(memory)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      expect(yield* inbox.pending(ctx.agent.id)).toEqual(pending)
      expect(yield* inbox.page(ctx.agent.id)).toEqual(page)
      expect(yield* ctx.queue.get(ctx.run.trigger.id)).toEqual(occurrence)
      const due = ctx.run.trigger.scheduledAt + 120_000
      yield* recovered.tick(due)
      const preview = (yield* recovered.preview(due)).find((item) => item.id === ctx.agent.id)
      expect(preview?.nextRun).toBeUndefined()
      expect(preview?.note).toContain("final answer check needs review")
      expect(yield* recovered.tasks.runsFor(ctx.agent.id)).toEqual(rows)
      expect(yield* ctx.queue.cursor(ctx.agent.id, ctx.run.scheduleVersion ?? 1)).toEqual(cursor)
      expect(yield* ctx.queue.pending(ctx.agent.id, ctx.run.scheduleVersion ?? 1)).toEqual([])
      expect(yield* ctx.queue.active(ctx.agent.id)).toEqual([])
      expect(yield* ctx.queue.get(ctx.run.trigger.id)).toEqual(occurrence)
      expect(yield* inbox.page(ctx.agent.id)).toEqual(page)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
    }),
)

it.instance(
  "a retained failed delivery with a foreign startup session cannot consume its occurrence or retire its original owner",
  () =>
    Effect.gen(function* () {
      const ctx = yield* seed({ final: true, answer: `Extra prose ${text}`, timer: true })
      const execution = RayaTaskExecution.make(ctx.storage)
      yield* execution.enter(ctx.run, Effect.void)
      const owner = yield* execution.receipt(ctx.run)
      expect(owner?.state).toBe("idle")
      const state = { armed: true, committed: false }
      const storage: Storage.Interface = {
        ...ctx.storage,
        replace: (key, value) =>
          Effect.gen(function* () {
            yield* ctx.storage.replace(key, value)
            if (!state.armed || key[0] !== "raya" || key[1] !== "agent-runs" || key[2] !== ctx.agent.id) return
            const history = yield* Schema.decodeUnknownEffect(Codec.History)(value).pipe(Effect.orDie)
            if (!history.runs.some((run) => run.id === ctx.run.id && run.outcome?.delivery?.status === "mismatch"))
              return
            state.armed = false
            state.committed = true
            return yield* Effect.die(new Error("Controlled interruption after actual failed Run publication"))
          }),
      }
      const original = RayaTaskRunner.make({ ...ctx, storage })
      expect((yield* original.settle(ctx.chat.id).pipe(Effect.exit))._tag).toBe("Failure")
      expect(state.committed).toBe(true)
      const rows = yield* ctx.runner.tasks.runsFor(ctx.agent.id)
      expect(rows.find((row) => row.id === ctx.run.id)?.status).toBe("blocked")
      if (ctx.run.trigger?.kind !== "timer") throw new Error("Original timer required")
      const occurrence = yield* ctx.queue.get(ctx.run.trigger.id)
      expect(occurrence).toMatchObject({ state: "linked", claim_id: ctx.run.id, session_id: ctx.chat.id })
      expect(yield* execution.receipt(ctx.run)).toEqual(owner)
      const snapshot = yield* RayaTaskSnapshot.make(ctx).find(ctx.run.id)
      if (!snapshot) throw new Error("Original immutable startup required")
      const foreign = yield* ctx.sessions.create({ title: "Different startup session" })
      const key = ["raya", "agent-starts", createHash("sha256").update(ctx.run.id).digest("hex")]
      // Corrupt only the requested field in this private fixture's saved snapshot.
      yield* ctx.storage.replace(key, { ...snapshot, sessionID: foreign.id })
      const inbox = RayaTaskInbox.make(ctx.database)
      const page = yield* inbox.page(ctx.agent.id)
      const events = yield* ctx.runner.tasks.eventsFor(ctx.agent.id)
      const memory = yield* ctx.runner.tasks.recall(ctx.agent.id)
      const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
      const recovered = RayaTaskRunner.make(ctx)
      yield* recovered.settle(ctx.chat.id)
      yield* recovered.revive()
      expect(yield* recovered.tasks.runsFor(ctx.agent.id)).toEqual(rows)
      expect(yield* recovered.tasks.eventsFor(ctx.agent.id)).toEqual(events)
      expect(yield* execution.receipt(ctx.run)).toEqual(owner)
      expect(yield* ctx.queue.get(ctx.run.trigger.id)).toEqual(occurrence)
      expect(yield* inbox.page(ctx.agent.id)).toEqual(page)
      expect(yield* recovered.tasks.recall(ctx.agent.id)).toEqual(memory)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      // Restore that sole field before draining the genuine original local owner.
      yield* ctx.storage.replace(key, snapshot)
      yield* recovered.settle(ctx.chat.id)
      expect(yield* execution.receipt(ctx.run)).toBeUndefined()
    }),
)

it.instance(
  "a genuinely closed original turn without final text is retained as unavailable without fabricating an answer",
  () =>
    Effect.gen(function* () {
      const ctx = yield* seed({ final: true })
      yield* ctx.sessions.removePart({ sessionID: ctx.chat.id, messageID: ctx.answer.id, partID: ctx.part.id })
      const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
      const memory = yield* ctx.runner.tasks.recall(ctx.agent.id)
      yield* ctx.runner.settle(ctx.chat.id)
      const rows = yield* ctx.runner.tasks.runsFor(ctx.agent.id)
      const row = rows.find((run) => run.id === ctx.run.id)
      expect(row?.status).toBe("blocked")
      expect(row?.outcome?.summary).toBe("")
      expect(row?.outcome?.report).toMatchObject({
        messageID: ctx.answer.id,
        parentID: ctx.user.id,
        partIDs: [],
        sha256: createHash("sha256").update("").digest("hex"),
      })
      expect(row?.outcome?.delivery).toMatchObject({
        version: 1,
        status: "unavailable",
        reason: "final-missing",
        contract: ctx.source?.contract,
        final: { messageID: ctx.answer.id, bytes: 0, sha256: createHash("sha256").update("").digest("hex") },
      })
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      expect(yield* ctx.runner.tasks.recall(ctx.agent.id)).toEqual(memory)
      const events = yield* ctx.runner.tasks.eventsFor(ctx.agent.id)
      const inbox = RayaTaskInbox.make(ctx.database)
      const page = yield* inbox.page(ctx.agent.id)
      const recovered = RayaTaskRunner.make(ctx)
      yield* recovered.settle(ctx.chat.id)
      yield* recovered.revive()
      yield* recovered.settle(ctx.chat.id)
      expect(yield* recovered.tasks.runsFor(ctx.agent.id)).toEqual(rows)
      expect(yield* recovered.tasks.eventsFor(ctx.agent.id)).toEqual(events)
      expect(yield* inbox.page(ctx.agent.id)).toEqual(page)
      expect(yield* recovered.tasks.recall(ctx.agent.id)).toEqual(memory)
      expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
    }),
)

for (const quoted of [false, true]) {
  it.instance(
    `a completed original turn before observation ${quoted ? "rejects quoted" : "accepts exact"} frozen final bytes and persists its trace`,
    () =>
      Effect.gen(function* () {
        const answer = quoted ? `"${text}"` : text
        const ctx = yield* seed({ final: true, answer, unobserved: true })
        const inspected = ctx.inspected
        if (!inspected) throw new Error("The original full Read is required")
        expect(ctx.run.trace).toBeUndefined()
        expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id))[0]?.trace).toBeUndefined()
        expect(ctx.goal.inputs).toEqual([ctx.user.id])
        expect(ctx.user.time.created).toBeGreaterThanOrEqual(ctx.goal.createdAt)
        expect(ctx.goal.dispatch).toMatchObject({
          phase: "finished",
          assistantID: ctx.answer.id,
          messageID: ctx.user.id,
        })
        // No observe, subscriber replay, model invocation or reconstructed fixture trace precedes settlement.
        yield* ctx.runner.settle(ctx.chat.id)
        const row = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
        expect(row?.outcome?.delivery?.status).toBe(quoted ? "mismatch" : "passed")
        expect(row?.outcome?.delivery?.reason).toBe(quoted ? "final-mismatch" : "verified")
        expect(row?.status).toBe(quoted ? "blocked" : "complete")
        expect(row?.outcome?.summary).toBe(answer)
        expect(row?.outcome?.delivery?.source).toMatchObject({
          messageID: inspected.message.id,
          partID: inspected.part.id,
        })
        expect(Schema.is(Codec.Trace)(row?.trace)).toBe(true)
        expect(row?.trace).toEqual({
          version: 1,
          goalCreatedAt: ctx.goal.createdAt,
          turns: [
            {
              turnID: ctx.user.id,
              messages: [
                {
                  messageID: inspected.message.id,
                  actions: [{ actionID: inspected.part.id, status: "completed" }],
                },
                { messageID: ctx.answer.id, actions: [] },
              ],
            },
          ],
        })
        const reopened = RayaTaskRunner.make(ctx)
        expect((yield* reopened.tasks.runsFor(ctx.agent.id)).find((item) => item.id === ctx.run.id)?.trace).toEqual(
          row?.trace,
        )
        expect(yield* reopened.tasks.recall(ctx.agent.id)).toBe(quoted ? "" : text)
      }),
  )
}

for (const defect of ["saved-trace", "new-goal", "inputs"] as const) {
  it.instance(`settlement cannot launder ${defect} associations while deriving a missing final-delivery trace`, () =>
    Effect.gen(function* () {
      const ctx = yield* seed({ final: true, unobserved: true })
      const memory = yield* ctx.runner.tasks.recall(ctx.agent.id)
      if (defect === "saved-trace") {
        const saved = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
        if (!saved) throw new Error("The original persisted run is required")
        expect(saved.trace).toBeUndefined()
        const foreign = yield* ctx.sessions.create({ title: "Foreign trace source" })
        const user = yield* ctx.sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: foreign.id,
          role: "user",
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        const trace = {
          version: 1 as const,
          goalCreatedAt: ctx.goal.createdAt,
          turns: [{ turnID: user.id, messages: [] }],
        }
        expect(Schema.is(Codec.Trace)(trace)).toBe(true)
        expect(yield* ctx.runner.tasks.transition(saved, { ...saved, trace })).toBe(true)
        expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)?.trace).toEqual(
          trace,
        )
      }
      if (defect === "new-goal")
        yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], {
          ...ctx.goal,
          createdAt: ctx.goal.createdAt + 1,
          intent: crypto.randomUUID(),
        })
      if (defect === "inputs")
        yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], { ...ctx.goal, inputs: [MessageID.ascending()] })
      const original = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
      yield* ctx.runner.settle(ctx.chat.id)
      const row = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
      expect(row?.outcome?.delivery?.status).not.toBe("passed")
      expect(row?.status).not.toBe("complete")
      expect(row?.trace).toEqual(original?.trace)
      expect(yield* ctx.runner.tasks.recall(ctx.agent.id)).toBe(memory)
      if (defect !== "inputs") expect(row).toEqual(original)
    }),
  )
}

it.instance("an exact frozen final output completes and learns only the actual original answer", () =>
  Effect.gen(function* () {
    const ctx = yield* seed({ final: true })
    yield* ctx.runner.settle(ctx.chat.id)
    const row = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
    expect(row?.outcome?.delivery?.reason).toBe("verified")
    expect(row?.status).toBe("complete")
    expect(row?.outcome?.summary).toBe(text)
    expect(row?.outcome?.delivery).toMatchObject({
      status: "passed",
      contract: ctx.source?.contract,
      source: { messageID: ctx.inspected?.message.id, partID: ctx.inspected?.part.id },
    })
    expect(yield* ctx.runner.tasks.recall(ctx.agent.id)).toBe(text)
  }),
)

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

for (const variant of ["original", "goal", "dispatch"] as const) {
  const replacement = variant !== "original"
  it.instance(
    `TurnClose bookkeeping ${variant === "dispatch" ? "refuses a changed dispatch identity after" : replacement ? "refuses a replaced Goal after" : "joins"} the same original finalization winning its real CAS`,
    () =>
      Effect.gen(function* () {
        const ctx = yield* seed({ final: true, unobserved: true })
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
        const original = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
        if (!original) throw new Error("The original persisted run is required")
        const execution = RayaTaskExecution.make(ctx.storage)
        yield* execution.enter(original, Effect.void)
        const owner = yield* execution.receipt(original)
        expect(owner?.state).toBe("idle")
        const events = yield* ctx.runner.tasks.eventsFor(ctx.agent.id)
        const messages = yield* ctx.sessions.messages({ sessionID: ctx.chat.id })
        const memory = yield* ctx.runner.tasks.recall(ctx.agent.id)
        const state: { held: boolean; winner?: RayaGoal.State; replacement?: RayaGoal.State } = { held: false }
        const runner = RayaTaskRunner.make({
          storage: ctx.storage,
          database: ctx.database,
          sessions: {
            create: ctx.sessions.create,
            get: ctx.sessions.get,
            children: ctx.sessions.children,
            messages: (input) =>
              Effect.gen(function* () {
                if (!state.held && input.sessionID === ctx.chat.id) {
                  yield* Effect.gen(function* () {
                    state.held = true
                    // The losing production finished() has read its Goal but has not acquired the save lock.
                    // Commit the independent real finished() first; no CAS or finalization logic is injected.
                    state.winner = yield* ctx.goals.finished(ctx.chat.id, ctx.answer.id)
                    if (!state.winner) throw new Error("The independent original finalization must commit")
                    if (variant === "goal")
                      state.replacement = yield* ctx.goals.create(ctx.chat.id, "A genuinely new owner assignment")
                    if (variant === "dispatch") {
                      const changed = {
                        ...state.winner,
                        revision: crypto.randomUUID(),
                        dispatch: { ...state.winner.dispatch!, id: crypto.randomUUID() },
                      }
                      expect(Schema.is(RayaGoal.State)(changed)).toBe(true)
                      yield* ctx.storage.replace(["raya", "goal", ctx.chat.id], changed)
                      state.replacement = yield* ctx.goals.get(ctx.chat.id)
                      expect(state.replacement?.dispatch?.id).not.toBe(state.winner.dispatch?.id)
                      expect(state.replacement?.dispatch?.assistantID).toBe(ctx.answer.id)
                      expect(state.replacement?.dispatch?.messageID).toBe(ctx.user.id)
                    }
                  }).pipe(Effect.orDie)
                }
                return yield* ctx.sessions.messages(input)
              }),
          },
        })
        const observed = yield* runner
          .observe(ctx.chat.id, {
            reason: "completed",
            messageID: ctx.answer.id,
            goalIntent: ctx.goal.intent,
          })
          .pipe(Effect.exit)
        expect(state.held).toBe(true)
        expect(state.winner?.dispatch).toMatchObject({
          phase: "finished",
          assistantID: ctx.answer.id,
          messageID: ctx.user.id,
          outcome: "completed",
        })
        expect(state.winner?.revision).not.toBe(ctx.goal.revision)
        expect(Exit.isFailure(observed)).toBe(replacement)
        if (replacement) {
          if (variant === "goal") expect(state.replacement?.intent).not.toBe(ctx.goal.intent)
          if (variant === "dispatch") expect(state.replacement?.intent).toBe(ctx.goal.intent)
          expect(yield* ctx.goals.get(ctx.chat.id)).toEqual(state.replacement)
          if (variant === "goal") yield* runner.settle(ctx.chat.id)
          expect((yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)).toEqual(original)
          expect(yield* ctx.runner.tasks.eventsFor(ctx.agent.id)).toEqual(events)
          expect(yield* execution.receipt(original)).toEqual(owner)
          expect(yield* ctx.runner.tasks.recall(ctx.agent.id)).toBe(memory)
          const report = yield* ctx.storage
            .read(["raya", "routine-reports", createHash("sha256").update(ctx.run.id).digest("hex")])
            .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
          expect(report).toBeUndefined()
        }
        if (!replacement) {
          expect(yield* ctx.goals.get(ctx.chat.id)).toEqual(state.winner)
          const traced = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
          expect(Schema.is(Codec.Trace)(traced?.trace)).toBe(true)
          yield* runner.settle(ctx.chat.id)
          const settled = (yield* ctx.runner.tasks.runsFor(ctx.agent.id)).find((row) => row.id === ctx.run.id)
          expect(settled?.status).toBe("complete")
          expect(settled?.outcome?.delivery?.status).toBe("passed")
          expect(settled?.outcome?.report?.messageID).toBe(ctx.answer.id)
        }
        expect(yield* ctx.sessions.messages({ sessionID: ctx.chat.id })).toEqual(messages)
      }),
  )
}

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
      if (!ctx.goal.audit) return yield* Effect.die(new Error("The accepted audit fixture is unavailable"))
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
      const ctx = yield* seed({ final: true })
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
