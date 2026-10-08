import { expect } from "bun:test"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Exit, Layer, Schema } from "effect"
import { Bus } from "@/bus"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { RayaGoal } from "@/kilocode/goal"
import { RayaTask } from "@/kilocode/task"
import { RayaTaskRunner } from "@/kilocode/task/runner"
import { Codec } from "@/kilocode/task/schema"
import { KiloSessionEvent } from "@/kilocode/session/event"
import { trace } from "@/kilocode/task/trace"
import { scheduler } from "@/kilocode/task/admission"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Storage } from "@/storage/storage"
import { pollWithTimeout, testEffect } from "../lib/effect"

const root = LayerNode.group([
  Bus.node,
  Database.node,
  Session.node,
  SessionProjector.node,
  Storage.node,
  CrossSpawnSpawner.node,
  InstanceStore.node,
])
const env = AppNodeBuilder.build(root, [
  [
    InstanceStore.bootstrapNode,
    Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
  ],
])
const it = testEffect(env.pipe(Layer.provide(RuntimeFlags.layer())))
const report = Schema.decodeUnknownSync(
  Schema.toCodecJson(
    Schema.Struct({ page: Schema.optional(Codec.EventPage), refused: Schema.optional(Schema.Literal(true)) }),
  ),
)

function replay(id: string, cursor: number) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dir, "fixtures/task-trace-replay.ts"),
      path.join(Global.Path.data, "storage"),
      id,
      String(cursor),
    ],
    { env: process.env, stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 20_000, maxBuffer: 512 * 1024 },
  )
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  const line = child.stdout
    .toString()
    .split(/\r?\n/)
    .find((line) => line.startsWith("RAYA_TRACE_RESULT "))
  if (!line) throw new Error("Fresh trace process returned no replay report")
  return report(JSON.parse(line.slice("RAYA_TRACE_RESULT ".length)))
}

it.instance(
  "persists redacted exact turn/action identities and refuses stale or corrupt associations",
  () =>
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const database = yield* Database.Service
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      // Subscribe with an empty roster. No retained worker is revived and no model is dispatched.
      yield* RayaTaskRunner.subscribe({ bus, database, storage, sessions })
      const runner = RayaTaskRunner.make({ database, storage, sessions })
      const goals = RayaGoal.make({ storage, sessions })
      const agent = yield* runner.tasks.create({
        name: "Synthetic trace worker",
        objective: "Retain synthetic identities",
        access: "brief",
        memoryScope: "session",
        schedule: { kind: "manual" },
      })
      const run = yield* runner.ask(agent.id, "Retain synthetic identities", { defer: true })
      const initial = yield* goals.get(run.sessionID)
      if (!initial) throw new Error("Expected a durable initial goal")
      expect(run.goalCreatedAt).toBe(initial.createdAt)
      const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
      const user = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: run.sessionID,
        agent: "test",
        model,
        time: { created: Date.now() },
      })
      const secret = "private synthetic protocol and credential marker"
      yield* sessions.updatePart({
        id: PartID.ascending(),
        type: "text",
        sessionID: run.sessionID,
        messageID: user.id,
        text: secret,
      })
      const bound = yield* goals.initial(run.sessionID, initial.intent ?? "unset", "test")
      if (!bound?.inputs?.includes(user.id)) throw new Error("Expected production input binding")
      const assistant = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: run.sessionID,
        parentID: user.id,
        agent: "test",
        mode: "test",
        ...model,
        path: { cwd: "synthetic", root: "synthetic" },
        time: { created: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const action = yield* sessions.updatePart({
        id: PartID.ascending(),
        type: "tool",
        sessionID: run.sessionID,
        messageID: assistant.id,
        tool: "read",
        callID: secret,
        state: { status: "pending", input: { secret }, raw: secret },
      })
      yield* runner.observe(run.sessionID)
      const page = yield* runner.tasks.eventsFor(agent.id)
      const expected: Codec.Trace = {
        version: 1,
        goalCreatedAt: initial.createdAt,
        turns: [
          {
            turnID: user.id,
            messages: [{ messageID: assistant.id, actions: [{ actionID: action.id, status: "pending" }] }],
          },
        ],
      }
      expect(page.events.at(-1)?.trace).toEqual(expected)
      expect(page.runs[0]?.trace).toEqual(expected)
      expect(JSON.stringify(page.events)).not.toContain(secret)
      const reopened = RayaTask.make({ database, storage })
      expect((yield* reopened.eventsFor(agent.id, 1)).events.at(-1)?.trace).toEqual(expected)
      yield* runner.observe(run.sessionID)
      expect((yield* runner.tasks.eventsFor(agent.id)).cursor).toBe(page.cursor)
      yield* sessions.updatePart({
        ...action,
        state: {
          status: "completed",
          input: { secret },
          output: secret,
          title: secret,
          metadata: { secret },
          time: { start: Date.now(), end: Date.now() },
        },
      })
      yield* sessions.updateMessage({ ...assistant, time: { ...assistant.time, completed: Date.now() } })
      const repeated = yield* sessions.updatePart({
        ...action,
        id: PartID.ascending(),
        state: { status: "error", input: { secret }, error: secret, time: { start: Date.now(), end: Date.now() } },
      })
      yield* bus.publish(KiloSessionEvent.TurnClose, {
        sessionID: run.sessionID,
        messageID: assistant.id,
        reason: "completed",
      })
      const latest = yield* pollWithTimeout(
        runner.tasks.eventsFor(agent.id).pipe(Effect.map((value) => (value.cursor > page.cursor ? value : undefined))),
        "Authoritative turn-close subscription did not persist the action identity",
      )
      yield* pollWithTimeout(
        Effect.sync(() => (scheduler.snapshot().active === 0 ? true : undefined)),
        "Original turn-close scheduler body did not finish",
      )
      expect(latest.cursor).toBe(page.cursor + 1)
      expect(latest.events.at(-1)?.trace?.turns[0]?.messages[0]?.actions[0]?.status).toBe("completed")
      expect(latest.events.at(-1)?.trace?.turns[0]?.messages[0]?.actions[1]).toEqual({
        actionID: repeated.id,
        status: "error",
      })
      expect(JSON.stringify(latest.events)).not.toContain(secret)
      const cold = replay(agent.id, page.cursor)
      expect(cold.page).toEqual({ ...latest, events: latest.events.filter((event) => event.sequence > page.cursor) })
      expect(JSON.stringify(cold)).not.toContain(secret)
      const rows = yield* sessions.messages({ sessionID: run.sessionID })
      expect(trace({ ...run, goalCreatedAt: undefined }, bound, rows)).toBeUndefined()
      expect(trace(run, { ...bound, createdAt: bound.createdAt + 1 }, rows)).toBeUndefined()
      expect(trace(run, { ...bound, inputs: [MessageID.make("msg_missing")] }, rows)).toBeUndefined()
      expect(trace(run, bound, [...rows, ...rows])).toBeUndefined()
      const altered = rows.map((row) => ({
        ...row,
        parts: row.parts.map((part) => ({ ...part, sessionID: SessionID.make("ses_foreign") })),
      }))
      expect(trace(run, bound, altered)).toBeUndefined()
      const overflow = rows.map((row) =>
        row.info.id === assistant.id
          ? {
              ...row,
              parts: Array.from({ length: 257 }, () => ({ ...action, id: PartID.ascending() })),
            }
          : row,
      )
      expect(trace(run, bound, overflow)).toBeUndefined()
      expect(trace(run, { ...bound, inputs: [user.id, user.id] }, rows)).toBeUndefined()
      const duplicate = { ...expected, turns: [...expected.turns, ...expected.turns] }
      expect(Schema.is(Codec.Trace)(duplicate)).toBe(false)
      expect(
        Schema.is(Codec.Trace)({
          ...expected,
          turns: [
            {
              ...expected.turns[0],
              messages: [
                {
                  messageID: assistant.id,
                  actions: Array.from({ length: 257 }, () => ({ actionID: PartID.ascending(), status: "pending" })),
                },
              ],
            },
          ],
        }),
      ).toBe(false)
      const current = yield* goals.get(run.sessionID)
      if (!current) throw new Error("Expected the original saved goal")
      const goal = ["raya", "goal", run.sessionID]
      yield* storage.replace(goal, { ...current, inputs: [user.id, user.id] })
      yield* runner.observe(run.sessionID)
      const unavailable = yield* runner.tasks.eventsFor(agent.id)
      expect(unavailable.runs[0]?.trace).toBeUndefined()
      expect(unavailable.events.at(-1)?.trace).toBeUndefined()
      yield* storage.replace(goal, current)
      yield* runner.observe(run.sessionID)
      const final = yield* runner.tasks.eventsFor(agent.id)
      expect(final.cursor).toBe(latest.cursor + 2)
      expect(final.runs[0]?.trace).toEqual(latest.runs[0]?.trace)
      const saved = yield* storage.read<RayaTask.History>(["raya", "agent-runs", agent.id])
      const key = ["raya", "agent-runs", agent.id]
      yield* storage.replace(key, {
        ...saved,
        events: saved.events.map((event, index) =>
          index === saved.events.length - 1 ? { ...event, trace: expected } : event,
        ),
      })
      expect(Exit.isFailure(yield* Effect.exit(reopened.eventsFor(agent.id)))).toBe(true)
      expect(replay(agent.id, final.cursor - 1)).toEqual({ refused: true })
      yield* storage.replace(key, saved)
      expect((yield* reopened.eventsFor(agent.id)).cursor).toBe(final.cursor)
      expect(replay(agent.id, final.cursor - 1).page).toEqual({
        ...final,
        events: final.events.filter((event) => event.sequence > final.cursor - 1),
      })
    }),
  90_000,
)
