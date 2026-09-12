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
    await TelemetryProxy.capture(TelemetryEventName.TAB_SHOWN, { detail: "synthetic-private-opted-out-detail" })
    expect(reads).toBe(0)
    expect(log).not.toHaveBeenCalled()
    expect(requests).toEqual([])

    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: true, configurable: true })
    await TelemetryProxy.capture(TelemetryEventName.TAB_SHOWN, { surface: "history" })
    expect(await received.promise).toEqual({
      event: TelemetryEventName.TAB_SHOWN,
      properties: { source: "synthetic-fixture", surface: "history" },
      generation: 0,
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

test("disconnect and shutdown drop the endpoint, and provider reentrancy cannot cross connections", async () => {
  const consent = Object.getOwnPropertyDescriptor(vscode.env, "isTelemetryEnabled")!
  const proxy = TelemetryProxy.getInstance()
  const received = Promise.withResolvers<void>()
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      received.resolve()
      return Response.json(true)
    },
  })
  let reads = 0
  try {
    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: true, configurable: true })
    proxy.configure(server.url.origin, "synthetic-local-credential")
    proxy.setProvider({
      getTelemetryProperties() {
        reads++
        proxy.disconnect()
        return { detail: "obsolete-connection" }
      },
    })
    await proxy.capture(TelemetryEventName.TAB_SHOWN)
    await proxy.capture(TelemetryEventName.TAB_SHOWN)
    await proxy.setEnabled(true)
    expect(reads).toBe(1)
    expect(requests).toEqual([])
    proxy.configure(server.url.origin, "replacement-credential")
    proxy.setProvider({ getTelemetryProperties: () => ({}) })
    await proxy.capture(TelemetryEventName.TAB_SHOWN, {
      detail: {
        toJSON() {
          Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: false, configurable: true })
          return "opted-out-during-serialization"
        },
      },
    })
    expect(requests).toEqual([])
    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: true, configurable: true })
    await proxy.capture(TelemetryEventName.TAB_SHOWN)
    await received.promise
    proxy.shutdown()
    await proxy.capture(TelemetryEventName.TAB_SHOWN)
    await proxy.setEnabled(true)
    expect(requests).toEqual(["/telemetry/capture"])
  } finally {
    proxy.shutdown()
    Object.defineProperty(vscode.env, "isTelemetryEnabled", consent)
    await server.stop(true)
  }
}, 15_000)

test("telemetry refuses redirects and non-success replies without logging credentials or properties", async () => {
  const consent = Object.getOwnPropertyDescriptor(vscode.env, "isTelemetryEnabled")!
  const proxy = TelemetryProxy.getInstance()
  const failed = Promise.withResolvers<void>()
  const errors: unknown[][] = []
  const log = spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args)
    if (errors.length === 2) failed.resolve()
  })
  let redirected = 0
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      redirected++
      return Response.json(true)
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("capture"))
        return Response.redirect(`${target.url.origin}/synthetic-private-property`, 307)
      return new Response("synthetic-private-server-error", { status: 503 })
    },
  })
  try {
    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: true, configurable: true })
    proxy.configure(server.url.origin, "synthetic-private-credential")
    await proxy.capture(TelemetryEventName.TAB_SHOWN, { detail: "synthetic-private-property" })
    await proxy.setEnabled(false)
    await failed.promise
    expect(redirected).toBe(0)
    expect(errors.map((args) => args.join(" ")).sort()).toEqual([
      "[Raya] Telemetry capture request failed.",
      "[Raya] Telemetry setEnabled request failed.",
    ])
    expect(JSON.stringify(errors)).not.toContain("synthetic-private")
  } finally {
    proxy.shutdown()
    log.mockRestore()
    Object.defineProperty(vscode.env, "isTelemetryEnabled", consent)
    await Promise.all([server.stop(true), target.stop(true)])
  }
}, 15_000)

test("disconnect aborts a pending telemetry HTTP request", async () => {
  const consent = Object.getOwnPropertyDescriptor(vscode.env, "isTelemetryEnabled")!
  const proxy = TelemetryProxy.getInstance()
  const entered = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Response>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      entered.resolve()
      return release.promise
    },
  })
  try {
    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: true, configurable: true })
    proxy.configure(server.url.origin, "synthetic-local-credential")
    const pending = proxy.capture(TelemetryEventName.TAB_SHOWN)
    await entered.promise
    proxy.disconnect()
    await pending
    await aborted.promise
    expect(proxy.isVSCodeTelemetryEnabled()).toBe(true)
  } finally {
    proxy.shutdown()
    release.resolve(Response.json(true))
    Object.defineProperty(vscode.env, "isTelemetryEnabled", consent)
    await server.stop(true)
  }
}, 15_000)

test("a later opt-out generation is sent even if an earlier enable is still in flight", async () => {
  const consent = Object.getOwnPropertyDescriptor(vscode.env, "isTelemetryEnabled")!
  const proxy = TelemetryProxy.getInstance()
  const bodies: { enabled?: boolean; generation?: number }[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { enabled?: boolean; generation?: number }
      if (body.enabled === true) {
        entered.resolve()
        await release.promise
      }
      bodies.push(body)
      return Response.json(true)
    },
  })
  try {
    Object.defineProperty(vscode.env, "isTelemetryEnabled", { value: true, configurable: true })
    proxy.configure(server.url.origin, "synthetic-local-credential")
    const enable = proxy.setEnabled(true)
    await entered.promise
    const disable = proxy.setEnabled(false)
    await disable
    release.resolve()
    await enable
    expect(bodies).toEqual([
      { enabled: false, generation: 2 },
      { enabled: true, generation: 1 },
    ])
  } finally {
    proxy.shutdown()
    Object.defineProperty(vscode.env, "isTelemetryEnabled", consent)
    await server.stop(true)
  }
}, 15_000)
