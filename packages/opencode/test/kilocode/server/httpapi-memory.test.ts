import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { MemoryPaths } from "../../../src/kilocode/server/httpapi/groups/memory"
import { KiloToolRegistry } from "../../../src/kilocode/tool/registry"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

type Json = Record<string, unknown>

function app() {
  const handler = HttpRouter.toWebHandler(
    // kilocode_change - keep the filewatcher-disable flag visible (see httpapi-instance-route-auth.test.ts)
    HttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "true",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        HttpApiServer.context,
      )
    },
  }
}

function rec(input: unknown): Json {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected object")
  return input as Json
}

function keys(input: unknown) {
  return Object.keys(rec(input)).sort()
}

function expectStats(input: unknown) {
  expect(keys(input)).toEqual(
    [
      "lastTypedConsolidationAt",
      "lastSessionSavedAt",
      "lastConsolidationCost",
      "lastConsolidationTokens",
      "lastInjectedAt",
      "lastInjectedBytes",
      "lastInjectedSessionID",
      "lastInjectedTokens",
      "lastOperationCount",
      "lastRecallAt",
      "lastRecallCount",
      "lastRecallSessionID",
    ].sort(),
  )
}

function expectOperation(input: unknown) {
  expect(keys(input)).toEqual(["added", "index", "operationCount", "removed", "skipped"].sort())
  expect(keys(rec(input).index)).toEqual(["bytes", "text", "tokens", "truncated"].sort())
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi memory", () => {
  test("prepared Dream generation uses the actual provider and bounded original HTTP transport without memory writes", async () => {
    const calls: Record<string, unknown>[] = []
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let hold = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls.push(rec(await request.json()))
        if (hold) {
          ready.resolve()
          await release.promise
        }
        return Response.json({
          id: "fixture-completion",
          object: "chat.completion",
          created: 1,
          model: "dream-fixture",
          choices: [{ index: 0, message: { role: "assistant", content: '{"items":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        })
      },
    })
    const api = app()
    const requests = new Set<Promise<Response>>()
    const router = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const work = api.request(request)
        requests.add(work)
        void work.then(
          () => requests.delete(work),
          () => requests.delete(work),
        )
        return work
      },
    })
    try {
      await using tmp = await tmpdir({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            "dream-fixture": {
              npm: "@ai-sdk/openai-compatible",
              env: [],
              options: { baseURL: new URL("v1", server.url).toString(), localInference: true },
              models: { "dream-fixture": { limit: { context: 32768, output: 4096 } } },
            },
          },
        },
      })
      const payload = {
        id: crypto.randomUUID(),
        owner: crypto.randomUUID(),
        model: "dream-fixture/dream-fixture",
        system: "Return a bounded consolidation result.",
        prompt: "No supported changes in these synthetic approved inputs.",
        timeoutMs: 5000,
        budget: { input: 1000, output: 500 },
      }
      const send = (body: unknown) =>
        api.request("/memory/dream/generate", {
          method: "POST",
          headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
          body: JSON.stringify(body),
        })
      const before = await api.request(MemoryPaths.status, { headers: { "x-kilo-directory": tmp.path } })
      const status = await before.json()
      const client = createKiloClient({ baseUrl: router.url.toString() })
      const response = await client.memory.dreamGenerate({ ...payload, directory: tmp.path })
      expect(response.response.status, JSON.stringify(response.error)).toBe(200)
      expect(response.data).toEqual({
        id: payload.id,
        owner: payload.owner,
        configuredModel: payload.model,
        text: '{"items":[]}',
        settlement: "sdk",
      })
      expect(calls).toHaveLength(1)
      expect(calls[0].max_tokens).toBe(500)
      expect(calls[0].stream).toBe(false)
      const inspected = await client.memory.dreamInspect({ id: payload.id, owner: payload.owner, directory: tmp.path })
      expect(inspected.response.status).toBe(200)
      expect(inspected.data).toMatchObject({
        id: payload.id,
        owner: payload.owner,
        configuredModel: payload.model,
        settlement: "sdk",
        outcome: "completed",
      })
      expect(Object.keys(inspected.data!).sort()).toEqual(
        ["id", "owner", "configuredModel", "settlement", "outcome", "startedAt", "settledAt"].sort(),
      )
      expect((await send(payload)).status).toBe(400)
      expect(
        (await client.memory.dreamInspect({ id: payload.id, owner: crypto.randomUUID(), directory: tmp.path })).response
          .status,
      ).toBe(400)
      await using other = await tmpdir({ config: { formatter: false, lsp: false } })
      expect(
        (await client.memory.dreamInspect({ id: payload.id, owner: payload.owner, directory: other.path })).response
          .status,
      ).toBe(400)
      for (const body of [
        { ...payload, timeoutMs: 300001 },
        { ...payload, id: "invalid" },
        { ...payload, model: "invalid" },
        { ...payload, prompt: "x".repeat(65537) },
        { ...payload, budget: { input: 12001, output: 500 } },
      ])
        expect((await send(body)).status).toBe(400)
      const missing = { ...payload, id: crypto.randomUUID(), model: "dream-fixture/missing" }
      expect((await send(missing)).status).not.toBe(200)
      expect(
        (await client.memory.dreamInspect({ id: missing.id, owner: missing.owner, directory: tmp.path })).data,
      ).toMatchObject({
        configuredModel: missing.model,
        settlement: "sdk",
        outcome: "failed",
      })
      expect(calls).toHaveLength(1)
      hold = true
      const controller = new AbortController()
      const identity = { ...payload, id: crypto.randomUUID(), directory: tmp.path }
      const cancelled = client.memory.dreamGenerate(identity, { signal: controller.signal })
      await ready.promise
      const original = [...requests]
      expect(original).toHaveLength(1)
      const pending = await client.memory.dreamInspect({ id: identity.id, owner: identity.owner, directory: tmp.path })
      expect(pending.data).toMatchObject({ settlement: "pending", outcome: "running" })
      expect(pending.data).not.toHaveProperty("settledAt")
      expect((await send({ ...payload, id: crypto.randomUUID() })).status).toBe(400)
      expect(calls).toHaveLength(2)
      controller.abort()
      await Bun.sleep(30)
      release.resolve()
      const [outcome, joined] = await Promise.all([Promise.allSettled([cancelled]), Promise.allSettled(original)])
      expect(outcome[0].status === "rejected" || Boolean(outcome[0].value.error)).toBe(true)
      expect(joined.every((item) => item.status === "rejected" || item.value.status !== 200)).toBe(true)
      const settled = await client.memory.dreamInspect({ id: identity.id, owner: identity.owner, directory: tmp.path })
      expect(settled.data).toMatchObject({ settlement: "sdk", outcome: "interrupted" })
      expect(settled.data!.settledAt).toBeGreaterThanOrEqual(settled.data!.startedAt)
      const after = await api.request(MemoryPaths.status, { headers: { "x-kilo-directory": tmp.path } })
      expect(await after.json()).toEqual(status)
    } finally {
      release.resolve()
      await Promise.all([router.stop(true), server.stop(true)])
    }
  }, 30000)

  test("manages project memory through HTTP routes", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const api = app()
    const send = (method: string, route: string, body?: unknown) =>
      api.request(route, {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const json = async (method: string, route: string, body?: unknown) => {
      const response = await send(method, route, body)
      expect(response.status).toBe(200)
      return rec(await response.json())
    }

    const status = await json("GET", MemoryPaths.status)
    expect(keys(status)).toEqual(["exists", "index", "root", "state"].sort())
    expect(keys(status.state)).toEqual(
      ["autoConsolidate", "autoInject", "capture", "enabled", "limits", "scope", "stats", "verbose", "version"].sort(),
    )
    expect(rec(status.state).enabled).toBe(false)
    expect(rec(status.state).autoConsolidate).toBe(true)
    expect(rec(status.state).verbose).toBe(false)
    expect(rec(status.index).estimatedTokens).toBe(0)
    const stats = rec(rec(status.state).stats)
    expectStats(stats)
    expect(stats.lastInjectedAt).toBe(0)
    expect(stats.lastInjectedSessionID).toBe("")
    expect(stats.lastTypedConsolidationAt).toBe(0)

    const enable = await json("POST", MemoryPaths.enable)
    expectStats(rec(rec(enable.state).stats))
    expect(rec(enable.state).enabled).toBe(true)
    expect(rec(rec(enable.state).stats).lastInjectedSessionID).toBe("")

    const configured = await json("POST", MemoryPaths.configure, { autoConsolidate: false, verbose: true })
    expect(rec(configured.state).enabled).toBe(true)
    expect(rec(configured.state).autoConsolidate).toBe(false)
    expect(rec(configured.state).verbose).toBe(true)

    const updated = await json("GET", MemoryPaths.status)
    expect(rec(updated.state).autoConsolidate).toBe(false)
    expect(rec(updated.state).verbose).toBe(true)

    const remembered = await json("POST", MemoryPaths.remember, {
      key: "httpapi_memory",
      text: "Use the memory HTTP API test as a stable project fact.",
      sessionID: "ses_http_memory",
    })
    expectOperation(remembered)
    expect(remembered.operationCount).toBe(1)
    expect(remembered.added).toBe(1)
    expect(remembered.removed).toBe(0)
    expect(remembered.skipped).toEqual([])
    expect(String(rec(remembered.index).text)).toContain("httpapi_memory")

    const skipped = await json("POST", MemoryPaths.remember, {
      key: "httpapi_skip",
      text: "Project memory already captures this HTTP API behavior.",
    })
    expectOperation(skipped)
    expect(skipped.operationCount).toBe(0)
    expect(skipped.added).toBe(0)
    expect(skipped.removed).toBe(0)
    expect(skipped.skipped).toEqual([
      { reason: "self_referential", text: "Project memory already captures this HTTP API behavior." },
    ])
    expect(String(rec(skipped.index).text)).not.toContain("httpapi_skip")

    const corrected = await json("POST", MemoryPaths.correct, {
      key: "httpapi_correction",
      text: "Prefer correction memory over stale project facts.",
    })
    expectOperation(corrected)
    expect(corrected.operationCount).toBe(1)
    expect(corrected.added).toBe(1)
    expect(corrected.removed).toBe(0)
    expect(corrected.skipped).toEqual([])
    expect(String(rec(corrected.index).text)).toContain("httpapi_correction")

    const show = await json("GET", MemoryPaths.show)
    expect(String(show.index)).toContain("httpapi_memory")
    expect(String(show.items)).toContain("httpapi_memory")
    expect(String(rec(show.sources).project)).toContain("httpapi_memory")
    expect(show.changes).toBe("")
    expect(show.decisions).toBe("")

    const forgotten = await json("POST", MemoryPaths.forget, { query: "httpapi_memory" })
    expectOperation(forgotten)
    expect(forgotten.operationCount).toBe(1)
    expect(forgotten.added).toBe(0)
    expect(forgotten.removed).toBe(1)
    expect(forgotten.skipped).toEqual([])
    expect(String(rec(forgotten.index).text)).not.toContain("httpapi_memory")

    const disable = await json("POST", MemoryPaths.disable)
    expect(rec(disable.state).enabled).toBe(false)

    const purge = await json("POST", MemoryPaths.purge, { confirm: true })
    expect(purge.purged).toBe(true)
  })

  test("enable and disable refresh memory tool availability for the next prompt", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const api = app()
    const ctx = { directory: tmp.path, worktree: tmp.path }
    const send = (method: string, route: string) =>
      api.request(route, {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
      })

    expect(await Effect.runPromise(KiloToolRegistry.memoryToolsEnabled({ ctx }))).toBe(false)

    const enabled = await send("POST", MemoryPaths.enable)
    expect(enabled.status).toBe(200)
    expect(await Effect.runPromise(KiloToolRegistry.memoryToolsEnabled({ ctx }))).toBe(true)

    const disabled = await send("POST", MemoryPaths.disable)
    expect(disabled.status).toBe(200)
    expect(await Effect.runPromise(KiloToolRegistry.memoryToolsEnabled({ ctx }))).toBe(false)
  })

  test("purge uses the routed workspace context, not an arbitrary root parameter", async () => {
    await using left = await tmpdir({ config: { formatter: false, lsp: false } })
    await using right = await tmpdir({ config: { formatter: false, lsp: false } })
    const api = app()
    const send = (dir: string, method: string, route: string, body?: unknown) =>
      api.request(route, {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": dir },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const json = async (dir: string, method: string, route: string, body?: unknown) => {
      const response = await send(dir, method, route, body)
      expect(response.status).toBe(200)
      return rec(await response.json())
    }

    const leftEnabled = await json(left.path, "POST", MemoryPaths.enable)
    const rightEnabled = await json(right.path, "POST", MemoryPaths.enable)
    await json(left.path, "POST", MemoryPaths.remember, {
      key: "left_memory",
      text: "Left workspace memory must be purged independently.",
    })
    await json(right.path, "POST", MemoryPaths.remember, {
      key: "right_memory",
      text: "Right workspace memory must survive left workspace purge.",
    })

    const purge = await json(
      left.path,
      "POST",
      `${MemoryPaths.purge}?root=${encodeURIComponent(String(rightEnabled.root))}`,
      { confirm: true },
    )
    const rightShow = await json(right.path, "GET", MemoryPaths.show)

    expect(purge.root).toBe(leftEnabled.root)
    expect(purge.purged).toBe(true)
    expect(rightShow.root).toBe(rightEnabled.root)
    expect(String(rec(rightShow.sources).project)).toContain("right_memory")
    expect(String(rec(rightShow.sources).project)).not.toContain("left_memory")
  })

  test("returns typed error codes for disabled and invalid-input failures", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const api = app()
    const send = (method: string, route: string, body?: unknown) =>
      api.request(route, {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

    // Disabled: /memory/remember while memory is off returns 400 MemoryApiClientError
    const disabledResp = await send("POST", MemoryPaths.remember, { text: "disabled test" })
    expect(disabledResp.status).toBe(400)
    const disabledBody = rec(await disabledResp.json())
    expect(disabledBody.name).toBe("MemoryApiClientError")
    expect(rec(disabledBody.data).code).toBe("memory_disabled")
    expect(typeof rec(disabledBody.data).message).toBe("string")

    await send("POST", MemoryPaths.enable)

    // Invalid input: empty key text returns 400 MemoryApiClientError
    const invalidResp = await send("POST", MemoryPaths.remember, { key: "k", text: "" })
    expect(invalidResp.status).toBeGreaterThanOrEqual(400)
    expect(invalidResp.status).toBeLessThan(500)
    const invalidBody = rec(await invalidResp.json())
    // Schema validation or MemoryInvalidInputError — either returns a 4xx with a body
    expect(typeof invalidBody.name).toBe("string")
  })

  test("rejects malformed HTTP payloads without corrupting memory files", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const api = app()
    const send = (method: string, route: string, body?: unknown) =>
      api.request(route, {
        method,
        headers: { "content-type": "application/json", "x-kilo-directory": tmp.path },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const json = async (method: string, route: string, body?: unknown) => {
      const response = await send(method, route, body)
      expect(response.status).toBe(200)
      return rec(await response.json())
    }
    const reject = async (route: string, body: unknown) => {
      const response = await send("POST", route, body)
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.status).toBeLessThan(500)
      expect(await response.text()).not.toContain("Internal Server Error")
    }

    await json("POST", MemoryPaths.enable)

    await reject(MemoryPaths.remember, { key: "missing_text" })
    await reject(MemoryPaths.remember, { key: "empty_text", text: "" })
    await reject(MemoryPaths.remember, { key: "bad_source", file: "outside.md", text: "bad source" })
    await reject(MemoryPaths.remember, { key: "bad_section", section: "Bad\n## Injected", text: "bad section" })
    await reject(MemoryPaths.remember, { key: "control_section", section: "Bad\u0000", text: "control section" })
    await reject(MemoryPaths.remember, { key: "long_section", section: "x".repeat(81), text: "long section" })
    await reject(MemoryPaths.remember, { key: "long_text", text: "x".repeat(12_001) })
    await reject(MemoryPaths.remember, { key: "x".repeat(257), text: "long key" })
    await reject(MemoryPaths.remember, { key: "long_session", text: "long session", sessionID: "x".repeat(129) })
    await reject(MemoryPaths.correct, { text: "x".repeat(12_001) })
    await reject(MemoryPaths.correct, { key: "x".repeat(257), text: "long key" })
    await reject(MemoryPaths.correct, { text: "long session", sessionID: "x".repeat(129) })
    await reject(MemoryPaths.forget, {})
    await reject(MemoryPaths.forget, { query: "" })
    await reject(MemoryPaths.forget, { query: "x".repeat(12_001) })
    await reject(MemoryPaths.forget, { query: "long session", sessionID: "x".repeat(129) })
    await reject(MemoryPaths.purge, {})
    await reject(MemoryPaths.purge, { confirm: false })

    const clean = await json("GET", MemoryPaths.show)
    const source = String(rec(clean.sources).project)
    expect(source).not.toContain("missing_text")
    expect(source).not.toContain("empty_text")
    expect(source).not.toContain("bad_source")
    expect(source).not.toContain("bad_section")
    expect(source).not.toContain("control_section")
    expect(source).not.toContain("long_section")

    const saved = await json("POST", MemoryPaths.remember, {
      key: "safe_section",
      section: "## Bad :: - Heading",
      text: "Keep suspicious section text inside one safe heading.",
    })
    expectOperation(saved)
    expect(saved.added).toBe(1)
    expect(saved.removed).toBe(0)
    expect(saved.skipped).toEqual([])

    const shown = await json("GET", MemoryPaths.show)
    const next = String(rec(shown.sources).project)
    expect(next).toContain("## Bad - Heading")
    expect(next).toContain("- safe_section :: Keep suspicious section text inside one safe heading.")
    expect(next).not.toContain("## Injected")
  })
})
