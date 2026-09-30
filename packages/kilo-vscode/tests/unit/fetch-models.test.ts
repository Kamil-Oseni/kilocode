import { describe, expect, it } from "bun:test"
import { fetchOpenAIModels, FetchModelsError } from "../../src/shared/fetch-models"

describe("model discovery over a real local server", () => {
  it("discovers, deduplicates and sorts Unicode model names without requiring a key", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        expect(new URL(request.url).pathname).toBe("/v1/models")
        expect(request.headers.get("authorization")).toBeNull()
        return Response.json({ data: [null, { id: " z ", name: "千问" }, { id: "a" }, { id: "z" }] })
      },
    })
    try {
      expect(await fetchOpenAIModels({ baseURL: `${server.url}v1/` })).toEqual([
        { id: "a", name: "a" },
        { id: "z", name: "千问" },
      ])
    } finally {
      await server.stop(true)
    }
  })

  it("refuses redirects without forwarding keys or contacting the destination", async () => {
    let visits = 0
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        visits++
        return Response.json({ data: [] })
      },
    })
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(target.url, 307),
    })
    try {
      await expect(fetchOpenAIModels({ baseURL: source.url.toString(), apiKey: "fixture-only" })).rejects.toThrow(
        "Use its final API address",
      )
      expect(visits).toBe(0)
    } finally {
      await source.stop(true)
      await target.stop(true)
    }
  })

  it("keeps authentication status without exposing server response contents", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("private server diagnostic fixture", { status: 401 }),
    })
    try {
      const result = await fetchOpenAIModels({ baseURL: server.url.toString() }).catch((err: unknown) => err)
      expect(result).toBeInstanceOf(FetchModelsError)
      if (!(result instanceof FetchModelsError)) throw new Error("Expected model discovery error")
      expect(result.auth).toBe(true)
      expect(result.message).not.toContain("private server")
    } finally {
      await server.stop(true)
    }
  })

  for (const [name, content, error] of [
    ["oversized bodies", " ".repeat(2 * 1024 * 1024 + 1), "too large"],
    ["missing lists", JSON.stringify({ models: [] }), "did not return a model list"],
    ["malformed private replies", "private malformed response fixture", "returned invalid JSON"],
    [
      "too many entries",
      JSON.stringify({ data: Array.from({ length: 4097 }, (_, n) => ({ id: String(n) })) }),
      "too many",
    ],
    ["oversized identities", JSON.stringify({ data: [{ id: "a".repeat(1025) }] }), "too long"],
  ]) {
    it(`refuses ${name}`, async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(content) })
      try {
        await expect(fetchOpenAIModels({ baseURL: server.url.toString() })).rejects.toThrow(error)
      } finally {
        await server.stop(true)
      }
    })
  }
})
