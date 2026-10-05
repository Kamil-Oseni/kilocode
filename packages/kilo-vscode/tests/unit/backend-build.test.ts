import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { build } from "../../src/services/cli-backend/build"

test("build observes the authenticated backend health response using the real SDK", async () => {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      if (request.headers.get("authorization") !== "Basic fixture") return new Response(null, { status: 401 })
      return Response.json({ healthy: true, version: "backend-actual-build" })
    },
  })
  try {
    const client = createKiloClient({ baseUrl: server.url.origin, headers: { Authorization: "Basic fixture" } })
    expect(await build(client)).toBe("backend-actual-build")
    expect(requests).toEqual(["/global/health"])
    await expect(build(createKiloClient({ baseUrl: server.url.origin }))).rejects.toBeDefined()
  } finally {
    await server.stop(true)
  }
})

test("build does not substitute an extension version for missing, failed or malformed backend identity", async () => {
  const responses = [
    { healthy: true },
    { healthy: false, version: "wrong" },
    { healthy: true, version: " " },
    { healthy: true, version: "bad\nidentity" },
    { healthy: true, version: "a".repeat(257) },
  ]
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(responses.shift()),
  })
  try {
    const client = createKiloClient({ baseUrl: server.url.origin })
    for (const _ of Array.from({ length: responses.length })) await expect(build(client)).rejects.toThrow()
  } finally {
    await server.stop(true)
  }
})
