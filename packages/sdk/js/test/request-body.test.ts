import { describe, expect, test } from "bun:test"
import { createKiloClient } from "../src/client"
import { createKiloClient as createV2KiloClient } from "../src/v2/client"

function recorder() {
  const requests: Request[] = []
  return {
    requests,
    fetch: async (request: Request) => {
      requests.push(request)
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  }
}

describe("SDK request bodies", () => {
  test("both SDK generations serialize JSON-sensitive strings", async () => {
    const title = 'Quote " slash \\ and\nnewline'
    const legacy = recorder()
    const current = recorder()

    await createKiloClient({ baseUrl: "http://127.0.0.1:1", fetch: legacy.fetch }).session.create({
      body: { title },
    })
    await createV2KiloClient({ baseUrl: "http://127.0.0.1:1", fetch: current.fetch }).session.create({ title })

    for (const request of [legacy.requests[0], current.requests[0]]) {
      expect(request).toBeDefined()
      expect(request?.headers.get("content-type")).toContain("application/json")
      expect(await request?.text()).toBe(JSON.stringify({ title }))
    }
  })
})
