import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import WebSocket from "ws"
import { OpenAIBroker } from "../../src/speech/openai-broker"
import { OPENAI_VOICE_MODEL } from "../../src/shared/speech"
import type { VoiceUsage } from "../../src/shared/voice-usage"
import { route } from "../../src/services/voice-handoff"

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
const input = { requestID: "request_1", sessionID: "session_1", sdp }

function admission(
  mode: string,
  path: string,
  method: string,
  body: Record<string, unknown>,
  binding: Record<string, unknown>,
) {
  if (
    path.endsWith("/reservation/release") &&
    body.model === "gpt-live-transcribe" &&
    ["transcription-offline", "transcription-timeout", "transcription-rejected"].includes(mode)
  )
    return new Response("reservation not found", { status: 409 })
  if (path.endsWith("/reservation/release"))
    return Response.json({ requestID: body.requestID, model: body.model, status: "released" })
  if (path.endsWith("/reservation")) {
    if (mode === "reservation-rejected" || (mode === "transcription-rejected" && body.model === "gpt-live-transcribe"))
      return new Response("budget refused", { status: 409 })
    const malformed =
      mode === "reservation-malformed" || (mode === "transcription-malformed" && body.model === "gpt-live-transcribe")
    return Response.json({
      requestID: malformed ? "other" : body.requestID,
      model: body.model,
      status: "reserved",
      ...(body.model === "gpt-live-transcribe"
        ? {
            amount: 0.6,
            currency: "USD",
            maximumSeconds: mode === "transcription-short" ? 15 : mode === "transcription-deadline" ? 16 : 2117,
          }
        : {}),
    })
  }
  if (method === "DELETE") return Response.json({ ...binding, status: "closed" })
}

// Real loopback HTTP + WebSocket transports; only the remote provider and backend
// boundary are fixtures. The production broker performs admission and dispatch.
function fixture(timeout = 15_000) {
  const state = {
    mode: "normal",
    current: true,
    context: JSON.stringify({ source: "saved_task_context", messages: [{ role: "user", text: "Historical task" }] }),
    ready: [] as string[],
    errors: [] as string[],
    attempts: [] as { path: string; body: Record<string, unknown> }[],
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
    pending: undefined as string | undefined,
    released: new Set<string>(),
    polls: [] as string[],
    conflicts: 0,
    form: undefined as Record<string, unknown> | undefined,
    order: [] as string[],
    usage: undefined as VoiceUsage | undefined,
    history: [] as { bindingID: string; itemID: string; role: "user" | "assistant"; text: string }[],
    spoken: [] as Record<string, unknown>[],
    committed: new Map<number, string>(),
    lost: false,
    reading: false,
    delayed: 0,
    gate: Promise.withResolvers<void>(),
    sockets: [] as ServerWebSocket<undefined>[],
    controls: [] as WebSocket[],
    providers: 0,
    activated: 0,
    proof: undefined as Record<string, unknown> | undefined,
    proofs: new Map<string, Record<string, unknown>>(),
    handoff: "",
    activation: undefined as Record<string, unknown> | undefined,
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
  const history = (url: URL, body: Record<string, unknown>, owner = binding) => {
    if (url.pathname.endsWith("/context")) {
      expect(url.searchParams.get("generation")).toBe(binding.generation)
      return Response.json({ version: 1, items: state.history, incomplete: false })
    }
    if (url.pathname.endsWith("/spoken")) {
      expect(body.generation).toBe(owner.generation)
      expect(body.providerCallID).toBe(owner.providerCallID)
      state.spoken.push(body)
      if (state.mode === "spoken-refused") return new Response("snapshot refused", { status: 409 })
      if (state.mode === "spoken-unavailable") return new Response("temporarily unavailable", { status: 503 })
      const revision = Number(body.revision)
      const encoded = JSON.stringify(body)
      if (owner.id === binding.id) {
        if (state.committed.has(revision)) expect(encoded).toBe(state.committed.get(revision))
        else state.committed.set(revision, encoded)
      }
      if (state.mode === "spoken-malformed")
        return new Response("{malformed", { headers: { "content-type": "application/json" } })
      if (state.mode === "spoken-body") {
        state.reading = true
        let cancelled = false
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(Buffer.from(" "))
              await state.gate.promise
              if (cancelled) return
              controller.enqueue(
                Buffer.from(JSON.stringify({ version: 1, revision: body.revision, updatedAt: Date.now() })),
              )
              controller.close()
            },
            cancel() {
              cancelled = true
            },
          }),
        )
      }
      return Response.json({
        version: 1,
        revision: state.mode === "spoken-receipt" ? 999 : body.revision,
        updatedAt: Date.now(),
      })
    }
  }
  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/v1/realtime") {
        expect(request.headers.get("authorization")).toBe("Bearer openai-only")
        if (state.mode.startsWith("warm"))
          expect(["rtc_provider_1", "rtc_provider_2"]).toContain(url.searchParams.get("call_id"))
        else expect(url.searchParams.get("call_id")).toBe(binding.providerCallID)
        if (server.upgrade(request)) return
        return new Response("upgrade failed", { status: 400 })
      }
      if (url.pathname === "/v1/realtime/calls") {
        state.order.push("provider")
        expect(request.headers.get("authorization")).toBe("Bearer openai-only")
        expect(request.headers.get("X-Raya-Voice-Key")).toBeNull()
        const form = await request.formData()
        expect(form.get("sdp")).toBe(sdp)
        state.form = JSON.parse(String(form.get("session"))) as Record<string, unknown>
        if (state.mode === "rejected") return new Response("denied", { status: 401 })
        const id = state.mode.startsWith("warm") ? `rtc_provider_${++state.providers}` : "rtc_provider_1"
        return new Response(sdp, {
          status: 201,
          headers: {
            Location:
              state.mode === "location"
                ? "https://untrusted.invalid/v1/realtime/calls/rtc_provider_1"
                : `/v1/realtime/calls/${id}`,
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
      state.order.push(url.pathname)
      if (url.pathname.endsWith("/hangup")) {
        if (state.mode === "warm-cancel" && url.pathname.includes("rtc_provider_2")) {
          state.reading = true
          await state.gate.promise
        }
        return new Response(null, { status: state.mode === "cleanup" ? 503 : 200 })
      }
      expect(request.headers.get("authorization")).toBe("Basic backend-only")
      expect(url.searchParams.get("directory")).toBe("C:/project")
      const capability = request.headers.get("X-Raya-Voice-Key")
      expect(capability).toMatch(/^[a-f0-9]{64}$/)
      if (!state.capability) state.capability = capability!
      if (!state.mode.startsWith("warm")) expect(capability).toBe(state.capability)
      const target = { ...binding, id: "binding_2", generation: "generation_2", providerCallID: "rtc_provider_2" }
      const owner = url.pathname.includes("binding_2") ? target : binding
      if (url.pathname.endsWith("/handoff/candidate")) {
        state.handoff = String(body.requestID)
        expect(capability).toBe(state.capability)
        expect(request.headers.get("X-Raya-Voice-Target-Key")).toMatch(/^[a-f0-9]{64}$/)
        expect(request.headers.get("X-Raya-Voice-Target-Key")).not.toBe(capability)
        return Response.json({
          ...target,
          handoff: {
            version: 1,
            requestID: body.requestID,
            sourceID: binding.id,
            sourceGeneration: binding.generation,
            candidateID: target.id,
            candidateGeneration: target.generation,
            phase: "candidate",
          },
        })
      }
      if (url.pathname.endsWith("/handoff/context")) {
        const spoken = state.spoken.filter((row) => row.providerCallID === binding.providerCallID).at(-1)!
        const items = spoken.items as {
          id: string
          previous: string | null
          role: "user" | "assistant"
          state: string
          text?: string
        }[]
        const canonical = {
          revision: spoken.revision,
          incomplete: spoken.incomplete,
          items: items.map((item) => ({
            id: item.id,
            previous: item.previous,
            role: item.role,
            state: item.state,
            ...(item.text !== undefined ? { text: item.text } : {}),
          })),
        }
        return Response.json({
          version: 1,
          sourceID: binding.id,
          sourceGeneration: binding.generation,
          sourceRevision: spoken.revision,
          sourceHash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
          incomplete: spoken.incomplete,
          items: items
            .filter((item) => item.state === "final")
            .map((item) => ({ itemID: item.id, role: item.role, text: item.text })),
        })
      }
      if (url.pathname.endsWith("/handoff/ready") || url.pathname.endsWith("/handoff/rearm")) {
        if (state.mode === "warm-ready-offline") return new Response("ambiguous service failure", { status: 503 })
        if (state.mode === "warm-ready-refused") return new Response("definite refusal", { status: 409 })
        const id = String(body.readyID)
        const prior = state.proofs.get(id)
        if (prior) {
          for (const [key, value] of Object.entries(body)) expect(prior[key]).toEqual(value)
          return Response.json(url.pathname.endsWith("/rearm") ? prior : { ...target, handoff: prior })
        }
        state.proof = {
          ...body,
          requestID: state.handoff,
          sourceID: binding.id,
          sourceGeneration: binding.generation,
          candidateID: target.id,
          candidateGeneration: target.generation,
          ...(body.priorReadyID ? { rearmedAt: Date.now() } : { phase: "ready" }),
          deadline: state.proof?.deadline ?? Date.now() + 30_000,
          ...(state.mode === "warm-ready-changed" ? { sourceHash: "f".repeat(64) } : {}),
          ...(state.mode === "warm-ready-expired" ? { deadline: Date.now() - 1 } : {}),
        }
        if (state.mode === "warm-rearm-deadline" && body.priorReadyID)
          state.proof.deadline = Number(state.proof.deadline) + 1000
        state.proofs.set(id, state.proof)
        return Response.json(url.pathname.endsWith("/rearm") ? state.proof : { ...target, handoff: state.proof })
      }
      if (url.pathname.endsWith("/handoff/activate")) {
        state.activated++
        state.activation = {
          ...body,
          version: 1,
          sourceID: binding.id,
          sourceGeneration: binding.generation,
          activatedAt: Date.now(),
        }
        if (state.mode === "warm-lost") return new Response("lost acknowledgement", { status: 503 })
        return Response.json(state.activation)
      }
      if (url.pathname.endsWith("/handoff/receipt")) return Response.json(state.activation)
      if (url.pathname.endsWith("/spoken") && owner.id === target.id && !state.activated)
        return new Response("candidate spoken publication forbidden", { status: 409 })
      const admitted = admission(state.mode, url.pathname, request.method, body, owner)
      if (admitted) return admitted
      if (url.pathname.endsWith("/session"))
        return Response.json({ ...binding, parentSessionID: state.mode === "binding" ? "unrelated" : input.sessionID })
      if (url.pathname.endsWith("/usage")) return Response.json(body.receipt)
      const spoken = history(url, body, owner)
      if (spoken) return spoken
      if (url.pathname.endsWith("/images")) {
        expect(body.generation).toBe(binding.generation)
        const bytes = Buffer.from(String(body.data), "base64")
        return Response.json({
          id: body.id,
          mime: body.mime,
          bytes: bytes.length,
          sha256: state.mode === "image-receipt" ? "wrong" : createHash("sha256").update(bytes).digest("hex"),
        })
      }
      if (url.pathname.includes("/calls")) return work(request, url, body)
      return new Response("unexpected", { status: 404 })
    },
    websocket: {
      open(socket) {
        state.socket = socket
        state.sockets.push(socket)
      },
      message(socket, value) {
        const event = JSON.parse(String(value)) as Record<string, unknown>
        state.events.push(event)
        if (
          state.mode === "warm-setup" &&
          event.type === "session.update" &&
          (event.session as { tools: unknown[] }).tools.length === 0
        ) {
          socket.send(JSON.stringify({ type: "error", error: { code: "configuration_refused" } }))
          return
        }
        if (event.type === "session.update" && state.mode !== "unconfirmed-config")
          socket.send(JSON.stringify({ type: "session.updated", session: event.session }))
        const item = event.item as Record<string, unknown> | undefined
        if (
          event.type === "conversation.item.create" &&
          (String(item?.id).startsWith("raya_context_") || String(item?.id).startsWith("raya_semantic_"))
        ) {
          if (state.mode === "context-rejected") {
            socket.send(JSON.stringify({ type: "error", error: { event_id: event.event_id, code: "invalid_request" } }))
            return
          }
          if (state.mode !== "context-pending") socket.send(JSON.stringify({ type: "conversation.item.done", item }))
        }
        if (event.type === "conversation.item.create" && item?.type === "function_call_output") {
          if (state.mode === "output-rejected") {
            socket.send(JSON.stringify({ type: "error", error: { event_id: event.event_id, code: "invalid_request" } }))
            return
          }
          if (state.mode !== "output-pending") socket.send(JSON.stringify({ type: "conversation.item.done", item }))
        }
      },
    },
  })
  const request: typeof fetch = (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value)
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    state.attempts.push({ path: url.pathname, body })
    expect(["https://api.openai.com", server.url.origin]).toContain(url.origin)
    const transcription = body.model === "gpt-live-transcribe"
    if (
      (state.mode === "reservation-offline" || (state.mode === "transcription-offline" && transcription)) &&
      url.pathname.endsWith("/reservation")
    )
      return Promise.reject(new Error("backend offline"))
    if (
      (state.mode === "reservation-timeout" || (state.mode === "transcription-timeout" && transcription)) &&
      url.pathname.endsWith("/reservation")
    )
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    return fetch(new URL(url.pathname + url.search, server.url), init).then(async (response) => {
      const readiness = url.pathname.endsWith("/handoff/ready") || url.pathname.endsWith("/handoff/rearm")
      const lost =
        (state.mode === "warm-ready-lost" && url.pathname.endsWith("/ready")) ||
        (state.mode === "warm-rearm-lost" && url.pathname.endsWith("/rearm"))
      if (readiness && lost && !state.lost) {
        state.lost = true
        await response.body?.cancel()
        throw new Error("Lost readiness response after actual loopback commit")
      }
      if (readiness && ["warm-ready-stop", "warm-ready-scope"].includes(state.mode)) {
        state.reading = true
        await state.gate.promise
        await response.body?.cancel()
        throw new Error("Readiness response lost across source invalidation")
      }
      if (!url.pathname.endsWith("/spoken")) return response
      if (state.mode === "spoken-lag") {
        const deadline = performance.now() + timeout + 20
        while (performance.now() < deadline) state.delayed++
      }
      if (
        ["spoken-cancel-refused", "spoken-cancel-limit", "spoken-hang-refused", "spoken-hang-limit"].includes(
          state.mode,
        )
      ) {
        await response.body?.cancel()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.alloc(state.mode.endsWith("limit") ? 262_145 : 1))
            },
            cancel() {
              if (state.mode.startsWith("spoken-hang")) return Promise.withResolvers<void>().promise
              throw new Error("Synthetic stream cancellation failure")
            },
          }),
          { status: state.mode.endsWith("refused") ? 409 : 200 },
        )
      }
      if (state.mode === "spoken-timeout") {
        await response.body?.cancel()
        return new Promise<Response>((_, reject) => {
          if (init?.signal?.aborted) return reject(init.signal.reason)
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      }
      if ((state.mode === "spoken-lost" || state.mode === "spoken-stale") && !state.lost) {
        state.lost = true
        await response.body?.cancel()
        if (state.mode === "spoken-stale") state.current = false
        throw new Error("Synthetic lost response after actual loopback commit")
      }
      return response
    })
  }
  const broker = new OpenAIBroker(
    request,
    (url, options) => {
      expect(url.startsWith("wss://api.openai.com/v1/realtime?")).toBe(true)
      const path = new URL(url)
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path.pathname}${path.search}`, options)
      state.control = socket
      state.controls.push(socket)
      return socket
    },
    80,
    80,
    timeout,
  )
  const send = (value: unknown) => state.socket!.send(JSON.stringify(value))
  const begin = async (id: string) => {
    const count = state.events.filter((event) => event.type === "response.create").length
    send({ type: "input_audio_buffer.speech_stopped" })
    await until(() => state.events.filter((event) => event.type === "response.create").length > count)
    const created = state.events.filter((event) => event.type === "response.create").at(-1)!
    const metadata = (created.response as Record<string, unknown>).metadata
    send({ type: "response.created", response: { id, metadata } })
    return metadata
  }
  const complete = async (value: ReturnType<typeof completed>) => {
    const metadata = await begin(value.response.id)
    const event = { ...value, response: { ...value.response, metadata } }
    send(event)
    return event
  }
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
          context: state.context,
          usage: (value) => (state.usage = value),
        }),
        (value) => state.ready.push(value),
        (value) => state.errors.push(value),
      ),
    send,
    begin,
    complete,
    close: async () => {
      await broker.dispose()
      if (state.mode.startsWith("warm")) {
        for (const socket of state.sockets) socket.terminate()
        await until(() => server.pendingWebSockets === 0)
      }
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

function generated(state: { events: Record<string, unknown>[] }) {
  return state.events.filter((event) => {
    if (event.type !== "response.create" || !event.response || typeof event.response !== "object") return false
    const metadata = (event.response as Record<string, unknown>).metadata
    return !!metadata && typeof metadata === "object" && "raya_kind" in metadata
  })
}

test("saved task context requires exact completed acknowledgement and cannot replay historical work", async () => {
  const f = fixture()
  try {
    f.state.mode = "context-pending"
    const start = f.start()
    await until(() => f.state.events.some((event) => String(event.event_id).startsWith("raya_context_")))
    const event = f.state.events.find((event) => String(event.event_id).startsWith("raya_context_"))!
    const item = event.item as Record<string, unknown>
    f.send({ type: "conversation.item.done", item: { ...item, id: "foreign" } })
    f.send({ type: "conversation.item.added", item })
    f.send(completed())
    f.send({
      type: "session.updated",
      session: f.state.events.find((event) => event.type === "session.update")!.session,
    })
    await Bun.sleep(30)
    expect(f.state.ready).toEqual([])
    expect(f.state.events.filter((event) => String(event.event_id).startsWith("raya_context_"))).toHaveLength(2)
    expect(f.state.requests.some((request) => request.path.endsWith("/calls"))).toBe(false)
    expect(f.state.events.some((event) => event.type === "response.create")).toBe(false)
    expect(item.content).toEqual([{ type: "input_text", text: f.state.context }])
    f.send({ type: "conversation.item.done", item })
    await Bun.sleep(20)
    expect(f.state.ready).toEqual([])
    const spoken = f.state.events.filter((event) => String(event.event_id).startsWith("raya_context_"))[1]!.item
    f.send({ type: "conversation.item.done", item: spoken })
    await start
    expect(f.state.ready).toEqual([sdp])
    f.send({ type: "conversation.item.done", item })
    await Bun.sleep(20)
    expect(f.state.requests.some((request) => request.path.endsWith("/calls"))).toBe(false)
    expect(f.state.events.some((event) => event.type === "response.create")).toBe(false)
    expect(f.state.ready).toHaveLength(1)
  } finally {
    await f.close()
  }
})

for (const mode of ["rejected", "mismatched", "cancelled", "disconnected", "timeout"]) {
  test(`context ${mode} cannot activate voice or submit work`, async () => {
    const f = fixture()
    try {
      f.state.mode = mode === "rejected" ? "context-rejected" : "context-pending"
      const start = f.start()
      await until(() => f.state.events.some((event) => String(event.event_id).startsWith("raya_context_")))
      const item = f.state.events.find((event) => String(event.event_id).startsWith("raya_context_"))!.item as Record<
        string,
        unknown
      >
      if (mode === "mismatched")
        f.send({
          type: "conversation.item.done",
          item: { ...item, content: [{ type: "input_text", text: "wrong context" }] },
        })
      if (mode === "cancelled") expect(await f.broker.stop(input.requestID)).toBeUndefined()
      if (mode === "disconnected") f.state.control!.terminate()
      await start
      expect(f.state.ready).toEqual([])
      expect(f.state.requests.some((request) => request.path.endsWith("/calls"))).toBe(false)
      expect(f.state.events.some((event) => event.type === "response.create")).toBe(false)
      expect(f.state.requests.some((request) => request.path.endsWith("/hangup"))).toBe(true)
      expect(f.broker.active).toBe(false)
      if (mode !== "cancelled") expect(f.state.errors).toHaveLength(1)
    } finally {
      await f.close()
    }
  }, 30_000)
}

test("oversized UTF-8 task context fails before creating a paid provider call", async () => {
  const f = fixture()
  try {
    f.state.context = "🟢".repeat(5000)
    await f.start()
    expect(f.state.form).toBeUndefined()
    expect(f.state.requests).toEqual([])
    expect(f.state.ready).toEqual([])
    expect(f.state.errors[0]).toContain("could not be confirmed")
  } finally {
    await f.close()
  }
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Expected transport event did not arrive")
    await Bun.sleep(10)
  }
}

test("recovered speech uses a separate acknowledged historical prefill without provenance or replay", async () => {
  const f = fixture()
  f.state.history.push({
    bindingID: "private_binding",
    itemID: "private_item",
    role: "user",
    text: "Prior spoken request",
  })
  try {
    await f.start()
    const items = f.state.events.filter((event) => event.type === "conversation.item.create")
    expect(items).toHaveLength(2)
    const encoded = JSON.stringify(items)
    expect(encoded).toContain("Prior spoken request")
    expect(encoded).not.toContain("private_binding")
    expect(encoded).not.toContain("private_item")
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(0)
    expect(f.state.spoken).toHaveLength(0)
  } finally {
    await f.close()
  }
})

test("trusted final transcripts persist in predecessor order and finish before binding closure", async () => {
  const f = fixture()
  try {
    await f.start()
    f.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "second", transcript: "Second" })
    f.send({ type: "input_audio_buffer.committed", item_id: "second", previous_item_id: "first" })
    f.send({ type: "input_audio_buffer.committed", item_id: "first", previous_item_id: null })
    f.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "First" })
    await until(
      () =>
        Array.isArray(f.state.spoken.at(-1)?.items) &&
        (f.state.spoken.at(-1)!.items as { text?: string }[]).at(-1)?.text === "Second",
    )
    expect(await f.broker.stop(input.requestID)).toBeUndefined()
    expect(f.state.spoken.at(-1)?.items).toEqual([
      { id: "first", previous: null, role: "user", state: "final", text: "First" },
      { id: "second", previous: "first", role: "user", state: "final", text: "Second" },
    ])
    const written = f.state.requests.findLastIndex((request) => request.path.endsWith("/spoken"))
    const closed = f.state.requests.findIndex((request) => request.method === "DELETE")
    expect(written).toBeLessThan(closed)
    expect(closed).toBeGreaterThan(0)
  } finally {
    await f.close()
  }
})

test("unconfirmed spoken persistence cannot close the binding as successfully settled", async () => {
  const f = fixture()
  f.state.mode = "spoken-receipt"
  try {
    await f.start()
    f.send({ type: "input_audio_buffer.committed", item_id: "first", previous_item_id: null })
    f.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "First" })
    await until(() => f.state.spoken.length > 0)
    await until(() => f.state.errors.some((error) => error.includes("Recent spoken context could not be saved")))
    expect(f.state.errors.filter((error) => error.includes("Recent spoken context could not be saved"))).toHaveLength(1)
    expect(await f.broker.stop(input.requestID)).toContain("Spoken context persistence remains unconfirmed")
    expect(f.state.requests.filter((request) => request.method === "DELETE")).toHaveLength(0)
    expect(f.state.spoken).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("a lost spoken acknowledgement retries the exact committed snapshot without advancing its revision", async () => {
  const f = fixture()
  f.state.mode = "spoken-lost"
  try {
    await f.start()
    f.send({ type: "input_audio_buffer.committed", item_id: "first", previous_item_id: null })
    f.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "First" })
    await until(() => f.state.spoken.length >= 2)
    expect(f.state.spoken[1]).toEqual(f.state.spoken[0])
    const revision = Number(f.state.spoken[0]!.revision)
    expect(f.state.spoken.filter((snapshot) => snapshot.revision === revision)).toHaveLength(2)
    expect(f.state.committed.get(revision)).toBe(JSON.stringify(f.state.spoken[0]))
    expect(await f.broker.stop(input.requestID)).toBeUndefined()
    expect(f.state.errors).toEqual([])
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
  } finally {
    await f.close()
  }
})

test("spoken persistence rejects invalid deadline options before creating a timer", () => {
  for (const timeout of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 15_001])
    expect(() => new OpenAIBroker(undefined, undefined, undefined, undefined, timeout)).toThrow(RangeError)
})

test("stale ending cleanup may publish once but never retries an uncertain acknowledgement", async () => {
  const f = fixture()
  f.state.mode = "spoken-lost"
  try {
    await f.start()
    f.state.current = false
    await until(() => f.state.errors.some((error) => error.includes("Recent spoken context could not be saved")))
    expect(f.state.spoken).toHaveLength(1)
    expect(await f.broker.stop(input.requestID)).toContain("Spoken context persistence remains unconfirmed")
    expect(f.state.requests.some((request) => request.path.endsWith("/hangup"))).toBe(true)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(false)
  } finally {
    await f.close()
  }
})

for (const mode of ["spoken-lost", "spoken-body"]) {
  for (const action of ["stop", "change"]) {
    test(`${action} during ${mode} preserves owned ending flush or rejects a changed generation`, async () => {
      const f = fixture()
      f.state.mode = mode
      try {
        await f.start()
        f.send({ type: "input_audio_buffer.committed", item_id: "first", previous_item_id: null })
        f.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "First" })
        await until(() => (mode === "spoken-lost" ? f.state.lost : f.state.reading))
        if (action === "change") f.state.current = false
        const stopped = action === "stop" ? f.broker.stop(input.requestID) : undefined
        f.state.gate.resolve()
        if (stopped) {
          expect(await stopped).toBeUndefined()
          expect(f.state.errors).toEqual([])
          expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
        } else {
          await until(() => f.state.errors.some((error) => error.includes("Recent spoken context could not be saved")))
          expect(f.state.spoken).toHaveLength(1)
          expect(await f.broker.stop(input.requestID)).toContain("Spoken context persistence remains unconfirmed")
          expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(false)
        }
      } finally {
        f.state.gate.resolve()
        await f.close()
      }
    })
  }
}

for (const mode of [
  "spoken-refused",
  "spoken-stale",
  "spoken-timeout",
  "spoken-unavailable",
  "spoken-malformed",
  "spoken-cancel-refused",
  "spoken-cancel-limit",
  "spoken-lag",
  "spoken-hang-refused",
  "spoken-hang-limit",
]) {
  test(`${mode} stops spoken retries at its definitive fence or fixed deadline`, async () => {
    const f = fixture(180)
    f.state.mode = mode
    try {
      await f.start()
      const started = performance.now()
      f.send({ type: "input_audio_buffer.committed", item_id: "first", previous_item_id: null })
      f.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "First" })
      await until(() => f.state.errors.some((error) => error.includes("Recent spoken context could not be saved")))
      expect(performance.now() - started).toBeLessThan(650)
      expect(f.state.spoken.length).toBeLessThanOrEqual(3)
      if (
        [
          "spoken-refused",
          "spoken-stale",
          "spoken-malformed",
          "spoken-cancel-refused",
          "spoken-cancel-limit",
          "spoken-lag",
          "spoken-hang-refused",
          "spoken-hang-limit",
        ].includes(mode)
      )
        expect(f.state.spoken).toHaveLength(1)
      expect(await f.broker.stop(input.requestID)).toContain("Spoken context persistence remains unconfirmed")
      expect(f.state.errors.filter((error) => error.includes("Recent spoken context could not be saved"))).toHaveLength(
        1,
      )
      expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(false)
    } finally {
      await f.close()
    }
  })
}

test("slow admitted work backgrounds without replay and final speech waits for user and playback", async () => {
  const f = fixture()
  try {
    f.state.mode = "pending"
    await f.start()
    const turn = completed()
    const turnMetadata = await f.begin(turn.response.id)
    f.send({ type: "input_audio_buffer.speech_started" })
    f.send({ ...turn, response: { ...turn.response, metadata: turnMetadata } })
    await until(() => f.state.pending === "call_1")
    await Bun.sleep(5100)
    expect(generated(f.state)).toHaveLength(0)
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    expect(f.state.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false)
    const userMetadata = await f.begin("user_turn")
    f.send({
      type: "response.done",
      response: { id: "user_turn", status: "completed", output: [], metadata: userMetadata },
    })
    await until(() => generated(f.state).length > 0)
    const narration = generated(f.state)[0]!
    const response = narration.response as Record<string, unknown>
    expect(response).toMatchObject({ conversation: "none", tools: [], tool_choice: "none" })
    expect(response.instructions).toContain("the user can keep talking")
    expect(response.instructions).toContain("The work is running")
    f.send({ type: "response.created", response: { id: "narration", metadata: response.metadata } })
    f.send({ type: "output_audio_buffer.started", response_id: "narration" })
    // Even a malformed provider response containing a tool is never work authority.
    f.send({
      type: "response.done",
      response: { ...completed("invented_work").response, id: "narration", metadata: response.metadata },
    })
    f.state.released.add("call_1")
    await until(() =>
      f.state.events.some(
        (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
      ),
    )
    expect(generated(f.state)).toHaveLength(1)
    f.send({ type: "output_audio_buffer.stopped", response_id: "narration" })
    await until(() => generated(f.state).length === 2)
    expect(generated(f.state)[1].response).toMatchObject({
      metadata: { raya_kind: "result" },
    })
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    expect(f.state.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false)
    expect(f.state.errors).toEqual([])
  } finally {
    await f.close()
  }
}, 15_000)

test("result speech requires the matching provider output acknowledgement", async () => {
  const f = fixture()
  try {
    f.state.mode = "output-pending"
    await f.start()
    await f.complete(completed())
    await until(() =>
      f.state.events.some(
        (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
      ),
    )
    const output = f.state.events.find(
      (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
    )!
    const item = output.item as Record<string, unknown>
    expect(item.id).toBe(output.event_id)
    expect(generated(f.state)).toHaveLength(0)
    f.send({ type: "conversation.item.created", item: { ...item, id: "unrelated" } })
    f.send({ type: "conversation.item.created", item })
    await until(() => generated(f.state).length > 0)
    f.send({ type: "conversation.item.created", item })
    await Bun.sleep(20)
    expect(generated(f.state)).toHaveLength(1)
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("rejected result delivery reports uncertainty without a continuation or work replay", async () => {
  const f = fixture()
  try {
    f.state.mode = "output-rejected"
    await f.start()
    await f.complete(completed())
    await until(() => f.state.errors.length > 0)
    expect(f.state.errors).toHaveLength(1)
    expect(f.state.errors[0]).toContain("could not receive a work result")
    expect(generated(f.state)).toHaveLength(0)
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    expect(f.state.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("OpenAI host keeps credentials isolated, dispatches only completed tool calls, deduplicates and closes admission", async () => {
  const f = fixture()
  try {
    await f.start()
    expect(f.state.ready).toEqual([sdp])
    expect(f.state.events.find((event) => event.type === "session.update")?.session).toMatchObject({
      audio: {
        input: {
          turn_detection: {
            type: "semantic_vad",
            eagerness: "auto",
            interrupt_response: false,
            create_response: false,
          },
        },
      },
    })
    expect(f.state.form).toMatchObject({ model: OPENAI_VOICE_MODEL, tools: [], audio: { output: { voice: "marin" } } })
    const ignored = completed()
    ignored.response.status = "cancelled"
    await f.complete(ignored)
    f.send({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "raya_work",
      arguments: '{"request":"Inspect"}',
    })
    const duplicate = await f.complete(completed())
    f.send(duplicate)
    await until(() => generated(f.state).length > 0)
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    const output = f.state.events.filter(
      (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
    )
    expect(output).toHaveLength(1)
    expect(JSON.stringify(output)).not.toContain("openai-only")
    expect(JSON.stringify(output)).not.toContain(f.state.capability)
    expect(JSON.stringify(output)).toContain("Verified result")
    await f.broker.stop("other_request")
    expect(f.broker.active).toBe(true)
    expect(await f.broker.stop(input.requestID)).toBeUndefined()
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
    const speaking = await f.begin("speaking")
    await f.complete(completed("call_1"))
    await f.complete(completed("call_2"))
    await until(
      () =>
        f.state.events.filter(
          (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
        ).length === 2,
    )
    expect(generated(f.state)).toHaveLength(0)
    f.send({ type: "response.done", response: { id: "speaking", status: "completed", output: [], metadata: speaking } })
    await until(() => generated(f.state).length > 0)
    expect(generated(f.state)).toHaveLength(1)
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
    const duplicate = await f.complete(response)
    f.send(duplicate)
    await until(() => f.state.polls.includes("call_1"))
    expect(f.state.requests.filter((request) => request.path.endsWith("/calls"))).toHaveLength(1)
    expect(
      f.state.events.filter(
        (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
      ),
    ).toHaveLength(0)
    f.state.released.add("call_1")
    await until(() =>
      f.state.requests.some((request) => request.path.endsWith("/calls") && request.body.callID === "call_2"),
    )
    expect(
      f.state.requests.filter((request) => request.path.endsWith("/calls")).map((request) => request.body.callID),
    ).toEqual(["call_1", "call_2"])
    expect(f.state.conflicts).toBe(0)
    f.state.released.add("call_2")
    await until(
      () =>
        f.state.events.filter(
          (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
        ).length === 2,
    )
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
    await f.complete(response)
    await until(() => f.state.polls.includes("call_1"))
    expect(await f.broker.stop(input.requestID)).toBeUndefined()
    f.state.released.add("call_1")
    await Bun.sleep(0)
    expect(f.broker.active).toBe(false)
    expect(
      f.state.requests.filter((request) => request.path.endsWith("/calls")).map((request) => request.body.callID),
    ).toEqual(["call_1"])
    expect(
      f.state.events.some(
        (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
      ),
    ).toBe(false)
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
    await f.complete(completed())
    await until(() => f.state.errors.length > 0)
    expect(
      f.state.events.some(
        (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
      ),
    ).toBe(false)
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
      expect(f.state.order.indexOf("/kilocode/voice/openai/reservation")).toBeLessThan(
        f.state.order.indexOf("provider"),
      )
      if (mode === "rejected") {
        expect(f.state.order.at(-1)).toBe("/kilocode/voice/openai/reservation/release")
        expect(f.state.requests.some((request) => request.path.endsWith("/session"))).toBe(false)
      }
      if (mode === "cleanup") expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(false)
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

test("the transcription allowance deadline closes the provider before it can exceed the saved hold", async () => {
  const f = fixture()
  try {
    f.state.mode = "transcription-deadline"
    await f.start()
    expect(f.broker.active).toBe(true)
    await until(() => !f.broker.active)
    expect(f.state.errors).toEqual([
      "Voice reached its saved transcription allowance and is closing. Review the conversation before reconnecting.",
    ])
    expect(f.state.order).toContain("provider")
    expect(f.state.requests.filter((request) => request.path.endsWith("/hangup"))).toHaveLength(1)
    expect(f.state.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("an unresolved provider receipt prevents backend closure and exact transcription settlement", async () => {
  const f = fixture()
  try {
    await f.start()
    f.send({ type: "input_audio_buffer.committed", item_id: "speech_unresolved" })
    await until(() => f.state.usage?.pending === 1)
    expect(await f.broker.stop(input.requestID)).toContain("usage settlement remains unconfirmed")
    expect(f.broker.active).toBe(true)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(false)
  } finally {
    await f.close()
  }
})

for (const mode of ["reservation-rejected", "reservation-malformed", "reservation-offline", "reservation-timeout"]) {
  test(`voice ${mode} never reaches the paid provider boundary`, async () => {
    const f = fixture()
    try {
      f.state.mode = mode
      await f.start()
      expect(f.state.order).not.toContain("provider")
      expect(f.state.ready).toEqual([])
      expect(f.broker.active).toBe(mode !== "reservation-rejected")
      if (mode !== "reservation-rejected") expect(f.state.errors.at(-1)).toContain("unconfirmed")
    } finally {
      await f.close()
    }
  })
}

for (const mode of [
  "transcription-rejected",
  "transcription-malformed",
  "transcription-offline",
  "transcription-timeout",
  "transcription-short",
]) {
  test(`voice ${mode} cannot cross the paid provider boundary`, async () => {
    const f = fixture()
    try {
      f.state.mode = mode
      await f.start()
      const reserves = f.state.attempts.filter((attempt) => attempt.path.endsWith("/reservation"))
      const releases = f.state.requests.filter((request) => request.path.endsWith("/reservation/release"))
      expect(reserves.map((attempt) => attempt.body.model)).toEqual([OPENAI_VOICE_MODEL, "gpt-live-transcribe"])
      expect(f.state.order).not.toContain("provider")
      expect(f.state.ready).toEqual([])
      expect(releases.some((request) => request.body.model === OPENAI_VOICE_MODEL)).toBe(true)
      expect(releases.some((request) => request.body.model === "gpt-live-transcribe")).toBe(
        mode !== "transcription-rejected",
      )
      expect(f.broker.active).toBe(mode !== "transcription-rejected")
      if (mode !== "transcription-rejected") expect(f.state.errors.at(-1)).toContain("unconfirmed")
    } finally {
      await f.close()
    }
  })
}

for (const mode of ["reservation-rejected", "reservation-malformed", "reservation-offline", "reservation-timeout"]) {
  test(`active voice ${mode} cannot create a provider response`, async () => {
    const f = fixture()
    try {
      await f.start()
      f.state.mode = mode
      f.send({ type: "input_audio_buffer.speech_stopped" })
      await until(() => f.state.errors.length > 0)
      expect(f.state.events.some((event) => event.type === "response.create")).toBe(false)
      expect(f.state.attempts.filter((attempt) => attempt.path.endsWith("/reservation"))).toHaveLength(3)
      if (mode === "reservation-offline" || mode === "reservation-timeout")
        expect(f.state.requests.filter((request) => request.path.endsWith("/reservation"))).toHaveLength(2)
      else expect(f.state.requests.filter((request) => request.path.endsWith("/reservation"))).toHaveLength(3)
      expect(f.state.requests.some((request) => request.path.endsWith("/usage"))).toBe(false)
      expect(f.broker.active).toBe(true)
      if (mode === "reservation-rejected") {
        f.state.mode = "normal"
        const metadata = await f.begin("response_after_budget_change")
        f.send({
          type: "response.done",
          response: { id: "response_after_budget_change", status: "completed", output: [], metadata },
        })
        expect(f.state.events.filter((event) => event.type === "response.create")).toHaveLength(1)
      }
      if (mode !== "reservation-rejected") {
        const requestID = f.state.attempts.filter((attempt) => attempt.path.endsWith("/reservation")).at(-1)!.body
          .requestID
        const event = completed("unadmitted")
        f.send({ ...event, response: { ...event.response, metadata: { raya_reservation: requestID } } })
        await until(() => !f.broker.active)
        expect(f.state.requests.some((request) => request.path.endsWith("/calls"))).toBe(false)
      }
    } finally {
      await f.close()
    }
  })
}

test("every provider response carries its admitted identity into durable usage", async () => {
  const f = fixture()
  try {
    await f.start()
    const event = await f.complete(completed())
    await until(() => f.state.requests.some((request) => request.path.endsWith("/usage")))
    const created = f.state.events.find((item) => item.type === "response.create")!
    const reservationID = (created.response as Record<string, Record<string, unknown>>).metadata.raya_reservation
    expect(reservationID).toBe(created.event_id)
    expect(event.response.metadata).toMatchObject({ raya_reservation: reservationID })
    expect(
      f.state.requests.filter(
        (request) => request.path.endsWith("/reservation") && request.body.requestID === reservationID,
      ),
    ).toHaveLength(1)
    expect(f.state.requests.find((request) => request.path.endsWith("/usage"))!.body.reservationID).toBe(reservationID)
  } finally {
    await f.close()
  }
})

test("transcription admission precedes the provider and is bound with a deterministic identity", async () => {
  const f = fixture()
  try {
    await f.start()
    const reserves = f.state.requests.filter((request) => request.path.endsWith("/reservation"))
    const session = f.state.requests.find((request) => request.method === "POST" && request.path.endsWith("/session"))!
    const requestID = `raya_transcription_${createHash("sha256")
      .update(`${input.sessionID}:${input.requestID}`)
      .digest("hex")
      .slice(0, 48)}`
    expect(reserves.map((request) => request.body)).toEqual([
      { parentSessionID: input.sessionID, requestID: input.requestID, model: OPENAI_VOICE_MODEL },
      { parentSessionID: input.sessionID, requestID, model: "gpt-live-transcribe" },
    ])
    expect(f.state.order.slice(0, 3)).toEqual([
      "/kilocode/voice/openai/reservation",
      "/kilocode/voice/openai/reservation",
      "provider",
    ])
    expect(session.body.transcriptionRequestID).toBe(requestID)
  } finally {
    await f.close()
  }
})

test("an unreserved provider response closes voice without dispatching its tool call", async () => {
  const f = fixture()
  try {
    await f.start()
    f.send(completed())
    await until(() => !f.broker.active)
    expect(f.state.errors.some((error) => error.includes("unreserved voice response"))).toBe(true)
    expect(f.state.requests.some((request) => request.path.endsWith("/calls"))).toBe(false)
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(true)
  } finally {
    await f.close()
  }
})

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
      context: "Saved task context is empty.",
    })
    await Promise.all([start, stop])
    expect(f.state.requests).toEqual([])
    expect(f.state.ready).toEqual([])
    expect(f.broker.active).toBe(false)
  } finally {
    await f.close()
  }
})

test("speech interruption targets the current output and preserves admitted work and later results", async () => {
  const f = fixture()
  try {
    f.state.mode = "pending"
    await f.start()
    await f.complete(completed())
    await until(() => f.state.pending === "call_1")
    const utterance = await f.begin("utterance")
    f.send({ type: "output_audio_buffer.started", response_id: "utterance" })
    f.broker.interrupt("other", "utterance", "unowned")
    await until(() => {
      f.broker.interrupt(input.requestID, "utterance", "interrupt_1")
      return f.state.events.some((event) => event.type === "output_audio_buffer.clear")
    })
    expect(
      f.state.events.filter((event) => ["response.cancel", "output_audio_buffer.clear"].includes(String(event.type))),
    ).toEqual([
      { type: "response.cancel", response_id: "utterance", event_id: "interrupt_1" },
      { type: "output_audio_buffer.clear", event_id: "interrupt_1_clear" },
    ])
    f.send({ type: "error", error: { code: "response_cancel_not_active", event_id: "interrupt_1" } })
    f.send({
      type: "response.done",
      response: { id: "utterance", status: "cancelled", output: [], metadata: utterance },
    })
    f.send({ type: "output_audio_buffer.cleared", response_id: "utterance" })
    f.state.released.add("call_1")
    await until(() => generated(f.state).length > 0)
    expect(f.state.errors).toEqual([])
    expect(f.state.requests.some((request) => request.method === "DELETE")).toBe(false)
    expect(
      f.state.requests.filter((request) => request.method === "POST" && request.path.endsWith("/calls")),
    ).toHaveLength(1)
    f.send({ type: "error", error: { code: "response_cancel_not_active", event_id: "unknown" } })
    await until(() => f.state.errors.length === 1)
  } finally {
    await f.close()
  }
})

const picture =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9i8AAAAASUVORK5CYII="

test("image sharing waits for exact acknowledgement and only explicit work carries its reference", async () => {
  const f = fixture()
  try {
    await f.start()
    const pending = f.broker.share(input.requestID, "picture_1", picture)
    await until(() => f.state.events.some((event) => event.event_id === "image_picture_1"))
    expect(f.state.requests.filter((request) => request.path.endsWith("/images"))).toHaveLength(1)
    expect(f.state.requests.some((request) => request.path.endsWith("/calls"))).toBe(false)
    expect(f.state.events.some((event) => event.type === "response.create")).toBe(false)
    let settled = false
    void pending.then(() => (settled = true))
    f.send({ type: "conversation.item.created", item: { id: "other", type: "message", role: "user" } })
    await Bun.sleep(25)
    expect(settled).toBe(false)
    const event = f.state.events.find((event) => event.event_id === "image_picture_1")!
    f.send({ type: "conversation.item.done", item: event.item })
    expect(await pending).toEqual({ status: "shared" })
    expect(await f.broker.share(input.requestID, "picture_1", picture)).toEqual({ status: "shared" })
    expect(f.state.requests.filter((request) => request.path.endsWith("/images"))).toHaveLength(1)
    const call = completed()
    call.response.output[0].arguments = JSON.stringify({
      request: "Describe the selected image",
      images: ["picture_1"],
    })
    await f.complete(call)
    await until(() => f.state.requests.some((request) => request.path.endsWith("/calls")))
    expect(f.state.requests.find((request) => request.path.endsWith("/calls"))!.body.arguments).toEqual({
      request: "Describe the selected image",
      images: ["picture_1"],
    })
    expect(f.state.errors).toEqual([])
  } finally {
    await f.close()
  }
})

test("image rejection is scoped to its event and unresolved delivery is never replayed", async () => {
  const f = fixture()
  try {
    await f.start()
    const pending = f.broker.share(input.requestID, "picture_1", picture)
    await until(() => f.state.events.some((event) => event.event_id === "image_picture_1"))
    f.send({ type: "error", error: { event_id: "image_picture_1", code: "invalid_image" } })
    expect((await pending).status).toBe("failed")
    expect(f.state.errors).toEqual([])
    const uncertain = f.broker.share(input.requestID, "picture_2", picture)
    await until(() => f.state.events.some((event) => event.event_id === "image_picture_2"))
    await f.broker.stop(input.requestID)
    expect((await uncertain).status).toBe("unknown")
    expect(f.state.requests.filter((request) => request.path.endsWith("/images"))).toHaveLength(2)
    expect(f.state.requests.some((request) => request.path.endsWith("/calls"))).toBe(false)
  } finally {
    await f.close()
  }
})

test("image validation and mismatched storage receipts prevent provider transmission", async () => {
  const f = fixture()
  try {
    await f.start()
    for (const data of [
      "https://invalid.test/image.png",
      "data:image/png;base64,YQ==",
      "data:image/svg+xml;base64,PHN2Zz4=",
      `data:image/png;base64,${Buffer.alloc(262145).toString("base64")}`,
    ])
      expect((await f.broker.share(input.requestID, "picture_1", data)).status).toBe("failed")
    expect((await f.broker.share("stale", "picture_1", picture)).status).toBe("failed")
    expect(f.state.requests.some((request) => request.path.endsWith("/images"))).toBe(false)
    f.state.mode = "image-receipt"
    expect((await f.broker.share(input.requestID, "picture_1", picture)).status).toBe("failed")
    expect(
      f.state.events.some(
        (event) => event.type === "conversation.item.create" && !String(event.event_id).startsWith("raya_context_"),
      ),
    ).toBe(false)
  } finally {
    await f.close()
  }
})

test("maximum image acknowledgement fits the sideband and image IDs cannot change content", async () => {
  const f = fixture()
  try {
    await f.start()
    const bytes = Buffer.concat([
      Buffer.from(picture.split(",")[1], "base64"),
      Buffer.alloc(262144 - Buffer.from(picture.split(",")[1], "base64").length),
    ])
    const data = `data:image/png;base64,${bytes.toString("base64")}`
    const pending = f.broker.share(input.requestID, "large", data)
    await until(() => f.state.events.some((event) => event.event_id === "image_large"))
    const event = f.state.events.find((event) => event.event_id === "image_large")!
    f.send({ type: "conversation.item.created", item: event.item })
    expect((await pending).status).toBe("shared")
    expect((await f.broker.share(input.requestID, "large", picture)).status).toBe("failed")
    expect(f.state.requests.filter((request) => request.path.endsWith("/images"))).toHaveLength(1)
    expect(f.state.errors).toEqual([])
  } finally {
    await f.close()
  }
})

test("voice readiness requires acknowledged semantic turn detection and interruption", async () => {
  const f = fixture()
  try {
    f.state.mode = "unconfirmed-config"
    const start = f.start()
    await until(() => f.state.events.some((event) => event.type === "session.update"))
    const session = f.state.events.find((event) => event.type === "session.update")!.session as Record<string, unknown>
    f.send({
      type: "session.updated",
      session: {
        ...session,
        audio: { input: { turn_detection: { type: "server_vad", create_response: true, interrupt_response: true } } },
      },
    })
    await Bun.sleep(25)
    expect(f.state.ready).toEqual([])
    f.send({ type: "session.updated", session: { ...session, instructions: "Different instructions" } })
    await Bun.sleep(25)
    expect(f.state.ready).toEqual([])
    expect(f.state.events.some((event) => String(event.event_id).startsWith("raya_context_"))).toBe(false)
    f.send({ type: "session.updated", session })
    await start
    expect(f.state.ready).toEqual([sdp])
  } finally {
    await f.close()
  }
})

for (const mode of ["warm", "warm-lost"]) {
  test(`${mode} routes the real two-call handoff through durable receipt, media ACK and sealed retirement`, async () => {
    const f = fixture()
    f.state.mode = mode
    const handoff = {
      version: 1 as const,
      id: "handoff_1",
      sessionID: input.sessionID,
      source: input.requestID,
      target: "request_2",
    }
    const posts: unknown[] = []
    const speech = {
      openaiState: (value: typeof handoff) => f.broker.state(value),
      openaiPrepare: (value: typeof handoff, offer: string, post: (value: unknown) => void) =>
        f.broker.prepare(
          value,
          offer,
          (sdp) => post({ type: "speechOpenAIHandoffAnswer", handoff: value, sdp }),
          (error) => f.state.errors.push(error),
        ),
      openaiPrepared: (value: typeof handoff) => f.broker.prepared(value),
      openaiQuiesce: async (value: typeof handoff & { phase: "quiesced"; epoch: number }) => {
        f.broker.quiesce(handoff, value.epoch)
      },
      openaiCommit: (value: typeof handoff) => f.broker.commit(value),
      openaiCutover: (value: typeof handoff) => f.broker.cutover(value),
      openaiRetire: async (value: typeof handoff, confirmed: boolean) => {
        expect(confirmed).toBe(true)
        const result = await f.broker.retire(value)
        expect(result.confirmed).toBe(true)
      },
      openaiCancel: (value: typeof handoff) => f.broker.cancel(value),
    }
    const ctx = {
      speech,
      post: (value: unknown) => posts.push(value),
      voiceScope: () => ({ directory: "C:/project", current: () => f.state.current }),
    }
    try {
      await f.start()
      await route({ type: "speechOpenAIHandoffOffer", handoff, sdp }, ctx)
      expect(f.state.providers).toBe(2)
      expect(f.broker.state(handoff).phase).toBe("preparing")
      await route({ type: "speechOpenAIHandoffPrepared", ack: { ...handoff, phase: "prepared" } }, ctx)
      expect(f.broker.state(handoff).phase).toBe("prepared")
      const quiet = { ...handoff, phase: "quiesced" as const, epoch: 12 }
      await route({ type: "speechOpenAIHandoffQuiesced", quiet }, ctx)
      expect(f.broker.state(handoff).phase).toBe("committed")
      expect(f.state.activated).toBe(1)
      expect(f.state.requests.filter((item) => item.path.endsWith("/handoff/receipt"))).toHaveLength(
        mode === "warm-lost" ? 1 : 0,
      )
      const count = posts.length
      await route({ type: "speechOpenAIHandoffQuiesced", quiet }, ctx)
      expect(posts).toHaveLength(count)
      expect(f.state.activated).toBe(1)
      await route({ type: "speechOpenAIHandoffCutoverAck", ack: { ...handoff, phase: "cutover" } }, ctx)
      expect(f.broker.state(handoff).phase).toBe("cutover")
      const revision = f.state.spoken.filter((row) => row.providerCallID === "rtc_provider_1").at(-1)!.revision
      f.state.controls[0].terminate()
      await new Promise((resolve) => setTimeout(resolve, 25))
      await route({ type: "speechOpenAIHandoffRetired", handoff, confirmed: true }, ctx)
      expect(f.broker.state(handoff).phase).toBe("retired")
      expect(f.broker.active).toBe(true)
      expect(f.state.errors).toEqual([])
      expect(f.state.spoken.filter((row) => row.providerCallID === "rtc_provider_1").at(-1)!.revision).toBe(revision)
      expect(posts.map((value) => (value as { type: string }).type)).toEqual([
        "speechOpenAIHandoffAnswer",
        "speechOpenAIHandoffQuiesce",
        "speechOpenAIHandoffCutover",
        "speechOpenAIHandoffRetire",
      ])
      await f.broker.stop(input.requestID)
      expect(f.broker.active).toBe(false)
    } finally {
      await f.close()
    }
  })
}

for (const fault of ["response", "disconnect", "stop"]) {
  test(`candidate ${fault} before commit refuses activation and cannot revive stopping ownership`, async () => {
    const f = fixture()
    f.state.mode = "warm"
    const handoff = {
      version: 1 as const,
      id: "handoff_bad",
      sessionID: input.sessionID,
      source: input.requestID,
      target: "request_2",
    }
    try {
      await f.start()
      await f.broker.prepare(
        handoff,
        sdp,
        () => undefined,
        (error) => f.state.errors.push(error),
      )
      await f.broker.prepared(handoff)
      f.broker.quiesce(handoff, 7)
      if (fault === "response")
        f.state.sockets[1].send(JSON.stringify({ type: "response.created", response: { id: "unsolicited" } }))
      if (fault === "disconnect") f.state.controls[1].terminate()
      if (fault === "stop") {
        const stopped = f.broker.stop(input.requestID)
        await expect(f.broker.cancel(handoff)).rejects.toThrow()
        await stopped
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      await expect(f.broker.commit(handoff)).rejects.toThrow()
      expect(f.state.activated).toBe(0)
      if (fault !== "stop") {
        expect((await f.broker.cancel(handoff)).restore).toBe(fault !== "response")
        expect(f.broker.active).toBe(true)
      }
    } finally {
      await f.close()
    }
  })
}

test("a definitively failed candidate setup reconciles cached cleanup and preserves the source", async () => {
  const f = fixture()
  f.state.mode = "warm-setup"
  const handoff = {
    version: 1 as const,
    id: "setup_failure",
    sessionID: input.sessionID,
    source: input.requestID,
    target: "request_2",
  }
  try {
    await f.start()
    await expect(
      f.broker.prepare(
        handoff,
        sdp,
        () => undefined,
        (error) => f.state.errors.push(error),
      ),
    ).rejects.toThrow("configuration")
    expect((await f.broker.cancel(handoff)).restore).toBe(true)
    expect(f.broker.active).toBe(true)
    expect(f.state.activated).toBe(0)
    expect(f.state.requests.some((row) => row.path.includes("binding_2") && row.path.endsWith("/spoken"))).toBe(false)
    expect(f.state.requests.some((row) => row.path.endsWith("binding_2") && row.method === "DELETE")).toBe(true)
  } finally {
    await f.close()
  }
})

for (const change of ["stop", "scope", "duplicate"]) {
  test(`candidate cancellation during ${change} cleanup never revives revoked source ownership`, async () => {
    const f = fixture()
    f.state.mode = "warm-cancel"
    const handoff = {
      version: 1 as const,
      id: "cancel_race",
      sessionID: input.sessionID,
      source: input.requestID,
      target: "request_2",
    }
    try {
      await f.start()
      await f.broker.prepare(
        handoff,
        sdp,
        () => undefined,
        (error) => f.state.errors.push(error),
      )
      await f.broker.prepared(handoff)
      const cancelled = f.broker.cancel(handoff)
      await until(() => f.state.reading)
      const stopped = change === "stop" ? f.broker.stop(input.requestID) : undefined
      const duplicate = change === "duplicate" ? f.broker.cancel(handoff) : undefined
      if (change === "scope") f.state.current = false
      f.state.gate.resolve()
      expect((await cancelled).restore).toBe(change === "duplicate")
      if (duplicate) expect((await duplicate).restore).toBe(true)
      await stopped
      expect(f.state.activated).toBe(0)
    } finally {
      f.state.gate.resolve()
      await f.close()
    }
  })
}

for (const mode of ["warm-ready-lost", "warm-rearm-lost", "warm-rearm-deadline"]) {
  test(`${mode} preserves exact immutable readiness input and the original readiness deadline`, async () => {
    const f = fixture()
    f.state.mode = mode
    const handoff = {
      version: 1 as const,
      id: "handoff_1",
      sessionID: input.sessionID,
      source: input.requestID,
      target: "request_2",
    }
    try {
      await f.start()
      await f.broker.prepare(
        handoff,
        sdp,
        () => undefined,
        (error) => f.state.errors.push(error),
      )
      const first = await f.broker.prepared(handoff)
      const deadline = f.state.proof!.deadline
      if (mode !== "warm-ready-lost") {
        f.state.sockets[0].send(
          JSON.stringify({
            type: "conversation.item.added",
            previous_item_id: null,
            item: { id: "catchup_user", type: "message", role: "user" },
          }),
        )
        f.state.sockets[0].send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "catchup_user",
            content_index: 0,
            transcript: "A new source turn during warming",
          }),
        )
        await until(() => f.state.spoken.some((row) => JSON.stringify(row.items).includes("catchup_user")))
        if (mode === "warm-rearm-deadline")
          await expect(f.broker.prepared(handoff)).rejects.toThrow("not confirmed exactly")
        if (mode === "warm-rearm-lost") {
          const updated = await f.broker.prepared(handoff)
          expect(updated.readyID).not.toBe(first.readyID)
          expect(updated.sourceHash).not.toBe(first.sourceHash)
          expect(f.state.proof!.deadline).toBe(deadline)
        }
      }
      const path = mode === "warm-ready-lost" ? "/handoff/ready" : "/handoff/rearm"
      const attempts = f.state.requests.filter((row) => row.path.endsWith(path))
      expect(attempts).toHaveLength(mode === "warm-rearm-deadline" ? 1 : 2)
      if (attempts.length === 2) expect(JSON.stringify(attempts[1].body)).toBe(JSON.stringify(attempts[0].body))
      expect(f.state.providers).toBe(2)
      expect(f.state.activated).toBe(0)
    } finally {
      await f.close()
    }
  })
}

for (const mode of ["warm-ready-offline", "warm-ready-refused", "warm-ready-changed", "warm-ready-expired"]) {
  test(`${mode} remains bounded and never activates on an unconfirmed readiness receipt`, async () => {
    const f = fixture()
    f.state.mode = mode
    const handoff = {
      version: 1 as const,
      id: "handoff_1",
      sessionID: input.sessionID,
      source: input.requestID,
      target: "request_2",
    }
    try {
      await f.start()
      await f.broker.prepare(
        handoff,
        sdp,
        () => undefined,
        (error) => f.state.errors.push(error),
      )
      const err = await f.broker.prepared(handoff).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(err).toBeInstanceOf(Error)
      const requests = f.state.requests.filter((row) => row.path.endsWith("/handoff/ready"))
      expect(requests).toHaveLength(mode === "warm-ready-offline" ? 3 : 1)
      if (requests.length > 1) expect(new Set(requests.map((row) => JSON.stringify(row.body))).size).toBe(1)
      expect(f.state.activated).toBe(0)
      expect((await f.broker.cancel(handoff)).restore).toBe(true)
    } finally {
      await f.close()
    }
  })
}

for (const mode of ["warm-ready-stop", "warm-ready-scope"]) {
  test(`${mode} fences an ambiguous readiness response before any retry`, async () => {
    const f = fixture()
    f.state.mode = mode
    const handoff = {
      version: 1 as const,
      id: "handoff_1",
      sessionID: input.sessionID,
      source: input.requestID,
      target: "request_2",
    }
    try {
      await f.start()
      await f.broker.prepare(
        handoff,
        sdp,
        () => undefined,
        (error) => f.state.errors.push(error),
      )
      const pending = f.broker.prepared(handoff)
      const rejected = pending.then(
        () => undefined,
        (error: unknown) => error,
      )
      await until(() => f.state.reading)
      const stopped = mode === "warm-ready-stop" ? f.broker.stop(input.requestID) : undefined
      if (mode === "warm-ready-scope") f.state.current = false
      f.state.gate.resolve()
      expect(await rejected).toBeInstanceOf(Error)
      await stopped
      expect(f.state.requests.filter((row) => row.path.endsWith("/handoff/ready"))).toHaveLength(1)
      expect(f.state.activated).toBe(0)
    } finally {
      f.state.gate.resolve()
      await f.close()
    }
  })
}
