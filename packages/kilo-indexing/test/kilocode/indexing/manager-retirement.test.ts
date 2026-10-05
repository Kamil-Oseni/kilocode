import { expect, test } from "bun:test"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { CodeIndexManager } from "../../../src/indexing/manager"

test("manager retirement joins accepted actual loopback embedder validation before native graph disposal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-index-manager-close-"))
  const workspace = path.join(root, "workspace")
  await mkdir(workspace)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/embeddings")) {
        requests++
        entered.resolve()
        await release.promise
        return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } })
      }
      return Response.json({ title: "local fixture", version: "1.17.0", result: [], status: "ok" })
    },
  })
  const manager = new CodeIndexManager(workspace, path.join(root, "cache"))
  const initialized = manager.initialize({
    enabled: true,
    embedderProvider: "openai-compatible",
    openAiCompatibleBaseUrl: `http://127.0.0.1:${server.port}/v1`,
    openAiCompatibleApiKey: "private-fixture",
    modelId: "local-fixture",
    modelDimension: 2,
    vectorStoreProvider: "qdrant",
    qdrantUrl: `http://127.0.0.1:${server.port}`,
  })
  const timer = setTimeout(() => release.resolve(), 5000)
  try {
    await entered.promise
    const closed = manager.dispose()
    expect(manager.dispose()).toBe(closed)
    let settled = false
    void closed.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Bun.sleep(100)
    expect(settled).toBe(false)
    await expect(manager.searchIndex("late")).rejects.toThrow(/closed/)
    await expect(manager.recoverFromError()).rejects.toThrow(/closed/)
    release.resolve()
    await Promise.all([initialized, closed])
    expect(requests).toBe(1)
  } finally {
    release.resolve()
    clearTimeout(timer)
    await Promise.allSettled([initialized, manager.dispose()])
    await server.stop(true)
  }
}, 10000)
