import assert from "node:assert/strict"
import { join } from "node:path"
import { Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"

const root = process.env.RAYA_TIMER_PROFILE
if (!root) throw new Error("Missing isolated timer profile")
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const published = Promise.withResolvers<void>()
const state = { calls: 0, held: false, reads: 0 }
const line = (delta: object, finish?: string) =>
  `data: ${JSON.stringify({ id: "timer-fixture", object: "chat.completion.chunk", choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    state.calls++
    return new Response(
      line({ role: "assistant", content: "TIMER_IDLE_REPLY" }) + line({}, "stop") + "data: [DONE]\n\n",
      {
        headers: { "content-type": "text/event-stream" },
      },
    )
  },
})
process.env.KILO_CONFIG_CONTENT = JSON.stringify({
  raya_routing: { goal_continuation: true },
  formatter: false,
  lsp: false,
  model: "test/test-model",
  small_model: "test/test-model",
  enabled_providers: ["test"],
  permission: "deny",
  provider: {
    test: {
      name: "Private loopback",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      options: { apiKey: "private-synthetic", baseURL: `http://127.0.0.1:${server.port}/v1` },
      models: { "test-model": { name: "Synthetic timer", tool_call: true, limit: { context: 32768, output: 1024 } } },
    },
  },
})
process.env.RAYA_CONFIG_CONTENT = process.env.KILO_CONFIG_CONTENT
const { Storage } = await import("../../../src/storage/storage")
const { Session } = await import("../../../src/session/session")
const { InstanceStore } = await import("../../../src/project/instance-store")
const { Bus } = await import("../../../src/bus")
const { RayaGoal } = await import("../../../src/kilocode/goal")
const { RayaTaskRunner } = await import("../../../src/kilocode/task/runner")
const { RayaTaskExecution } = await import("../../../src/kilocode/task/execution")
const { RayaTaskQueue } = await import("../../../src/kilocode/task/queue")
const { record } = await import("../../../src/kilocode/task/continuation")
const { schedulerQuiesce } = await import("../../../src/kilocode/task/admission")
const { KiloSessions } = await import("../../../src/kilo-sessions/kilo-sessions")
const { SessionExport } = await import("../../../src/kilocode/session-export")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
const gated = (storage: import("../../../src/storage/storage").Interface) =>
  Storage.Service.of({
    ...storage,
    // Hold only the actual final durable publication; all reads/writes use production Storage.
    replace: (key, value) =>
      Effect.gen(function* () {
        const held =
          key[0] === "raya" && key[1] === "goal" && Schema.is(RayaGoal.State)(value) && value.status === "blocked"
        if (held) {
          state.held = true
          entered.resolve()
          yield* Effect.promise(() => release.promise)
        }
        yield* storage.replace(key, value)
        if (held) published.resolve()
      }),
    read: <T>(key: string[]) =>
      storage.read<T>(key).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (state.held && key[0] === "raya" && key[1] === "goal") state.reads++
          }),
        ),
      ),
  })
const { AppLayer } = await import("../../../src/effect/app-runtime")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const runtime = ManagedRuntime.make(Layer.mergeAll(AppLayer, Bus.defaultLayer), { memoMap })
try {
  await runtime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: root },
        Effect.gen(function* () {
          const database = yield* Database.Service
          const storage = yield* Storage.Service
          Object.assign(storage, gated({ ...storage }))
          const sessions = yield* Session.Service

          const runner = RayaTaskRunner.make({ database, storage, sessions })
          const goals = RayaGoal.make({ database, storage, sessions })
          const execution = RayaTaskExecution.make(storage)
          const queue = RayaTaskQueue.make(database)
          const agent = yield* runner.tasks.create({
            name: "Delayed timer terminal publication",
            objective: "Reply TIMER_IDLE_REPLY without tools or changing files.",
            access: "brief",
            tools: [],
            enabled: true,
            schedule: { kind: "once", at: Date.now() - 1 },
            model: { providerID: "test", id: "test-model" },
          })
          yield* runner.tick(Date.now())
          yield* Effect.promise(() => entered.promise)
          const history = yield* runner.tasks.runsFor(agent.id)
          assert.equal(history.length, 1)
          const run = history[0]
          assert.equal(run.trigger?.kind, "timer")
          assert.equal((yield* goals.get(run.sessionID))?.status, "active")
          assert.equal((yield* execution.receipt(run))?.state, "idle")
          yield* runner.settle(run.sessionID)
          assert.equal((yield* runner.tasks.runsFor(agent.id))[0]?.status, "running")
          assert.ok(state.reads > 0)
          release.resolve()
          yield* Effect.promise(() => published.promise)
          const goal = yield* goals.get(run.sessionID)
          assert.equal(goal?.status, "blocked")
          assert.equal(goal?.completion, undefined)
          assert.equal(goal?.usage.retries, 3)
          assert.equal(state.calls, 3)
          assert.ok(goal)
          for (const status of ["active", "paused"] as const) {
            yield* storage.replace(["raya", "goal", run.sessionID], { ...goal, status })
            yield* runner.tick(Date.now())
            assert.equal((yield* runner.tasks.runsFor(agent.id))[0]?.status, "running")
            assert.equal(state.calls, 3)
          }
          yield* storage.replace(["raya", "goal", run.sessionID], {
            ...goal,
            replyRecovery: {
              version: 1,
              dispatchID: goal.dispatch!.id,
              messageID: goal.dispatch!.messageID!,
              oldIntent: goal.intent!,
              intent: goal.intent!,
              source: "private-fixture",
              outcome: "unknown",
              execution: "a".repeat(64),
              at: Date.now(),
            },
          })
          yield* runner.tick(Date.now())
          assert.equal((yield* runner.tasks.runsFor(agent.id))[0]?.status, "running")
          yield* storage.replace(["raya", "goal", run.sessionID], goal)
          const busy = Promise.withResolvers<void>()
          const idle = Promise.withResolvers<void>()
          const fiber = yield* execution
            .enter(
              run,
              Effect.gen(function* () {
                busy.resolve()
                yield* Effect.promise(() => idle.promise)
              }),
            )
            .pipe(Effect.forkScoped)
          yield* Effect.promise(() => busy.promise)
          assert.equal((yield* execution.receipt(run))?.state, "active")
          yield* runner.tick(Date.now())
          assert.equal((yield* runner.tasks.runsFor(agent.id))[0]?.status, "running")
          idle.resolve()
          yield* Fiber.join(fiber)
          const session = yield* sessions.get(run.sessionID)
          const identity = yield* Schema.decodeUnknownEffect(record)(session.metadata?.rayaRoutine)
          for (const wrong of [
            { ...identity, runID: "wrong" },
            { ...identity, scheduleVersion: 999 },
            { ...identity, trigger: { kind: "manual" } },
          ]) {
            yield* sessions.setMetadata({
              sessionID: run.sessionID,
              metadata: { ...session.metadata, rayaRoutine: wrong },
            })
            yield* runner.tick(Date.now())
            assert.equal((yield* runner.tasks.runsFor(agent.id))[0]?.status, "running")
            assert.equal(state.calls, 3)
          }
          yield* sessions.setMetadata({ sessionID: run.sessionID, metadata: session.metadata ?? {} })
          yield* runner.tick(Date.now())
          const done = (yield* runner.tasks.runsFor(agent.id))[0]
          assert.equal(done.id, run.id)
          assert.equal(done.status, "blocked")
          assert.equal(done.blockedReason, goal?.blockedReason)
          assert.equal(yield* execution.receipt(run), undefined)
          assert.ok(run.trigger?.kind === "timer")
          assert.equal((yield* queue.get(run.trigger.id))?.state, "complete")
          const revision = done.revision
          yield* runner.tick(Date.now())
          const again = yield* runner.tasks.runsFor(agent.id)
          assert.equal(again.length, 1)
          assert.equal(again[0]?.revision, revision)
          assert.equal(state.calls, 3)
          yield* Effect.promise(() =>
            Bun.write(
              join(root, "receipt.json"),
              JSON.stringify({
                passed: true,
                calls: state.calls,
                reads: state.reads,
                status: done.status,
                run: run.id,
                natural: true,
                portableCaptureAuthorized: false,
              }),
            ),
          )
        }),
      ),
    ).pipe(Effect.scoped),
  )
} finally {
  release.resolve()
  await schedulerQuiesce()
  await KiloSessions.drainIngestForShutdown()
  await SessionExport.shutdown()
  await KiloShutdown.run()
  await InstanceRuntime.disposeAllInstances()
  await runtime.dispose()
  await RuntimeRegistry.drain()
  await server.stop(true)
}
