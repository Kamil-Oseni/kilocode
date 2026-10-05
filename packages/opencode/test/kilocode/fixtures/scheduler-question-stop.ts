import assert from "node:assert/strict"
import { join } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { ConfigPublication } from "../../../src/kilocode/config/publication"

const root = process.env.RAYA_SCHEDULER_PROFILE
if (!root) throw new Error("Missing disposable profile")
const asked = Promise.withResolvers<void>()
const state = { calls: 0 }
const line = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "private-question", object: "chat.completion.chunk", choices: [{ delta, finish_reason: finish }] })}\n\n`
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = await req.text()
    if (body.includes("Generate a title for this conversation"))
      return new Response(line({ content: "Private question" }) + line({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    state.calls++
    assert.equal(state.calls, 1)
    return new Response(
      line({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_question",
            type: "function",
            function: {
              name: "question",
              arguments: JSON.stringify({
                questions: [
                  {
                    question: "Synthetic pending question?",
                    header: "Fixture",
                    options: [{ label: "Continue", description: "Synthetic option" }],
                  },
                ],
              }),
            },
          },
        ],
      }) +
        line({}, "tool_calls") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const fetch = globalThis.fetch
const origin = new URL(server.url).origin
globalThis.fetch = Object.assign(
  (input: string | URL | Request, opts?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin !== origin)
      return Promise.reject(new Error("Synthetic fixture refuses non-loopback provider metadata"))
    return fetch(input, opts)
  },
  { preconnect: fetch.preconnect },
)
process.env.KILO_CONFIG_CONTENT = JSON.stringify({
  raya_routing: { goal_continuation: true },
  snapshot: false,
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

await ConfigPublication.using(root, async () => {
  const { AppRuntime } = await import("../../../src/effect/app-runtime")
  const { InstanceStore } = await import("../../../src/project/instance-store")
  const { Database } = await import("@opencode-ai/core/database/database")
  const { Storage } = await import("../../../src/storage/storage")
  const { Session } = await import("../../../src/session/session")
  const { Question } = await import("../../../src/question")
  const { EventV2Bridge } = await import("../../../src/event-v2-bridge")
  const { RayaTaskRunner } = await import("../../../src/kilocode/task/runner")
  const { RayaGoal } = await import("../../../src/kilocode/goal")
  const { scheduler } = await import("../../../src/kilocode/task/admission")
  const { SessionRetirement } = await import("../../../src/kilocode/session/retirement")
  const { stop } = await import("../../../src/kilocode/cli/serve-shutdown")
  const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
  const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
  const { RuntimeRegistry } = await import("@opencode-ai/core/kilocode/runtime-registry")
  const failures: unknown[] = []
  try {
    await AppRuntime.runPromise(
      InstanceStore.Service.use((store) =>
        store.provide(
          { directory: root },
          Effect.gen(function* () {
            const database = yield* Database.Service
            const storage = yield* Storage.Service
            const sessions = yield* Session.Service
            const question = yield* Question.Service
            const events = yield* EventV2Bridge.Service
            const off = yield* events.listen((event) =>
              Effect.sync(() => {
                if (event.type === Question.Event.Asked.type) asked.resolve()
              }),
            )
            const runner = RayaTaskRunner.make({ database, storage, sessions })
            const at = Date.now() - 1
            const agent = yield* runner.tasks.create({
              name: "Question stop",
              objective: "Ask the user one question before doing any work.",
              access: "brief",
              tools: ["question"],
              enabled: true,
              schedule: { kind: "once", at },
              model: { providerID: "test", id: "test-model" },
            })
            yield* runner.tick(at + 1)
            yield* Effect.promise(async () => {
              const timer = setTimeout(() => asked.reject(new Error("Question startup observation expired")), 30_000)
              try {
                await asked.promise
              } finally {
                clearTimeout(timer)
              }
            })
            assert.equal((yield* question.list()).length, 1)
            assert.ok(scheduler.snapshot().active > 0)
            yield* Effect.promise(stop)
            assert.equal((yield* question.list()).length, 0)
            assert.deepEqual(scheduler.snapshot(), {
              closed: true,
              active: 0,
              failures: 0,
              processLocal: true,
              portableCaptureAuthorized: false,
            })
            const runs = yield* runner.tasks.runsFor(agent.id)
            assert.equal(runs.length, 1)
            const run = runs[0]!
            const goal = yield* RayaGoal.make({ database, storage, sessions }).get(run.sessionID)
            assert.notEqual(run.status, "complete")
            assert.notEqual(goal?.status, "complete")
            assert.notEqual(goal?.dispatch?.outcome, "completed")
            yield* database.db.get("SELECT 1").pipe(Effect.orDie)
            yield* off
            yield* Effect.promise(() =>
              Bun.write(
                join(root, "receipt.json"),
                JSON.stringify({
                  passed: true,
                  calls: state.calls,
                  scheduler: scheduler.snapshot(),
                  session: run.sessionID,
                  run: run.id,
                  status: run.status,
                  outcome: goal?.dispatch?.outcome,
                  questionClosed: true,
                }),
              ),
            )
          }),
        ),
      ),
    )
  } catch (err) {
    failures.push(err)
  }
  {
    const inner = Effect.runPromiseExit(SessionRetirement.stop)
    const outer = Effect.runPromiseExit(scheduler.stop)
    const results = [await inner, await outer]
    failures.push(...results.flatMap((exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : [])))
    const cleanup = await Promise.allSettled([KiloShutdown.run(), InstanceRuntime.disposeAllInstances()])
    await RuntimeRegistry.drain()
    await server.stop(true)
    failures.push(...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])))
    if (failures.length) throw new AggregateError(failures, "Original scheduled question retirement failed")
  }
})
