import { expect, test } from "bun:test"
import { createKiloClient } from "@kilocode/sdk/v2/client"
import { Capabilities } from "../../src/services/cli-backend/capabilities"
import { connectionDiagnostic } from "../../src/services/cli-backend/connection-diagnostic"

test("connection diagnostics retain only allowlisted network fields", () => {
  const error = Object.assign(new TypeError("fetch failed for https://private.example/secret?token=abc"), {
    cause: {
      code: "ECONNREFUSED",
      address: "127.0.0.1",
      port: 55123,
      password: "secret",
      url: "https://private.example/secret?token=abc",
    },
  })
  const detail = connectionDiagnostic("capabilities", 55123, error)
  expect(detail).toEqual({ phase: "capabilities", port: 55123, code: "ECONNREFUSED", address: "127.0.0.1" })
  expect(JSON.stringify(detail)).not.toContain("secret")
  expect(connectionDiagnostic("startup", 99999, { code: "token=abc", address: "10.0.0.2" })).toEqual({
    phase: "startup",
  })
  expect(
    connectionDiagnostic("initial-sse", 55123, {
      cause: new AggregateError([{ code: "ECONNRESET", address: "::1", authorization: "Basic secret" }]),
    }),
  ).toEqual({ phase: "initial-sse", port: 55123, code: "ECONNRESET", address: "::1" })
})

test("an authenticated capabilities refusal reports its status without request details", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("kilo:secret").toString("base64")}`)
      return new Response("private response body", { status: 503 })
    },
  })
  try {
    const config = { baseUrl: server.url.origin, password: "secret" }
    const client = createKiloClient({ baseUrl: config.baseUrl })
    const failures: unknown[] = []
    const capabilities = new Capabilities(
      () => ({ client, config }),
      (error) => failures.push(connectionDiagnostic("capabilities", server.port, error)),
    )
    expect((await capabilities.require(client, "client.vscode"))()).toBe(false)
    expect(failures).toEqual([{ phase: "capabilities", port: server.port, status: 503 }])
    expect(JSON.stringify(failures)).not.toContain("private")
  } finally {
    await server.stop(true)
  }
})
