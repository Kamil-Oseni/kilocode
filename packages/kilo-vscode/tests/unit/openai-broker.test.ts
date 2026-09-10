import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import WebSocket from "ws"
import { OpenAIBroker } from "../../src/speech/openai-broker"
import { OPENAI_VOICE_MODEL } from "../../src/shared/speech"

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
const input = { requestID: "request_1", sessionID: "session_1", sdp }

// Real loopback HTTP + WebSocket transports; only the remote provider and backend
// boundary are fixtures. The production broker performs admission and dispatch.
function fixture() {
  const state = {
    mode: "normal",
    current: true,
    ready: [] as string[],
    errors: [] as string[],
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
    capability: "",
    pending: undefined as string | undefined,
    released: new Set<string>(),
    polls: [] as string[],
    conflicts: 0,
    form: undefined as Record<string, unknown> | undefined,
  }
  const binding = {
    id: "binding_1",
    generation: "generation_1",
    parentSessionID: input.sessionID,
    providerCallID: "rtc_provider_1",
    status: "active",
    directory: "C:/project",
    model: OPENAI_VOICE_MODEL,
  }
  const work = (request: Request, url: URL, body: Record<string, unknown>) => {
    if (url.pathname.endsWith("/calls")) {
      expect(body.generation).toBe(binding.generation)
      if (typeof body.callID !== "string") return new Response("invalid call", { status: 400 })
      if (state.mode === "pending") {
        if (state.pending) {
          state.conflicts++
          return new Response("one pending call per binding", { status: 409 })
        }
        state.pending = body.callID
      }
      return Response.json({
        id: `work_${body.callID}`,
        callID: body.callID,
        messageID: `message_${body.callID}`,
        parentSessionID: state.mode === "receipt" ? "unrelated" : input.sessionID,
        status: state.mode === "pending" ? "accepted" : "completed",
        result: { text: "Verified result", assistantMessageID: "assistant_1", evidence: [] },
      })
    }
    if (request.method !== "GET") return new Response("unexpected", { status: 404 })
    const id = url.pathname.split("/").at(-1)!
    state.polls.push(id)
    const done = state.released.has(id)
    if (done && state.pending === id) state.pending = undefined
    return Response.json({
      id: `work_${id}`,
      callID: id,
      messageID: `message_${id}`,
      parentSessionID: input.sessionID,
      status: done ? "completed" : "running",
      ...(done ? { result: { text: `Verified ${id}`, assistantMessageID: `assistant_${id}`, evidence: [] } } : {}),
    })
  }
  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/realtime") {
        expect(request.headers.get("authorization")).toBe("Bearer openai-only")
        expect(url.searchParams.get("call_id")).toBe(binding.providerCallID)
        if (server.upgrade(request)) return
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/v1/realtime/calls") {
        expect(request.headers.get("authorization")).toBe("Bearer openai-only")
        expect(request.headers.get("X-Raya-Voice-Key")).toBeNull()
        const form = await request.formData()
        expect(form.get("sdp")).toBe(sdp)
        state.form = JSON.parse(String(form.get("session"))) as Record<string, unknown>
        if (state.mode === "rejected") return new Response("denied", { status: 401 })
        return new Response(sdp, {
          status: 201,
          headers: {
            Location:
              state.mode === "location"
                ? "https://untrusted.invalid/v1/realtime/calls/rtc_provider_1"
                : "/v1/realtime/calls/rtc_provider_1",
          },
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
      if (url.pathname.includes("/calls")) return work(request, url, body)
      return new Response("unexpected", { status: 404 })
    },
    websocket: {
      open(socket) {
        state.socket = socket
      },
      message(socket, value) {
        const event = JSON.parse(String(value)) as Record<string, unknown>
        state.events.push(event)
        if (event.type === "session.update")
          socket.send(JSON.stringify({ type: "session.updated", session: event.session }))
      },
    },
  })
  const request: typeof fetch = (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value)
    expect(["https://api.openai.com", server.url.origin]).toContain(url.origin)
    return fetch(new URL(url.pathname + url.search, server.url), init)
  }
  const broker = new OpenAIBroker(request, (url, options) => {
    expect(url.startsWith("wss://api.openai.com/v1/realtime?")).toBe(true)
    const path = new URL(url)
    return new WebSocket(`ws://127.0.0.1:${server.port}${path.pathname}${path.search}`, options)
  })
  return {
    state,
    broker,
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

function completed(id = "call_1", request = "Inspect the workspace") {
  return {
    type: "response.done",
    response: {
      id: `response_${id}`,
      status: "completed",
      output: [
        {
          type: "function_call",
          id: `item_${id}`,
          call_id: id,
          status: "completed",
          name: "raya_work",
          arguments: JSON.stringify({ request }),
        },
      ],
    },
  }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Expected transport event did not arrive")
    await Bun.sleep(10)
  }
}

test("OpenAI host keeps credentials isolated, dispatches only completed tool calls, deduplicates and closes admission", async () => {
  const f = fixture()
  try {
    await f.start()
    expect(f.state.ready).toEqual([sdp])
    expect(f.state.form).toMatchObject({ model: OPENAI_VOICE_MODEL, tools: [], audio: { output: { voice: "marin" } } })
    const ignored = completed()
    ignored.response.status = "cancelled"
    f.send(ignored)
    f.send({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "raya_work",
      arguments: '{"request":"Inspect"}',
    })
    f.send(completed())
    f.send(completed())
    await until(() => f.state.events.some((event) => event.type === "response.create"))
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    const output = f.state.events.filter((event) => event.type === "conversation.item.create")
    expect(output).toHaveLength(1)
    expect(JSON.stringify(output)).not.toContain("openai-only")
    expect(JSON.stringify(output)).not.toContain(f.state.capability)
    expect(JSON.stringify(output)).toContain("Verified result")
    await f.broker.stop("other_request")
    expect(f.broker.active).toBe(true)
    await f.broker.stop(input.requestID)
    expect(f.broker.active).toBe(false)
    expect(f.state.requests.filter((request) => request.path.endsWith("/hangup"))).toHaveLength(1)
    expect(f.state.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
    expect(f.state.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false)
    expect(f.state.errors).toEqual([])
  } finally {
    await f.close()
  }
})

test("multiple work outputs wait for active response and coalesce their audio continuation", async () => {
  const f = fixture()
  try {
    await f.start()
    f.send({ type: "response.created", response: { id: "speaking" } })
    f.send(completed("call_1"))
    f.send(completed("call_2"))
    await until(() => f.state.events.filter((event) => event.type === "conversation.item.create").length === 2)
    expect(f.state.events.filter((event) => event.type === "response.create")).toHaveLength(0)
    f.send({ type: "response.done", response: { id: "speaking", status: "completed", output: [] } })
    await until(() => f.state.events.some((event) => event.type === "response.create"))
    expect(f.state.events.filter((event) => event.type === "response.create")).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("one response with two work calls waits for each retained result before the next admission", async () => {
  const f = fixture()
  try {
    f.state.mode = "pending"
    await f.start()
    const response = completed("call_1")
    response.response.output.push(...completed("call_2").response.output)
    f.send(response)
    f.send(response)
    await until(() => f.state.polls.includes("call_1"))
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    expect(f.state.events.filter((event) => event.type === "conversation.item.create")).toHaveLength(0)
    f.state.released.add("call_1")
    await until(() =>
      f.state.requests.some((request) => request.path.endsWith("/calls") && request.body.callID === "call_2"),
    )
    expect(
      f.state.requests.filter((request) => request.path.endsWith("/calls")).map((request) => request.body.callID),
    ).toEqual(["call_1", "call_2"])
    expect(f.state.conflicts).toBe(0)
    f.state.released.add("call_2")
    await until(() => f.state.events.filter((event) => event.type === "conversation.item.create").length === 2)
    expect(f.state.errors).toEqual([])
  } finally {
    await f.close()
  }
}, 10_000)

test("ending voice fences queued work without cancelling the already-admitted parent call", async () => {
  const f = fixture()
  try {
    f.state.mode = "pending"
    await f.start()
    const response = completed("call_1")
    response.response.output.push(...completed("call_2").response.output)
    f.send(response)
    await until(() => f.state.polls.includes("call_1"))
    await f.broker.stop(input.requestID)
    f.state.released.add("call_1")
    await Bun.sleep(0)
    expect(f.broker.active).toBe(false)
    expect(
      f.state.requests.filter((request) => request.path.endsWith("/calls")).map((request) => request.body.callID),
    ).toEqual(["call_1"])
    expect(f.state.events.some((event) => event.type === "conversation.item.create")).toBe(false)
    expect(f.state.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
    expect(f.state.conflicts).toBe(0)
    expect(f.state.errors).toEqual([])
  } finally {
    await f.close()
  }
})

test("workspace changes and unrelated work receipts cannot publish or dispatch trusted results", async () => {
  const f = fixture()
  try {
    f.state.mode = "receipt"
    await f.start()
    f.send(completed())
    await until(() => f.state.errors.length > 0)
    expect(f.state.events.some((event) => event.type === "conversation.item.create")).toBe(false)
    f.state.current = false
    f.send(completed("call_2"))
    await until(() => !f.broker.active)
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    expect(f.state.requests.some((request) => request.path.endsWith("/hangup"))).toBe(true)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
  } finally {
    await f.close()
  }
})

test("idle voice closes when its backend generation becomes stale", async () => {
  const f = fixture()
  try {
    await f.start()
    f.state.current = false
    await until(() => !f.broker.active)
    expect(f.state.errors).toHaveLength(1)
    expect(f.state.errors[0]).toContain("backend changed")
    expect(f.state.requests.some((request) => request.path.endsWith("/hangup"))).toBe(true)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
  } finally {
    await f.close()
  }
})

for (const mode of ["location", "binding", "cleanup", "rejected"]) {
  test(`voice ${mode} failure retains uncertain ownership without automatic replay`, async () => {
    const f = fixture()
    try {
      f.state.mode = mode
      await f.start()
      if (mode === "cleanup") expect(await f.broker.stop(input.requestID)).toContain("unconfirmed")
      expect(f.broker.active).toBe(mode !== "rejected")
      if (mode !== "cleanup") expect(f.state.ready).toEqual([])
      const count = f.state.requests.length
      if (mode !== "rejected") {
        await f.start()
        expect(f.state.requests).toHaveLength(count)
        expect(f.state.errors.at(-1)).toContain("already owns")
      }
    } finally {
      await f.close()
    }
  })
}

test("stopping an in-flight configuration prevents a later call from starting", async () => {
  const f = fixture()
  try {
    const config = Promise.withResolvers<Awaited<ReturnType<Parameters<OpenAIBroker["start"]>[1]>>>()
    const start = f.broker.start(
      input,
      () => config.promise,
      (value) => f.state.ready.push(value),
      (value) => f.state.errors.push(value),
    )
    const stop = f.broker.stop(input.requestID)
    config.resolve({
      key: "openai-only",
      voice: "marin",
      backend: "http://127.0.0.1",
      authorization: "Basic backend-only",
      directory: "C:/project",
      current: () => true,
    })
    await Promise.all([start, stop])
    expect(f.state.requests).toEqual([])
    expect(f.state.ready).toEqual([])
    expect(f.broker.active).toBe(false)
  } finally {
    await f.close()
  }
})
