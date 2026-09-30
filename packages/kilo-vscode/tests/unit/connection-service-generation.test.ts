import { expect, test } from "bun:test"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

test("a late startup result cannot overwrite or reset a replacement connection", async () => {
  const first = Promise.withResolvers<{ port: number; password: string }>()
  const next = Promise.withResolvers<{ port: number; password: string }>()
  const service = new KiloConnectionService({} as never)
  const manager = (service as unknown as { serverManager: object }).serverManager
  let calls = 0
  Object.defineProperty(manager, "getServer", {
    value: () => (++calls === 1 ? first.promise : next.promise),
  })

  const old = service.connect("C:\\raya-test")
  expect(calls).toBe(1)
  ;(service as unknown as { handleServerExit(code: number, signal: null): void }).handleServerExit(1, null)

  const replacement = service.connect("C:\\raya-test")
  expect(calls).toBe(2)
  expect(service.getConnectionState()).toBe("connecting")

  first.resolve({ port: 41234, password: "old-secret" })
  await expect(old).rejects.toThrow("replaced")
  expect(service.getConnectionState()).toBe("connecting")
  expect(service.getServerInfo()).toBeNull()

  service.dispose()
  next.resolve({ port: 41235, password: "new-secret" })
  await expect(replacement).rejects.toThrow("replaced")
  expect(service.getConnectionState()).toBe("disconnected")
  expect(service.getServerInfo()).toBeNull()
})

test("a delayed capability completion cannot reset the replacement client", async () => {
  const entered = Promise.withResolvers<void>()
  const replaced = Promise.withResolvers<void>()
  const first = Promise.withResolvers<{ status: "supported"; permit: () => boolean }>()
  const next = Promise.withResolvers<{ status: "supported"; permit: () => boolean }>()
  const service = new KiloConnectionService({} as never)
  const manager = (service as unknown as { serverManager: object }).serverManager
  let calls = 0
  Object.defineProperty(manager, "getServer", {
    value: async () => ({ port: ++calls === 1 ? 41234 : 41235, password: "private-secret" }),
  })
  let probes = 0
  Object.defineProperty(service.capabilities, "probe", {
    value: () => {
      if (++probes === 1) {
        entered.resolve()
        return first.promise
      }
      replaced.resolve()
      return next.promise
    },
  })
  const fetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (new URL(url).pathname !== "/global/event") return new Response(null, { status: 404 })
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"payload":{"id":"evt_connected","type":"server.connected","properties":{}}}\n\n',
            ),
          )
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )
  }) as typeof fetch

  try {
    const old = service.connect("C:\\raya-test")
    await entered.promise
    ;(service as unknown as { handleServerExit(code: number, signal: null): void }).handleServerExit(1, null)
    const current = service.connect("C:\\raya-test")
    await replaced.promise
    next.resolve({ status: "supported", permit: () => true })
    await expect(current).resolves.toBeUndefined()
    const client = service.getClient()
    first.resolve({ status: "supported", permit: () => true })
    await expect(old).rejects.toThrow("replaced")
    expect(service.getClient()).toBe(client)
    expect(service.getConnectionState()).toBe("connected")
  } finally {
    service.dispose()
    first.resolve({ status: "supported", permit: () => true })
    next.resolve({ status: "supported", permit: () => true })
    globalThis.fetch = fetch
  }
})
