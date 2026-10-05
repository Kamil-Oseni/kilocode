import assert from "node:assert/strict"
import { join } from "node:path"
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"

const root = process.env.RAYA_GOAL_PROFILE
if (!root) throw new Error("Missing private transport profile")
const mode = process.argv[2]
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const caught = Promise.withResolvers<void>()
const resume = Promise.withResolvers<void>()
const state = { calls: 0, titles: 0, unexpected: 0, cancelled: 0 }
const line = (delta: object, finish?: string) =>
  `data: ${JSON.stringify({ id: "local-fixture", object: "chat.completion.chunk", choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const body = await req.text()
    if (body.includes("Generate a title for this conversation")) {
      state.titles++
      return new Response(line({ content: "Private transport" }) + line({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    }
    state.calls++
    if (state.calls === 1)
      return new Response(
        line({
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call_metadata", type: "function", function: { name: "get_goal", arguments: "{}" } },
          ],
        }) +
          line({}, "tool_calls") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    if (state.calls !== 2) {
      state.unexpected++
      return new Response("Unexpected model request", { status: 503 })
    }
    assert.ok(body.includes("call_metadata"), "Second real provider request must contain the native tool result")
    req.signal.addEventListener(
      "abort",
      () => {
        state.cancelled = 1
      },
      { once: true },
    )
    return new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(line({ role: "assistant" })))
          entered.resolve()
          await release.promise
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ error: { message: "Held local fixture failed", type: "server_error", code: "fixture" } })}\n\n` +
                "data: [DONE]\n\n",
            ),
          )
          controller.close()
        },
        cancel() {
          state.cancelled = 1
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
process.env.KILO_CONFIG_CONTENT = JSON.stringify({
  raya_routing: { goal_continuation: false },
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
      models: {
        "test-model": { name: "Synthetic transport", tool_call: true, limit: { context: 32768, output: 1024 } },
      },
    },
  },
})
process.env.RAYA_CONFIG_CONTENT = process.env.KILO_CONFIG_CONTENT
const { RayaGoalContinuation } = await import("../../../src/kilocode/goal/continuation")
const { Bus } = await import("../../../src/bus")
const { KiloSession } = await import("../../../src/kilocode/session")
const { ChiefNoteEvent } = await import("../../../src/kilocode/chief/event")
const { ExecutionIdle } = await import("../../../src/kilocode/task/execution-event")
const { AppLayer } = await import("../../../src/effect/app-runtime")
const { memoMap } = await import("@opencode-ai/core/effect/memo-map")
const runtime = ManagedRuntime.make(Layer.mergeAll(AppLayer, Bus.defaultLayer), { memoMap })
const { InstanceStore } = await import("../../../src/project/instance-store")
const { Session } = await import("../../../src/session/session")
const { Storage } = await import("../../../src/storage/storage")
const { RayaTask } = await import("../../../src/kilocode/task")
const { RayaTaskRunner } = await import("../../../src/kilocode/task/runner")
const { RayaTaskInbox } = await import("../../../src/kilocode/task/inbox")
const { RayaTaskExecution } = await import("../../../src/kilocode/task/execution")
const { scheduler, schedulerQuiesce } = await import("../../../src/kilocode/task/admission")
const { RayaGoal } = await import("../../../src/kilocode/goal")
const { KiloSessions } = await import("../../../src/kilo-sessions/kilo-sessions")
const { SessionExport } = await import("../../../src/kilocode/session-export")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
try {
  await runtime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: root },
        Effect.gen(function* () {
          const database = yield* Database.Service
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const runner = RayaTaskRunner.make({ database, storage, sessions })
          const bus = yield* Bus.Service
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          yield* Scope.provide(scope)(
            RayaGoalContinuation.subscribe({
              database,
              storage,
              sessions,
              bus,
              directory: root,
              enabled: () =>
                Effect.promise(() => {
                  caught.resolve()
                  return resume.promise
                }).pipe(Effect.as(true)),
            }),
          )
          const agent = yield* runner.tasks.create({
            name: "Transport gate",
            objective: "Answer using safe metadata only",
            access: "brief",
            tools: ["get_goal"],
            enabled: true,
            schedule: { kind: "manual" },
            model: { providerID: "test", id: "test-model" },
          })
          const run = yield* runner.ask(
            agent.id,
            "Inspect get_goal and briefly answer this question. No filesystem or external tools.",
          )
          yield* Effect.promise(() => entered.promise)
          const rows = yield* sessions.messages({ sessionID: run.sessionID })
          assert.equal(
            rows
              .flatMap((row) => row.parts)
              .filter((part) => part.type === "tool" && part.tool === "get_goal" && part.state.status === "completed")
              .length,
            1,
          )
          const execution = RayaTaskExecution.make(storage)
          const before = yield* execution.receipt(run)
          assert.ok(before)
          // Exercise persisted identity refusals while the actual transport is held.
          yield* Effect.gen(function* () {
            for (const wrong of [
              { ...run, id: "wrong" },
              { ...run, scheduleVersion: (run.scheduleVersion ?? 1) + 1 },
              { ...run, trigger: { kind: "event" as const, source: "wrong", receivedAt: 1 } },
            ]) {
              assert.ok(
                Exit.isFailure(
                  yield* RayaGoalContinuation.accepted(
                    { database, storage, sessions, sessionID: run.sessionID },
                    wrong,
                  ).pipe(Effect.exit),
                ),
              )
            }
            // Historical metadata without a trigger is refused explicitly, without migrating it or replaying transport.
            const session = yield* sessions.get(run.sessionID)
            const legacy: Record<string, unknown> = {
              ...(session.metadata?.rayaRoutine as Record<string, unknown>),
              version: 1,
            }
            delete legacy.trigger
            yield* sessions.setMetadata({
              sessionID: run.sessionID,
              metadata: { ...session.metadata, rayaRoutine: legacy },
            })
            const refused = yield* RayaGoalContinuation.accepted(
              { database, storage, sessions, sessionID: run.sessionID },
              run,
            ).pipe(Effect.exit)
            assert.ok(Exit.isFailure(refused))
            if (Exit.isFailure(refused))
              assert.ok(
                refused.cause.reasons.some(
                  (reason) => reason._tag === "Fail" && reason.error instanceof RayaTask.GuardError,
                ),
              )
            assert.equal((yield* execution.receipt(run))?.token, before.token)
            yield* sessions.setMetadata({ sessionID: run.sessionID, metadata: session.metadata ?? {} })
            assert.equal(state.calls, 2)
          })
          release.resolve()
          yield* Effect.promise(() => caught.promise)
          const goals = RayaGoal.make({ database, storage, sessions })
          const saved = yield* goals.get(run.sessionID)
          assert.ok(saved?.dispatch)
          const closed = schedulerQuiesce()
          const count = scheduler.snapshot().active
          yield* bus.publish(KiloSession.Event.TurnClose, { sessionID: run.sessionID, reason: "completed" })
          yield* bus.publish(ChiefNoteEvent, {
            version: 1,
            sessionID: run.sessionID,
            goalCreatedAt: saved.createdAt,
            requestID: "late",
            revision: "late",
            noteID: "late",
          })
          yield* bus.publish(ExecutionIdle, {
            version: 1,
            sessionID: run.sessionID,
            runID: run.id,
            agentID: run.agentID,
            execution: before.token,
          })
          assert.equal(scheduler.snapshot().active, count)
          assert.ok(
            Exit.isFailure(
              yield* RayaGoalContinuation.resume({ database, storage, sessions, sessionID: run.sessionID }).pipe(
                Effect.exit,
              ),
            ),
          )
          assert.ok(scheduler.snapshot().active > 0)
          if (mode === "cancelled") yield* Scope.close(scope, Exit.void)
          resume.resolve()
          assert.ok(Exit.isFailure(yield* runner.fire(agent.id).pipe(Effect.exit)))
          assert.ok(Exit.isFailure(yield* runner.ask(agent.id, "Forbidden late work").pipe(Effect.exit)))
          yield* database.db.get("SELECT 1").pipe(Effect.orDie)
          release.resolve()
          const result = yield* Effect.promise(() =>
            closed.then(
              () => undefined,
              (err: unknown) => err,
            ),
          )
          const history = yield* runner.tasks.runsFor(agent.id)
          const goal = yield* RayaGoal.make({ database, storage, sessions }).get(run.sessionID)
          yield* Effect.promise(() => Bun.write(join(root, "observed.json"), JSON.stringify({ history, goal })))
          assert.equal(history.length, 1)
          assert.equal(history[0]?.id, run.id)
          assert.equal(history[0]?.status, "running")
          assert.equal((yield* execution.receipt(run))?.token, before.token)
          assert.equal((yield* execution.receipt(run))?.state, "idle")
          assert.equal(goal?.dispatch?.id, saved.dispatch.id)
          assert.equal(goal?.dispatch?.phase, "finished")
          assert.equal(goal?.dispatch?.outcome, "error")
          assert.equal(goal?.usage.retries ?? 0, saved.usage.retries ?? 0)
          const page = yield* RayaTaskInbox.make(database).page(agent.id)
          assert.equal(page.messages.filter((row) => row.body.includes("SCHEDULER_TRANSPORT_REPLY")).length, 0)
          const after = yield* sessions.messages({ sessionID: run.sessionID })
          assert.equal(
            after.filter(
              (row) =>
                row.info.role === "assistant" &&
                row.parts.some((part) => part.type === "text" && part.text.includes("SCHEDULER_TRANSPORT_REPLY")),
            ).length,
            0,
          )
          assert.equal(scheduler.snapshot().active, 0)
          assert.equal(state.calls, 2)
          assert.equal(state.unexpected, 0)
          if (mode === "cancelled") assert.ok(result instanceof AggregateError)
          yield* database.db.get("SELECT 1").pipe(Effect.orDie)
          yield* Effect.promise(() =>
            Bun.write(
              join(root, "receipt.json"),
              JSON.stringify({
                passed: true,
                mode,
                active: 0,
                run: run.id,
                session: run.sessionID,
                calls: state.calls,
                tool: "get_goal",
                terminal: history[0]?.status,
                uncertain: true,
                failure: result instanceof AggregateError,
                cancelled: state.cancelled,
                callbackCancelled: mode === "cancelled",
                followonRefused: true,
                exactDispatch: goal?.dispatch?.id,
                natural: true,
                processLocal: true,
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
  resume.resolve()
  await KiloSessions.drainIngestForShutdown()
  await SessionExport.shutdown()
  await KiloShutdown.run()
  await InstanceRuntime.disposeAllInstances()
  await runtime.dispose()
  await RuntimeRegistry.drain()
  await server.stop(true)
}
