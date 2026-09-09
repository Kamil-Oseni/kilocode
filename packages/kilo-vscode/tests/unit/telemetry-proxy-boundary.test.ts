import { expect, spyOn, test } from "bun:test"
import * as vscode from "vscode"
import { TelemetryProxy } from "../../src/services/telemetry/telemetry-proxy"
import { TelemetryEventName } from "../../src/services/telemetry/types"

test("telemetry consent gates enrichment and dispatch without copying properties into console logs", async () => {
  const consent = Object.getOwnPropertyDescriptor(vscode.env, "isTelemetryEnabled")!
  const log = spyOn(console, "log").mockImplementation(() => undefined)
  const received = Promise.withResolvers<unknown>()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(new URL(request.url).pathname)
      received.resolve(await request.json())
      return Response.json({ ok: true })
    },
  })
  const proxy = TelemetryProxy.getInstance()
  let reads = 0
  proxy.configure(server.url.origin, "synthetic-local-credential")
  proxy.setProvider({
    getTelemetryProperties() {
      reads++
      return { source: "synthetic-fixture" }
    },
  })
  try {
    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: false, configurable: true })
    TelemetryProxy.capture(TelemetryEventName.TAB_SHOWN, { detail: "synthetic-private-opted-out-detail" })
    expect(reads).toBe(0)
    expect(log).not.toHaveBeenCalled()
    expect(requests).toEqual([])

    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: true, configurable: true })
    TelemetryProxy.capture(TelemetryEventName.TAB_SHOWN, { surface: "history" })
    expect(await received.promise).toEqual({
      event: TelemetryEventName.TAB_SHOWN,
      properties: { source: "synthetic-fixture", surface: "history" },
    })
    expect(reads).toBe(1)
    expect(requests).toEqual(["/telemetry/capture"])
    expect(log).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(vscode.env, "isTelemetryEnabled", consent)
    proxy.configure("", "")
    proxy.setProvider({ getTelemetryProperties: () => ({}) })
    log.mockRestore()
    await server.stop(true)
  }
})
