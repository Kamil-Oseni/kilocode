import { expect, test } from "bun:test"
import { post } from "@/kilocode/voice/transport"

for (const status of [204, 301, 302, 303, 307, 308]) {
  for (const remote of [false, true]) {
    test(`voice context delivery handles ${status} without ${remote ? "other-port" : "same-origin"} redirects`, async () => {
      const hits: string[] = []
      const calls: Array<{ path: string; body: string; method: string }> = []
      const target = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          hits.push(request.url)
          return new Response(null, { status: 204 })
        },
      })
      const source = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname
          if (path === "/redirected") {
            hits.push(request.url)
            return new Response(null, { status: 204 })
          }
          calls.push({ path, method: request.method, body: await request.text() })
          return new Response(null, {
            status,
            headers: { Location: `${remote ? target.url.origin : new URL(request.url).origin}/redirected` },
          })
        },
      })
      const item = {
        id: "context",
        kind: "delegation.result",
        text: "synthetic private workspace result",
        ttl: 5000,
        created: new Date(0).toISOString(),
      }
      try {
        const result = await post(source.url.origin, "rvs_test", item).then(
          () => undefined,
          (error: unknown) => error,
        )
        if (status === 204) expect(result).toBeUndefined()
        if (status !== 204) {
          expect(result).toBeInstanceOf(Error)
          if (!(result instanceof Error)) throw new Error("Expected the context transport to refuse the redirect")
          expect(result.message).toBe(`Media injection failed with status ${status}`)
        }
        expect(hits).toEqual([])
        expect(calls).toEqual([
          { path: "/v1/sessions/rvs_test/inject", method: "POST", body: JSON.stringify({ item }) },
        ])
      } finally {
        await Promise.all([source.stop(true), target.stop(true)])
      }
    })
  }
}
