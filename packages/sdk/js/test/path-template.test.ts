import { describe, expect, test } from "bun:test"
import { createKiloClient } from "../src/client"
import { createKiloClient as createV2KiloClient } from "../src/v2/client"

describe("SDK path templates", () => {
  test("rejects missing route values before fetch in both SDK generations", async () => {
    for (const create of [createKiloClient, createV2KiloClient]) {
      const requests: Request[] = []
      const client = create({
        baseUrl: "http://127.0.0.1:1",
        fetch: async (request) => {
          requests.push(request)
          return new Response("{}", { headers: { "content-type": "application/json" } })
        },
      })

      // Runtime JavaScript can omit generated TypeScript requirements; this deliberately crosses that boundary.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const get = client.session.get.bind(client.session) as unknown as (parameters: unknown) => Promise<unknown>
      const parameters = create === createKiloClient ? { path: {} } : {}

      await expect(get(parameters)).rejects.toThrow(/\{(?:id|sessionID)\}/)
      expect(requests).toHaveLength(0)

      const valid = create === createKiloClient ? { path: { id: "ses_123" } } : { sessionID: "ses_123" }
      await get(valid)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toContain("/session/ses_123")
    }
  })
})
