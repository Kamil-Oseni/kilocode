import { afterEach, expect, test } from "bun:test"
import { ConfigProvider, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as HttpApiServer from "@/server/routes/instance/httpapi/server"
import { Snapshot } from "@/kilocode/provider/inference-observation"
import { headers, originHeader } from "@/kilocode/provider/inference-lane"
import { localFetch } from "@/kilocode/provider/local-scheduler"
import { MessageID, SessionID } from "@/session/schema"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { resetDatabase } from "../../fixture/db"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("the authenticated scoped route observes only primary current requests without starting or replaying work", async () => {
  await using first = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  await using second = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  const app = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
            KILO_SERVER_USERNAME: "local-observer",
            KILO_SERVER_PASSWORD: "local-observation-fixture",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const received: { lane: string | null; origin: string | null }[] = []
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push({ lane: request.headers.get("x-raya-inference-lane"), origin: request.headers.get(originHeader) })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.set(new URL(request.url).pathname, controller)
            controller.enqueue(new TextEncoder().encode("ready"))
          },
        }),
      )
    },
  })
  const request = (route: string, directory = first.path, body?: unknown) =>
    app.handler(
      new Request(new URL(route, "http://localhost"), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-kilo-directory": directory,
          authorization: `Basic ${Buffer.from("local-observer:local-observation-fixture").toString("base64")}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      HttpApiServer.context,
    )
  const end = (path: string) => {
    const stream = streams.get(path)
    if (!stream) throw new Error("Expected original controlled HTTP stream")
    stream.close()
    streams.delete(path)
  }
  try {
    const created = await request("/session", first.path, { title: "Local observation owner" })
    expect(created.status).toBe(200)
    const owner: { id: string } = await created.json()
    const foreign = await request("/session", second.path, { title: "Other workspace owner" })
    expect(foreign.status).toBe(200)
    const other: { id: string } = await foreign.json()
    const route = `/kilocode/local-inference?sessionID=${owner.id}`
    expect((await app.handler(new Request(`http://localhost${route}`), HttpApiServer.context)).status).toBe(401)
    expect((await request("/kilocode/local-inference")).status).toBe(400)
    expect((await request(`/kilocode/local-inference?sessionID=${SessionID.descending()}`)).status).toBe(404)
    expect((await request(`/kilocode/local-inference?sessionID=${other.id}`)).status).toBe(404)
    expect((await request(route, second.path)).status).toBe(404)
    const empty = Schema.decodeUnknownSync(Snapshot)(await (await request(route)).json())
    expect(String(empty.sessionID)).toBe(owner.id)
    expect(empty.requests).toEqual([])
    const helper = { sessionID: owner.id, messageID: MessageID.ascending(), helper: true as const }
    const primary = { sessionID: owner.id, messageID: MessageID.ascending() }
    const transport = localFetch({ localInference: true })
    const held = await transport(new URL("/helper", host.url), { headers: headers({}, "background", true, helper) })
    const hidden = Schema.decodeUnknownSync(Snapshot)(await (await request(route)).json())
    expect(hidden.requests).toEqual([])
    const pending = transport(new URL("/primary", host.url), {
      headers: headers({}, "interactive", true, primary),
      method: "POST",
      body: "private-prompt-body",
    })
    const queued = Schema.decodeUnknownSync(Snapshot)(await (await request(route)).json())
    expect(queued.requests).toMatchObject([{ messageID: primary.messageID, queued: 1, active: 0 }])
    expect(queued.requests[0]?.since).toBeGreaterThanOrEqual(empty.observedAt)
    expect(queued.epoch).toBe(empty.epoch)
    expect(JSON.stringify(queued)).not.toContain("private-prompt-body")
    expect(JSON.stringify(queued)).not.toContain(host.url.href)
    end("/helper")
    await held.text()
    const response = await pending
    const active = Schema.decodeUnknownSync(Snapshot)(await (await request(route)).json())
    expect(active.requests).toEqual([{ messageID: primary.messageID, queued: 0, active: 1 }])
    end("/primary")
    await response.text()
    expect(Schema.decodeUnknownSync(Snapshot)(await (await request(route)).json()).requests).toEqual([])
    expect(received).toEqual([
      { lane: null, origin: null },
      { lane: null, origin: null },
    ])
  } finally {
    await host.stop(true)
    await app.dispose()
  }
}, 30_000)
