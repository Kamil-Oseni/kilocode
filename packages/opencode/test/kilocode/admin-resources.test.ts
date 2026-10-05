import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { RayaAdmin } from "@/kilocode/admin/registry"
import { RayaAdminService } from "@/kilocode/admin/service"
import { resources } from "@/kilocode/admin/resources"
import { localFetch } from "@/kilocode/provider/local-scheduler"

test("admin observations follow real shared HTTP queue admission and release", async () => {
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await request.text()
      const path = new URL(request.url).pathname
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.set(path, controller)
            controller.enqueue(encoder.encode("held"))
          },
          cancel() {
            streams.delete(path)
          },
        }),
      )
    },
  })
  const service = RayaAdminService.make({
    runtime: () => "connected",
    sessions: { list: () => Effect.succeed([]) },
    tasks: {
      list: () => Effect.succeed([]),
      histories: () => Effect.succeed({ items: [], failed: [] }),
    },
  })
  const request = localFetch({ localInference: true })
  const abort = new AbortController()
  const first = await request(new URL("/first", server.url), { signal: abort.signal })
  const second = request(new URL("/second", server.url), { method: "POST", body: "queued", signal: abort.signal })
  void second.catch(() => undefined)
  try {
    const snapshot = await service.snapshot()
    const sample = Schema.decodeUnknownSync(RayaAdmin.Resources)(snapshot.resources)
    expect(sample.process.pid).toBe(process.pid)
    expect(sample.process.rss).toBeGreaterThan(0)
    expect(sample.host.total).toBeGreaterThanOrEqual(sample.host.free)
    expect(sample.inference.active).toBe(1)
    expect(sample.inference.queued).toBe(1)
    expect(sample.inference.bytes).toBeGreaterThanOrEqual(6)
    streams.get("/first")!.close()
    await first.text()
    const response = await second
    expect(resources().inference).toMatchObject({ active: 1, queued: 0, bytes: 0 })
    streams.get("/second")!.close()
    await response.text()
    expect(resources().inference).toEqual({ active: 0, queued: 0, bytes: 0 })
    expect(() => Schema.decodeUnknownSync(RayaAdmin.Resources)({ ...sample, host: { free: -1, total: 32 } })).toThrow()
  } finally {
    abort.abort()
    await Promise.allSettled([second, first.body?.cancel()])
    await server.stop(true)
  }
})
