import assert from "node:assert/strict"
import { join } from "node:path"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { RuntimeRegistry } from "@opencode-ai/core/kilocode/runtime-registry"
import { SessionID } from "../../../src/session/schema"

const root = process.env.RAYA_ASYNC_PROFILE
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
          if (mode !== "transport") return
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
import type { AppServices } from "../../../src/effect/app-runtime"
const { Server } = await import("../../../src/server/server")
const { HttpApiApp } = await import("../../../src/server/routes/instance/httpapi/server")
const { AppRuntime } = await import("../../../src/effect/app-runtime")
const { InstanceStore } = await import("../../../src/project/instance-store")
const { Session } = await import("../../../src/session/session")
const { scheduler, schedulerQuiesce } = await import("../../../src/kilocode/task/admission")
const { KiloSessions } = await import("../../../src/kilo-sessions/kilo-sessions")
const { SessionExport } = await import("../../../src/kilocode/session-export")
const { KiloShutdown } = await import("../../../src/kilocode/cli/shutdown")
const { InstanceRuntime } = await import("../../../src/project/instance-runtime")
const { serveShutdown } = await import("../../../src/kilocode/cli/serve-shutdown")
const { GlobalBus } = await import("../../../src/bus/global")
const diagnostics = { errors: 0 }
const diagnostic = (event: { payload?: { type?: string; properties?: { error?: { data?: { code?: string } } } } }) => {
  if (
    event.payload?.type === "session.error" &&
    event.payload.properties?.error?.data?.code === "session.prompt_async.failed"
  )
    diagnostics.errors++
}
GlobalBus.on("event", diagnostic)
const { EventEmitter } = await import("node:events")
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
const headers = { "x-kilo-directory": root, "content-type": "application/json" }
const request = (path: string, body?: object) =>
  fetch(new URL(path, listener.url), { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) })
const native = <A, E>(body: Effect.Effect<A, E, AppServices>) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.provide({ directory: root }, body)))
const stateful = { retired: false }
try {
  if (mode === "recovery") {
    const prior = await Bun.file(join(root, "receipt.json")).json()
    const response = await request(`/session/${prior.session}/message`)
    assert.equal(response.status, 200)
    const rows = await response.json()
    assert.deepEqual(
      rows.map((row: { info: { id: string } }) => row.info.id),
      prior.messages,
    )
    assert.equal(state.calls, 0)
    await listener.quiesce()
    await schedulerQuiesce()
    await Bun.write(
      join(root, "recovery.json"),
      JSON.stringify({ passed: true, natural: true, calls: 0, messages: prior.messages }),
    )
  } else {
    const created = await request("/session", { title: "Private async prompt" })
    assert.equal(created.status, 200)
    const session = await created.json()
    const payload = {
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      tools: { get_goal: true },
      parts: [{ type: "text", text: "Read get_goal only and answer briefly. No filesystem or external tools." }],
    }
    const response = await request(`/session/${session.id}/prompt_async`, payload)
    assert.equal(response.status, 204)
    await entered.promise
    const rows = await native(Session.Service.use((sessions) => sessions.messages({ sessionID: session.id })))
    assert.equal(
      rows
        .flatMap((row) => row.parts)
        .filter((part) => part.type === "tool" && part.tool === "get_goal" && part.state.status === "completed").length,
      1,
    )
    assert.ok(scheduler.snapshot().active > 0)
    if (mode === "stop") {
      const abort = await request(`/session/${session.id}/abort`, {})
      assert.equal(abort.status, 200)
      assert.equal(await abort.json(), true)
    }
    const requests = listener.quiesce()
    await requests
    const closed = schedulerQuiesce()
    const drain = serveShutdown({
      signals: new EventEmitter(),
      watchdog: () => {},
      admission: () => closed,
      tasks: [
        async () => {
          assert.equal(scheduler.snapshot().active, 0)
          await native(Database.Service.use((database) => database.db.get("SELECT 1").pipe(Effect.orDie)))
          stateful.retired = true
        },
      ],
    })
    const waiting = drain.wait.then(
      () => undefined,
      (err: unknown) => err,
    )
    const stopped = drain.run().then(
      () => undefined,
      (err: unknown) => err,
    )
    assert.equal(stateful.retired, false)
    await native(Database.Service.use((database) => database.db.get("SELECT 1").pipe(Effect.orDie)))
    assert.equal((await request(`/session/${session.id}/prompt_async`, payload)).status, 503)
    const cached = await Server.Default().app.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    })
    assert.equal(cached.status, 503)
    assert.deepEqual(await cached.json(), { _tag: "ServiceUnavailable" })
    const unchanged = await native(Session.Service.use((sessions) => sessions.messages({ sessionID: session.id })))
    assert.deepEqual(
      unchanged.map((row) => row.info.id),
      rows.map((row) => row.info.id),
    )
    assert.equal(state.calls, 2)
    if (mode === "scope") await listener.stop(true)
    release.resolve()
    const outcome = await stopped
    await waiting
    if (mode === "scope") assert.ok(outcome instanceof AggregateError)
    if (mode !== "scope") assert.equal(outcome, undefined)
    if (mode === "stop") assert.equal(state.cancelled, 1)
    assert.equal(diagnostics.errors, 0)
    assert.equal(stateful.retired, true)
    assert.equal(scheduler.snapshot().active, 0)
    const after = await native(Session.Service.use((sessions) => sessions.messages({ sessionID: session.id })))
    const replies = after.filter((row) =>
      row.parts.some((part) => part.type === "text" && part.text.includes("SCHEDULER_TRANSPORT_REPLY")),
    )
    assert.equal(replies.length, mode === "transport" ? 1 : 0)
    assert.equal(state.calls, 2)
    assert.equal(state.unexpected, 0)
    await Bun.write(
      join(root, "receipt.json"),
      JSON.stringify({
        passed: true,
        mode,
        session: session.id,
        messages: after.map((row) => row.info.id),
        active: 0,
        calls: state.calls,
        natural: true,
        held: true,
        retired: stateful.retired,
        failed: outcome instanceof AggregateError,
        ordinaryStop: mode === "stop",
        diagnosticErrors: diagnostics.errors,
        transportCancelled: state.cancelled,
        portableCaptureAuthorized: false,
      }),
    )
  }
} finally {
  release.resolve()
  await listener.stop(true)
  if (HttpApiApp.webHandler.loaded()) await HttpApiApp.webHandler().dispose()
  await KiloSessions.drainIngestForShutdown()
  await SessionExport.shutdown()
  await KiloShutdown.run()
  await InstanceRuntime.disposeAllInstances()
  await RuntimeRegistry.drain()
  GlobalBus.off("event", diagnostic)
  await server.stop(true)
}
