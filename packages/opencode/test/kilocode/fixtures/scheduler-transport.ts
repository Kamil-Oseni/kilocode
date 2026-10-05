import assert from "node:assert/strict"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { SessionID } from "../../../src/session/schema"

const root = process.env.RAYA_SCHEDULER_PROFILE
if (!root) throw new Error("Missing private transport profile")
const mode = process.argv[2]
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
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
          if (mode === "interrupted") return
          controller.enqueue(
            new TextEncoder().encode(
              line({ content: "SCHEDULER_TRANSPORT_REPLY" }) + line({}, "stop") + "data: [DONE]\n\n",
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
const { AppRuntime } = await import("../../../src/effect/app-runtime")
const { InstanceStore } = await import("../../../src/project/instance-store")
const { Session } = await import("../../../src/session/session")
const { Storage } = await import("../../../src/storage/storage")
const { RayaTaskRunner } = await import("../../../src/kilocode/task/runner")
const { RayaTaskInbox } = await import("../../../src/kilocode/task/inbox")
const { RayaTaskExecution } = await import("../../../src/kilocode/task/execution")
const { scheduler, schedulerQuiesce } = await import("../../../src/kilocode/task/admission")
const { RayaGoal } = await import("../../../src/kilocode/goal")
const { SessionPrompt } = await import("../../../src/session/prompt")
const { KiloSessions } = await import("../../../src/kilo-sessions/kilo-sessions")
const { SessionExport } = await import("../../../src/kilocode/session-export")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
try {
  await AppRuntime.runPromise(
    InstanceStore.Service.use((store) =>
      store.provide(
        { directory: root },
        Effect.gen(function* () {
          const database = yield* Database.Service
          const storage = yield* Storage.Service
          const sessions = yield* Session.Service
          const runner = RayaTaskRunner.make({ database, storage, sessions })
          if (mode === "recovery") {
            const prior = yield* Effect.promise(() => Bun.file(join(root, "receipt.json")).json())
            assert.equal(prior.mode, "interrupted")
            const sid = SessionID.make(prior.session)
            const goals = RayaGoal.make({ database, storage, sessions })
            const before = yield* goals.get(sid)
            assert.ok(before?.dispatch)
            assert.notEqual(before.dispatch.outcome, "completed")
            yield* runner.revive()
            const after = yield* goals.get(sid)
            assert.equal(after?.dispatch?.id, before?.dispatch?.id)
            assert.equal(after?.dispatch?.messageID, before?.dispatch?.messageID)
            assert.notEqual(after?.dispatch?.outcome, "completed")
            assert.notEqual(after?.status, "complete")
            const tasks = yield* runner.tasks.list()
            const history = yield* runner.tasks.runsFor(tasks[0]!.id)
            assert.equal(history.length, 1)
            assert.equal(history[0]?.id, prior.run)
            assert.notEqual(history[0]?.status, "complete")
            assert.equal(state.calls, 0)
            yield* Effect.promise(() => schedulerQuiesce())
            yield* Effect.promise(() =>
              Bun.write(
                join(root, "recovery.json"),
                JSON.stringify({
                  passed: true,
                  run: prior.run,
                  session: sid,
                  calls: state.calls,
                  dispatch: after?.dispatch,
                  natural: true,
                }),
              ),
            )
            return
          }
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
          const closed = schedulerQuiesce()
          assert.ok(scheduler.snapshot().active > 0)
          assert.ok(Exit.isFailure(yield* runner.fire(agent.id).pipe(Effect.exit)))
          assert.ok(Exit.isFailure(yield* runner.ask(agent.id, "Forbidden late work").pipe(Effect.exit)))
          yield* database.db.get("SELECT 1").pipe(Effect.orDie)
          if (mode === "interrupted") yield* SessionPrompt.Service.use((prompt) => prompt.cancel(run.sessionID))
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
          assert.equal(history[0]?.status === "complete", mode !== "interrupted")
          const page = yield* RayaTaskInbox.make(database).page(agent.id)
          assert.equal(
            page.messages.filter((row) => row.body.includes("SCHEDULER_TRANSPORT_REPLY")).length,
            mode === "interrupted" ? 0 : 1,
          )
          const after = yield* sessions.messages({ sessionID: run.sessionID })
          assert.equal(
            after.filter(
              (row) =>
                row.info.role === "assistant" &&
                row.parts.some((part) => part.type === "text" && part.text.includes("SCHEDULER_TRANSPORT_REPLY")),
            ).length,
            mode === "interrupted" ? 0 : 1,
          )
          assert.equal(scheduler.snapshot().active, 0)
          assert.equal(state.calls, 2)
          assert.equal(state.unexpected, 0)
          if (mode === "interrupted") {
            assert.equal(state.cancelled, 1)
            assert.ok(result instanceof AggregateError)
            assert.ok(goal?.dispatch)
            assert.notEqual(goal.dispatch.outcome, "completed")
            assert.notEqual(goal?.status, "complete")
            assert.equal((yield* execution.receipt(run))?.token, before.token)
            assert.equal((yield* execution.receipt(run))?.state, "active")
            assert.ok(Exit.isFailure(yield* runner.revive().pipe(Effect.exit)))
          }
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
                uncertain: mode === "interrupted",
                failure: result instanceof AggregateError,
                cancelled: state.cancelled,
                processLocal: true,
                portableCaptureAuthorized: false,
              }),
            ),
          )
        }),
      ),
    ),
  )
} finally {
  release.resolve()
  await KiloSessions.drainIngestForShutdown()
  await SessionExport.shutdown()
  await KiloShutdown.run()
  await InstanceRuntime.disposeAllInstances()
  await RuntimeRegistry.drain()
  await server.stop(true)
}
