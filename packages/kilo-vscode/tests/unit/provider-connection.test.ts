// raya_change - Milestone I inference-free provider connection test
import { describe, expect, it } from "bun:test"
import { FetchModelsError, fetchOpenAIModels } from "../../src/shared/fetch-models"

describe("provider connection", () => {
  it("returns models through a real GET /models request without inference", async () => {
    const requests: Array<{ method: string; path: string; auth: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          auth: request.headers.get("authorization"),
        })
        return Response.json({
          data: [{ id: "free-model-a" }, { id: "free-model-b", name: "Free Model B" }],
        })
      },
    })

    try {
      const models = await fetchOpenAIModels({
        baseURL: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "test-key",
      })

      expect(models).toEqual([
        { id: "free-model-a", name: "free-model-a" },
        { id: "free-model-b", name: "Free Model B" },
      ])
      expect(requests).toEqual([{ method: "GET", path: "/v1/models", auth: "Bearer test-key" }])
    } finally {
      server.stop(true)
    }
  })

  it("reports authentication failures without making an inference request", async () => {
    const requests: Array<{ method: string; path: string; tenant: string | null }> = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push({
          method: request.method,
          path: url.pathname,
          tenant: request.headers.get("x-tenant"),
        })
        return new Response("invalid key", { status: 401 })
      },
    })

    try {
      const error = await fetchOpenAIModels({
        baseURL: `http://127.0.0.1:${server.port}/v1/`,
        apiKey: "invalid-key",
        headers: { "x-tenant": "raya" },
      }).catch((err: unknown) => err)

      expect(error).toBeInstanceOf(FetchModelsError)
      expect((error as FetchModelsError).auth).toBe(true)
      expect(requests).toEqual([{ method: "GET", path: "/v1/models", tenant: "raya" }])
    } finally {
      server.stop(true)
    }
  })
})
