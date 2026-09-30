import { afterAll, expect } from "bun:test"
import { Effect, Fiber, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpServer } from "effect/unstable/http"
import { request as connect } from "node:http"
import { status } from "@/kilocode/provider/local-scheduler"
import { disposeAllInstances, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { httpApiLayer, requestInDirectory } from "../../server/httpapi-layer"

type Gate = { opened: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }

function gate(): Gate {
  const value = { opened: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
  waiting.push(value)
  gates.add(value)
  return value
}
const waiting: Gate[] = []
const gates = new Set<Gate>()
const requests: string[] = []
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await Schema.decodeUnknownPromise(
      Schema.Struct({ model: Schema.String, stream: Schema.optional(Schema.Boolean) }),
    )(await request.json())
    requests.push(body.model)
    if (!body.stream)
      return Response.json({
        id: "sdk-fixture",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Improved local draft" } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })
    const chunk = {
      id: "native-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta: { content: "share-local-inference" }, finish_reason: null }],
    }
    const encoder = new TextEncoder()
    const held = waiting.shift()
    if (!held) throw new Error("Native fixture request has no owned gate")
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          held.opened.resolve()
          await held.release.promise
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
            ),
          )
          controller.close()
          gates.delete(held)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
const entry = { name: "Fixture", limit: { context: 8192, output: 1024 } }
const config = {
  formatter: false as const,
  lsp: false as const,
  enabled_providers: ["deepseek-local", "qwen-local"],
  provider: {
    "deepseek-local": {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${server.url}v1`, apiKey: "private-fixture", localInference: true },
      models: { "deepseek-test": entry },
    },
    "qwen-local": {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${server.url}v1`, localInference: true },
      models: { "main-9b": entry },
    },
  },
}
const it = testEffect(httpApiLayer)

afterAll(async () => {
  for (const held of gates) held.release.resolve()
  await server.stop(true)
  await disposeAllInstances()
})

it.instance(
  "native branch inference and SDK enhancement share admission until streaming body completion",
  () => {
    const held = gate()
    requests.length = 0
    return Effect.gen(function* () {
      const instance = yield* TestInstance
      const created = yield* requestInDirectory("/session", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Local admission fixture" }),
      })
      expect(created.status).toBe(200)
      const session = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(yield* created.json)
      const branch = yield* requestInDirectory(`/session/${session.id}/branch-name`, instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Implement shared local inference admission",
          providerID: "deepseek-local",
          modelID: "deepseek-test",
        }),
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => held.opened.promise)
      const helper = yield* requestInDirectory("/enhance-prompt", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Improve this draft", model: { providerID: "qwen-local", modelID: "main-9b" } }),
      }).pipe(Effect.forkChild)
      yield* Effect.sync(status).pipe(
        Effect.repeat({ until: (state) => state.queued === 1, schedule: Schedule.spaced(10) }),
        Effect.timeout(10_000),
      )
      expect(requests).toEqual(["deepseek-test"])
      held.release.resolve()
      const named = yield* Fiber.join(branch)
      const enhanced = yield* Fiber.join(helper)
      expect(named.status).toBe(200)
      expect(yield* named.json).toEqual({ branch: "share-local-inference" })
      expect(enhanced.status).toBe(200)
      expect(yield* enhanced.json).toEqual({ text: "Improved local draft" })
      expect(requests).toEqual(["deepseek-test", "main-9b"])
    }).pipe(Effect.ensuring(Effect.sync(() => held.release.resolve())))
  },
  { config },
  45_000,
)

function cancellation(node: boolean | "process") {
  return () => {
    const held = gate()
    requests.length = 0
    const started = Date.now()
    const phases: { step: string; ms: number }[] = []
    const mark = (step: string) => phases.push({ step, ms: Date.now() - started })
    return Effect.gen(function* () {
      const instance = yield* TestInstance
      const created = yield* requestInDirectory("/session", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Queued enhancement cancellation fixture" }),
      })
      expect(created.status).toBe(200)
      const session = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(yield* created.json)
      // Resolve the helper's separate runtime before holding the naming request's unchanged ten-second deadline.
      const prepared = yield* requestInDirectory("/enhance-prompt", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Prepare this helper", model: { providerID: "qwen-local", modelID: "main-9b" } }),
      })
      expect(prepared.status).toBe(200)
      expect(yield* prepared.json).toEqual({ text: "Improved local draft" })
      expect(requests).toEqual(["main-9b"])
      mark("helper-prepared")
      mark("branch-request")
      const branch = yield* requestInDirectory(`/session/${session.id}/branch-name`, instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Hold native inference while cancelling a queued helper",
          providerID: "deepseek-local",
          modelID: "deepseek-test",
        }),
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => held.opened.promise)
      mark("native-opened")
      const body = JSON.stringify({
        text: "Cancel this draft",
        model: { providerID: "qwen-local", modelID: "main-9b" },
      })
      const http = yield* HttpServer.HttpServer
      const client = Object.assign(
        (input: Parameters<typeof fetch>[0], opts?: Parameters<typeof fetch>[1]) => {
          mark(`client-signal-${Boolean(opts?.signal)}`)
          opts?.signal?.addEventListener("abort", () => mark("client-fetch-aborted"), { once: true })
          return fetch(input, opts)
        },
        { preconnect: fetch.preconnect },
      )
      const pending =
        node === "process"
          ? Effect.callback<void, Error>((resume) => {
              if (http.address._tag !== "TcpAddress") return resume(Effect.fail(new Error("TCP fixture required")))
              const executable = Bun.which("node")
              if (!executable || !executable.endsWith("node.exe"))
                return resume(Effect.fail(new Error("Independent Node executable required")))
              const url = new URL("/enhance-prompt", HttpServer.formatAddress(http.address))
              if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
              const child = Bun.spawn(
                [
                  executable,
                  "--input-type=module",
                  "--eval",
                  `
              import { request } from 'node:http';
              import { createInterface } from 'node:readline';
              const lines = createInterface({ input: process.stdin });
              let client;
              lines.on('line', (line) => {
                if (line === 'cancel') { client.destroy(); return; }
                const cfg = JSON.parse(line);
                client = request(cfg.url, { method: 'POST', agent: false, headers: {
                  'content-type': 'application/json', 'x-kilo-directory': cfg.directory
                } }, (response) => { response.resume(); });
                client.once('error', () => console.log('error'));
                client.once('close', () => { console.log('closed'); lines.close(); });
                client.end(cfg.body);
                console.log('ready');
              });
            `,
                ],
                { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
              )
              mark("client-process-spawned")
              const output = new Response(child.stdout).text()
              const errors = new Response(child.stderr).text()
              const sent = Promise.resolve(
                child.stdin.write(`${JSON.stringify({ url: url.href, directory: instance.directory, body })}\n`),
              ).then(() => child.stdin.flush())
              void sent.catch((error: unknown) =>
                resume(Effect.fail(error instanceof Error ? error : new Error("Owned fixture input failed"))),
              )
              return Effect.promise(async () => {
                mark("client-process-cancel")
                const timer = setTimeout(() => child.kill(), 2_000)
                try {
                  await sent
                  await child.stdin.write("cancel\n")
                  await child.stdin.flush()
                  const code = await child.exited
                  mark("client-process-joined")
                  expect(code).toBe(0)
                  expect((await output).trim().split(/\r?\n/)).toEqual(["ready", "error", "closed"])
                  expect(await errors).toBe("")
                } finally {
                  clearTimeout(timer)
                  await child.stdin.end()
                }
              })
            })
          : node
            ? Effect.callback<void, Error>((resume) => {
                if (http.address._tag !== "TcpAddress") return resume(Effect.fail(new Error("TCP fixture required")))
                const closed = Promise.withResolvers<void>()
                const url = new URL("/enhance-prompt", HttpServer.formatAddress(http.address))
                if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
                const request = connect(
                  url,
                  {
                    method: "POST",
                    agent: false,
                    headers: { "content-type": "application/json", "x-kilo-directory": instance.directory },
                  },
                  (response) => {
                    response.resume()
                    response.once("end", () => resume(Effect.void))
                  },
                )
                request.once("error", (error) => resume(Effect.fail(error)))
                request.once("close", () => {
                  mark("client-node-closed")
                  closed.resolve()
                })
                request.end(body)
                return Effect.promise(async () => {
                  mark("client-node-destroy")
                  request.destroy()
                  const timer = setTimeout(() => closed.reject(new Error("Owned HTTP request did not close")), 2_000)
                  try {
                    await closed.promise
                  } finally {
                    clearTimeout(timer)
                  }
                })
              })
            : requestInDirectory("/enhance-prompt", instance.directory, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              }).pipe(Effect.provideService(FetchHttpClient.Fetch, client), Effect.asVoid)
      const helper = yield* pending.pipe(Effect.forkChild)
      yield* Effect.sync(status).pipe(
        Effect.repeat({ until: (state) => state.queued === 1, schedule: Schedule.spaced(10) }),
        Effect.timeout(10_000),
      )
      mark("helper-queued")
      expect(requests).toEqual(["main-9b", "deepseek-test"])
      yield* Fiber.interrupt(helper)
      mark("helper-interrupted")
      yield* Effect.sync(status).pipe(
        Effect.repeat({ until: (state) => state.queued === 0, schedule: Schedule.spaced(10) }),
        Effect.timeout(10_000),
      )
      mark("helper-removed")
      expect(status().active).toBe(1)
      expect(requests).toEqual(["main-9b", "deepseek-test"])
      held.release.resolve()
      mark("native-released")
      const named = yield* Fiber.join(branch)
      mark("branch-joined")
      expect(named.status).toBe(200)
      const result = yield* named.json
      if (JSON.stringify(result) !== JSON.stringify({ branch: "share-local-inference" }))
        console.info("Queued helper fixture phases", JSON.stringify({ phases, requests, state: status() }))
      expect(result).toEqual({ branch: "share-local-inference" })
      const fresh = yield* requestInDirectory("/enhance-prompt", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "A fresh draft", model: { providerID: "qwen-local", modelID: "main-9b" } }),
      })
      expect(fresh.status).toBe(200)
      expect(yield* fresh.json).toEqual({ text: "Improved local draft" })
      expect(requests).toEqual(["main-9b", "deepseek-test", "main-9b"])
      expect(status()).toEqual({ active: 0, queued: 0, bytes: 0 })
      console.info(
        "Queued helper transport phases",
        JSON.stringify({ transport: node === "process" ? "process" : node ? "node" : "bun", phases }),
      )
    }).pipe(Effect.ensuring(Effect.sync(() => held.release.resolve())))
  }
}

it.instance(
  "interrupting a queued HTTP enhancement removes it without a stale model request",
  cancellation(false),
  { config },
  45_000,
)

it.instance(
  "destroying an owned node HTTP enhancement request removes it without a stale model request",
  cancellation(true),
  { config },
  45_000,
)

it.instance(
  "closing an independent Node process HTTP request removes a queued enhancement without stale inference",
  cancellation("process"),
  { config },
  45_000,
)

it.instance(
  "SDK streaming inference holds admission while native JSON waits as bounded bytes",
  () => {
    const held = gate()
    const next = gate()
    next.release.resolve()
    requests.length = 0
    return Effect.gen(function* () {
      const instance = yield* TestInstance
      const created = yield* requestInDirectory("/session", instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Reverse local admission fixture" }),
      })
      expect(created.status).toBe(200)
      const session = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(yield* created.json)
      const sdk = yield* requestInDirectory(`/session/${session.id}/branch-name`, instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Implement bounded inference admission",
          providerID: "qwen-local",
          modelID: "main-9b",
        }),
      }).pipe(Effect.forkChild)
      yield* Effect.promise(() => held.opened.promise)
      const native = yield* requestInDirectory(`/session/${session.id}/branch-name`, instance.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Verify native inference waits behind the SDK transport",
          providerID: "deepseek-local",
          modelID: "deepseek-test",
        }),
      }).pipe(Effect.forkChild)
      const queued = yield* Effect.sync(status).pipe(
        Effect.repeat({ until: (state) => state.queued === 1, schedule: Schedule.spaced(10) }),
        Effect.timeout(10_000),
      )
      expect(queued.active).toBe(1)
      expect(queued.bytes).toBeGreaterThan(256)
      expect(queued.bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(requests).toEqual(["main-9b"])
      held.release.resolve()
      const first = yield* Fiber.join(sdk)
      const second = yield* Fiber.join(native)
      expect(first.status).toBe(200)
      expect(yield* first.json).toEqual({ branch: "share-local-inference" })
      expect(second.status).toBe(200)
      expect(yield* second.json).toEqual({ branch: "share-local-inference" })
      expect(requests).toEqual(["main-9b", "deepseek-test"])
      expect(status()).toEqual({ active: 0, queued: 0, bytes: 0 })
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          held.release.resolve()
          next.release.resolve()
        }),
      ),
    )
  },
  { config },
  45_000,
)
