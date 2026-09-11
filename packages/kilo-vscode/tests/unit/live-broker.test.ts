import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import WebSocket from "ws"
import { LiveBroker } from "../../src/speech/live-broker"
import { OPENAI_LIVE_MODEL } from "../../src/shared/speech"
import type { LiveUsage } from "../../src/shared/live-usage"

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
const input = { requestID: "request_1", sessionID: "session_1", sdp }
const remote = "rtc_live_1"

function fixture(startup = 12_000) {
  const state = {
    mode: "normal" as string,
    current: true,
    context: JSON.stringify({ source: "saved_task_context", messages: [{ role: "user", text: "Historical task" }] }),
    ready: [] as { sdp: string; providerSessionID: string }[],
    started: 0,
    errors: [] as string[],
    usage: [] as LiveUsage[],
    requests: [] as {
      path: string
      method: string
      authorization: string | null
      capability: string | null
      directory: string | null
      body: Record<string, unknown>
    }[],
    events: [] as Record<string, unknown>[],
    socket: undefined as ServerWebSocket<undefined> | undefined,
    control: undefined as WebSocket | undefined,
    capability: "",
    session: undefined as Record<string, unknown> | undefined,
  }
  const binding = {
    id: "binding_1",
    generation: "generation_1",
    parentSessionID: input.sessionID,
    providerCallID: remote,
    status: "active",
    directory: "C:/project",
    model: OPENAI_LIVE_MODEL,
  }
  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/v1/live/sessions/") && url.pathname.endsWith("/attach")) {
        expect(request.headers.get("authorization")).toBe("Bearer openai-only")
        expect(url.pathname).toBe(`/v1/live/sessions/${remote}/attach`)
        if (server.upgrade(request)) return
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/v1/live/sessions") {
        expect(request.headers.get("authorization")).toBe("Bearer openai-only")
        expect(request.headers.get("X-Raya-Voice-Key")).toBeNull()
        const body = (await request.json()) as Record<string, unknown>
        state.session = body.session as Record<string, unknown>
        if (state.mode === "rejected") return new Response("denied", { status: 401 })
        return Response.json({
          session: { id: remote },
          transport: { type: "webrtc", sdp },
        })
      }
      const body =
        request.method === "POST" && request.headers.get("content-type")?.includes("json")
          ? ((await request.json()) as Record<string, unknown>)
          : {}
      state.requests.push({
        path: url.pathname,
        method: request.method,
        body,
        authorization: request.headers.get("authorization"),
        capability: request.headers.get("X-Raya-Voice-Key"),
        directory: url.searchParams.get("directory"),
      })
      if (url.pathname.endsWith("/hangup")) return new Response(null, { status: state.mode === "cleanup" ? 503 : 200 })
      expect(request.headers.get("authorization")).toBe("Basic backend-only")
      expect(url.searchParams.get("directory")).toBe("C:/project")
      const capability = request.headers.get("X-Raya-Voice-Key")
      expect(capability).toMatch(/^[a-f0-9]{64}$/)
      if (!state.capability) state.capability = capability!
      expect(capability).toBe(state.capability)
      if (request.method === "DELETE") return Response.json({ ...binding, status: "closed" })
      if (url.pathname.endsWith("/session"))
        return Response.json({ ...binding, parentSessionID: state.mode === "binding" ? "unrelated" : input.sessionID })
      if (url.pathname.endsWith("/duration")) return Response.json(body.receipt)
      if (url.pathname.endsWith("/images")) {
        const bytes = Buffer.from(String(body.data), "base64")
        return Response.json({
          id: body.id,
          mime: body.mime,
          bytes: bytes.length,
          sha256: state.mode === "image-receipt" ? "wrong" : createHash("sha256").update(bytes).digest("hex"),
        })
      }
      if (url.pathname.includes("/calls")) {
        const expected = `liv_${createHash("sha256").update("dlg_1").digest("hex").slice(0, 48)}`
        if (state.mode === "failed-work")
          return Response.json({
            id: `work_${expected}`,
            callID: expected,
            messageID: "message_1",
            parentSessionID: input.sessionID,
            status: "failed",
          })
        return Response.json({
          id: `work_${expected}`,
          callID: expected,
          messageID: "message_1",
          parentSessionID: input.sessionID,
          status: "completed",
          result: { text: "Verified Live result", assistantMessageID: "assistant_1", evidence: [] },
        })
      }
      return new Response("unexpected", { status: 404 })
    },
    websocket: {
      open(socket) {
        state.socket = socket
      },
      message(socket, value) {
        const event = JSON.parse(String(value)) as Record<string, unknown>
        state.events.push(event)
        const type = String(event.type)
        if (type === "session.close") {
          socket.send(
            JSON.stringify({
              type: "session.closed",
              event_id: "evt_close_1",
              session: { id: remote, model: OPENAI_LIVE_MODEL },
            }),
          )
          return
        }
        if (type.endsWith(".append")) {
          socket.send(JSON.stringify({ type: type.replace(/\.append$/, ".appended"), client_event_id: event.event_id }))
          return
        }
        if (type === "session.input_audio.mute" || type === "session.input_audio.unmute")
          socket.send(JSON.stringify({ type: `${type}d`, client_event_id: event.event_id }))
      },
    },
  })
  const request: typeof fetch = (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value)
    expect(["https://api.openai.com", server.url.origin]).toContain(url.origin)
    return fetch(new URL(url.pathname + url.search, server.url), init)
  }
  const broker = new LiveBroker(
    request,
    (url, options) => {
      expect(url).toBe(`wss://api.openai.com/v1/live/sessions/${remote}/attach`)
      const path = new URL(url)
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path.pathname}${path.search}`, options)
      state.control = socket
      return socket
    },
    startup,
  )
  return {
    state,
    broker,
    binding,
    start: () =>
      broker.start(
        input,
        async () => ({
          key: "openai-only",
          voice: "marin",
          backend: server.url.origin,
          authorization: "Basic backend-only",
          directory: "C:/project",
          current: () => state.current,
          context: state.context,
          started: () => {
            state.started += 1
          },
          usage: (value) => state.usage.push(value),
        }),
        (value) => state.ready.push(value),
        (value) => state.errors.push(value),
      ),
    send: (value: unknown) => state.socket!.send(JSON.stringify(value)),
    close: async () => {
      await broker.dispose()
      await server.stop(true)
    },
  }
}

function started() {
  return { type: "session.started", session: { id: remote, model: OPENAI_LIVE_MODEL } }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Expected transport event did not arrive")
    await Bun.sleep(10)
  }
}

test("Live creation forbids client mutation events and delivers SDP before session.started", async () => {
  const f = fixture()
  try {
    await f.start()
    expect(f.state.ready).toEqual([{ sdp, providerSessionID: remote }])
    expect(f.state.started).toBe(0)
    expect(f.state.session).toMatchObject({
      model: OPENAI_LIVE_MODEL,
      store: false,
      delegation: { type: "client" },
      client: { data_channel: { allowed_client_events: [] } },
    })
    expect(JSON.stringify(f.state.session)).toContain("session.delegation.created")
    expect(JSON.stringify(f.state.session)).not.toContain("openai-only")
    expect(JSON.stringify(f.state.requests)).not.toContain("openai-only")
    expect(await f.broker.control(input.requestID, "mute_1", "mute")).toEqual({
      status: "failed",
      error: "Live voice is not ready in this task.",
    })
    expect(f.state.events).toEqual([])
    f.send(started())
    await until(() => f.state.started === 1)
    expect(f.state.ready).toHaveLength(1)
    const mute = f.broker.control(input.requestID, "mute_1", "mute")
    await until(() => f.state.events.some((event) => event.type === "session.input_audio.mute"))
    expect(f.state.events).toContainEqual({ type: "session.input_audio.mute", event_id: "mute_1" })
    f.send({ type: "session.input_audio.muted", client_event_id: "mute_1" })
    expect(await mute).toEqual({ status: "accepted" })
    expect(await f.broker.control("other", "mute_2", "mute")).toEqual({
      status: "failed",
      error: "Live voice is not ready in this task.",
    })
    await f.broker.stop("other_request")
    expect(f.broker.active).toBe(true)
    await f.broker.stop(input.requestID)
    expect(f.broker.active).toBe(false)
    expect(f.state.requests.some((request) => request.path.endsWith("/hangup"))).toBe(true)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
    expect(f.state.errors).toEqual([])
  } finally {
    await f.close()
  }
})

test("missing session.started closes the paid call through a host timeout", async () => {
  const f = fixture(80)
  try {
    await f.start()
    expect(f.state.ready).toEqual([{ sdp, providerSessionID: remote }])
    expect(f.state.started).toBe(0)
    await until(() => !f.broker.active)
    expect(f.state.errors[0]).toContain("did not become ready")
    expect(f.state.started).toBe(0)
    expect(f.state.events.some((event) => event.type === "session.close")).toBe(true)
    expect(f.state.requests.some((request) => request.path.endsWith("/hangup"))).toBe(true)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
    expect(f.state.usage.at(-1)).toMatchObject({ recorded: false, incomplete: true })
  } finally {
    await f.close()
  }
})

test("session.closed duration is recorded without reopening work", async () => {
  const f = fixture()
  try {
    await f.start()
    f.send(started())
    await until(() => f.state.started === 1)
    f.send({
      type: "session.closed",
      event_id: "evt_duration_1",
      session: { id: remote, model: OPENAI_LIVE_MODEL },
      usage: { seconds: 4 },
    })
    await until(() => f.state.requests.some((request) => request.path.endsWith("/duration")))
    const receipt = f.state.requests.find((request) => request.path.endsWith("/duration"))!.body.receipt as Record<
      string,
      unknown
    >
    expect(receipt).toEqual({ id: "evt_duration_1", model: OPENAI_LIVE_MODEL, seconds: 4 })
    expect(f.state.requests.some((request) => request.path.includes("/calls"))).toBe(false)
    await until(() => f.state.usage.some((item) => item.recorded))
    expect(f.state.usage.some((item) => item.seconds === 4 && item.final && item.recorded)).toBe(true)
    await until(() => !f.broker.active)
    expect(f.state.requests.filter((request) => request.path.endsWith("/duration"))).toHaveLength(1)
  } finally {
    await f.close()
  }
})

function request(f: ReturnType<typeof fixture>, key = "dlg_1") {
  f.send({
    type: "session.input_transcript.delta",
    event_id: "evt_user_1",
    delta: "Please summarize the current file",
    start_ms: 0,
    end_ms: 900,
  })
  f.send({
    type: "session.delegation.created",
    event_id: "evt_dlg_1",
    offset_ms: 900,
    delegation: { id: key, type: "delegation", target: "client" },
  })
}

test("staging an image does not dispatch work; later delegation narrates only a validated result", async () => {
  const f = fixture()
  try {
    await f.start()
    expect(await f.broker.share(input.requestID, "img_1", "data:image/png;base64,aaaa")).toEqual({
      status: "failed",
      error: "Start Live voice in this task before staging an image.",
    })
    f.send(started())
    await until(() => f.state.started === 1)
    const share = f.broker.share(input.requestID, "img_1", "data:image/png;base64,aaaa")
    await until(() => f.state.requests.some((item) => item.path.endsWith("/images")))
    expect(await share).toEqual({ status: "staged" })
    expect(f.state.requests.some((item) => item.path.includes("/calls"))).toBe(false)
    request(f)
    await until(() => f.state.requests.some((item) => item.path.includes("/calls")))
    const body = f.state.requests.find((item) => item.path.includes("/calls"))!.body
    expect(body.images).toEqual(["img_1"])
    expect(body.context).toMatchObject({ version: 1, delegation: "dlg_1", incomplete: true })
    await until(() =>
      f.state.events.some(
        (event) => event.type === "session.commentary.append" && String(event.content).includes("Verified Live result"),
      ),
    )
    expect(f.state.requests.filter((item) => item.path.includes("/calls"))).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("failed Live work is narrated as a status, not a successful result", async () => {
  const f = fixture()
  f.state.mode = "failed-work"
  try {
    await f.start()
    f.send(started())
    await until(() => f.state.started === 1)
    request(f)
    await until(() =>
      f.state.events.some(
        (event) => event.type === "session.commentary.append" && String(event.content).includes("failed"),
      ),
    )
    expect(f.state.events.some((event) => String(event.content).includes("Verified Live result"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("a later conflicting session.closed does not post a second duration", async () => {
  const f = fixture()
  try {
    await f.start()
    f.send(started())
    await until(() => f.state.started === 1)
    f.send({
      type: "session.closed",
      event_id: "evt_duration_1",
      session: { id: remote, model: OPENAI_LIVE_MODEL },
      usage: { seconds: 4 },
    })
    f.send({
      type: "session.closed",
      event_id: "evt_duration_2",
      session: { id: remote, model: OPENAI_LIVE_MODEL },
      usage: { seconds: 9 },
    })
    await until(() => f.state.usage.some((item) => item.recorded && item.incomplete))
    expect(f.state.requests.filter((item) => item.path.endsWith("/duration"))).toHaveLength(1)
    await until(() => !f.broker.active)
  } finally {
    await f.close()
  }
})

test("image identity cannot change and four attempts are retained without dispatching work", async () => {
  const png = "data:image/png;base64,aaaa"
  const other = "data:image/png;base64,bbbb"
  const f = fixture()
  try {
    await f.start()
    f.send(started())
    await until(() => f.state.started === 1)
    const first = f.broker.share(input.requestID, "img_1", png)
    await until(() => f.state.requests.some((item) => item.path.endsWith("/images")))
    expect(await first).toEqual({ status: "staged" })
    expect(await f.broker.share(input.requestID, "img_1", png)).toEqual({ status: "staged" })
    expect(f.state.requests.filter((item) => item.path.endsWith("/images"))).toHaveLength(1)
    expect(await f.broker.share(input.requestID, "img_1", other)).toEqual({
      status: "failed",
      error: "Image identity was reused.",
    })
    expect(f.state.requests.filter((item) => item.path.endsWith("/images"))).toHaveLength(1)
    expect(f.state.requests.some((item) => item.path.includes("/calls"))).toBe(false)
    for (const id of ["img_2", "img_3", "img_4"]) {
      const share = f.broker.share(input.requestID, id, png)
      await until(
        () => f.state.requests.filter((item) => item.path.endsWith("/images") && item.body.id === id).length === 1,
      )
      expect(await share).toEqual({ status: "staged" })
    }
    expect(await f.broker.share(input.requestID, "img_5", png)).toEqual({
      status: "failed",
      error: "This call already has four image attempts. Start a fresh call to select more.",
    })
    expect(f.state.requests.filter((item) => item.path.endsWith("/images"))).toHaveLength(4)
  } finally {
    await f.close()
  }
})

test("a mismatched Live image receipt is retained as unknown and invalid bytes never reach storage", async () => {
  const f = fixture()
  try {
    await f.start()
    f.send(started())
    await until(() => f.state.started === 1)
    for (const data of [
      "https://invalid.test/image.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,YQ==",
    ])
      expect((await f.broker.share(input.requestID, "bad_1", data)).status).toBe("failed")
    expect(f.state.requests.some((item) => item.path.endsWith("/images"))).toBe(false)
    f.state.mode = "image-receipt"
    expect((await f.broker.share(input.requestID, "img_1", "data:image/png;base64,aaaa")).status).toBe("unknown")
    expect(await f.broker.share(input.requestID, "img_1", "data:image/png;base64,aaaa")).toMatchObject({
      status: "unknown",
    })
    expect(f.state.requests.filter((item) => item.path.endsWith("/images"))).toHaveLength(1)
    expect(f.state.requests.some((item) => item.path.includes("/calls"))).toBe(false)
    expect(f.state.events.some((event) => event.type === "session.thinking.append")).toBe(false)
  } finally {
    await f.close()
  }
})

test("late session.started after stop cannot revive the call", async () => {
  const f = fixture()
  try {
    await f.start()
    await f.broker.stop(input.requestID)
    expect(f.broker.active).toBe(false)
    f.send(started())
    await Bun.sleep(40)
    expect(f.state.started).toBe(0)
    expect(f.broker.active).toBe(false)
    expect(await f.broker.control(input.requestID, "mute_1", "mute")).toEqual({
      status: "failed",
      error: "Live voice is not ready in this task.",
    })
  } finally {
    await f.close()
  }
})
