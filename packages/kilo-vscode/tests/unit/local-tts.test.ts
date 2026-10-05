import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { LocalTts } from "../../src/speech/local-tts"
import type { PlaybackDiagnostic } from "../../src/speech/diagnostics"

function wav() {
  const bytes = Buffer.alloc(284)
  bytes.write("RIFF")
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write("WAVEfmt ", 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(24_000, 24)
  bytes.writeUInt32LE(48_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36)
  bytes.writeUInt32LE(240, 40)
  for (let index = 44; index < bytes.length; index += 2) bytes.writeInt16LE(index * 30, index)
  return bytes
}

async function fixture(mode: string, body: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const ctx = await setup(mode)
  try {
    await body(ctx)
  } finally {
    try {
      await ctx.client.dispose()
    } catch (err) {
      if (!["cleanup", "cancel-cleanup", "cleanup-delay", "replacement-failure"].includes(mode)) throw err
      expect(err).toMatchObject({ message: "Local speech cleanup is unconfirmed." })
    }
    await ctx.server.stop(true)
  }
}

async function setup(mode: string) {
  const bytes = wav()
  if (mode === "stereo") bytes.writeUInt16LE(2, 22)
  if (mode === "truncated") bytes.writeUInt32LE(999, 40)
  const calls: { method: string; path: string; auth: string | null }[] = []
  const events: string[] = []
  const chunks: { data: string; mime: string }[] = []
  const errors: string[] = []
  const results: unknown[] = []
  const selected: unknown[] = []
  const releases: (() => void)[] = []
  const state = { id: "", polls: 0, deletes: 0, downloads: 0, body: {} as Record<string, unknown> }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      calls.push({ method: request.method, path, auth: request.headers.get("authorization") })
      if (path === "/health") return Response.json({ version: 2, ready: true })
      if (request.method === "DELETE") {
        state.deletes++
        if (["replacement", "cleanup-delay", "replacement-failure"].includes(mode))
          await new Promise<void>((resolve) => releases.push(resolve))
        if (["cleanup", "cancel-cleanup", "cleanup-delay", "replacement-failure"].includes(mode))
          return new Response("", { status: 503 })
        return Response.json({ cancelled: true })
      }
      if (request.method === "POST") {
        state.id = request.headers.get("x-raya-job-id") ?? ""
        expect(state.id).toMatch(/^[0-9a-f]{32}$/)
        state.body = (await request.json()) as Record<string, unknown>
        if (mode === "invalid-create") return new Response("invalid")
        if (mode === "unauthorized") return new Response("", { status: 401 })
      }
      if (path.includes("/audio/")) {
        state.downloads++
        if (mode === "retry" && state.downloads === 1)
          return new Response(
            new ReadableStream({
              start(ctrl) {
                ctrl.enqueue(new Uint8Array(bytes.subarray(0, 20)))
                setTimeout(() => ctrl.error(new Error("Synthetic interrupted download.")), 5)
              },
            }),
            { headers: { "Content-Type": "audio/wav" } },
          )
        if (mode === "redirect") return Response.redirect("http://127.0.0.1:1/foreign")
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "audio/wav" } })
      }
      if (request.method === "GET") state.polls++
      return Response.json(job(mode, state, bytes))
    },
  })
  const diagnostics: PlaybackDiagnostic[] = []
  const client = new LocalTts({
    timeout: mode === "pending" ? 80 : 1000,
    poll: 10,
    diagnostic: (row) => diagnostics.push(row),
  })
  const input = {
    id: "owner",
    endpoint: `http://127.0.0.1:${server.port}`,
    key: "synthetic-private-key",
    model: "chatterbox-nano",
    voice: "freeman-reference-c-AI",
    text: "Synthetic speech.",
  }
  const sink = {
    voice(value: unknown) {
      selected.push(value)
      events.push("voice")
    },
    chunk(data: string, mime: string) {
      chunks.push({ data, mime })
      events.push("chunk")
    },
    done(value: unknown) {
      results.push(value)
      events.push("done")
    },
    error(value: string) {
      errors.push(value)
      events.push("error")
    },
  }
  return {
    server,
    client,
    input,
    sink,
    bytes,
    calls,
    events,
    chunks,
    errors,
    results,
    selected,
    state,
    releases,
    diagnostics,
  }
}

test("real local HTTP jobs deliver exact PCM and selection before audio, then join DELETE", async () => {
  await fixture("two", async (ctx) => {
    await ctx.client.speak(ctx.input, ctx.sink)
    expect(ctx.events).toEqual(["voice", "chunk", "chunk", "done"])
    expect(ctx.chunks).toEqual(
      Array(2).fill({ data: ctx.bytes.subarray(44).toString("base64"), mime: "audio/pcm;rate=24000" }),
    )
    expect(ctx.results[0]).toMatchObject({
      chunks: 2,
      bytes: 480,
      model: "chatterbox-nano",
      voice: "freeman-reference-c-AI",
      fallback: null,
    })
    expect(ctx.state.body).toEqual({
      kind: "speech",
      model: "chatterbox-nano",
      input: ctx.input.text,
      allow_fallback: false,
    })
    expect(ctx.state.deletes).toBe(1)
    expect(ctx.calls.every((call) => call.auth === "Bearer synthetic-private-key")).toBe(true)
    expect(ctx.errors).toEqual([])
    expect(ctx.diagnostics.filter((row) => row.phase === "chunk")).toEqual(
      [0, 1].map((index) =>
        expect.objectContaining({ index, bytes: 240, rate: 24_000, mime: "audio/pcm", nonzero: 120, peak: 8460 }),
      ),
    )
    expect(ctx.diagnostics.at(-1)).toMatchObject({ phase: "cleanup", confirmed: true })
    expect(JSON.stringify(ctx.diagnostics)).not.toContain(ctx.input.text)
    expect(JSON.stringify(ctx.diagnostics)).not.toContain(ctx.input.key)
    expect(JSON.stringify(ctx.diagnostics)).not.toContain(ctx.chunks[0].data)
  })
})

test("explicit Kokoro and prepublication opt-in Nano fallback report genuine actual voice", async () => {
  await fixture("two", async (ctx) => {
    await ctx.client.speak({ ...ctx.input, model: "kokoro", voice: "am_onyx" }, ctx.sink)
    expect(ctx.selected).toEqual([{ model: "kokoro", voice: "am_onyx", fallback: null }])
  })
  await fixture("fallback", async (ctx) => {
    await ctx.client.speak({ ...ctx.input, allowFallback: true }, ctx.sink)
    expect(ctx.events[0]).toBe("voice")
    expect(ctx.selected).toEqual([
      { model: "kokoro", voice: "am_onyx", fallback: { from: "chatterbox-nano", reason: "primary_synthesis_failed" } },
    ])
  })
  await fixture("fallback", async (ctx) => {
    await ctx.client.speak(ctx.input, ctx.sink)
    expect(ctx.chunks).toHaveLength(0)
    expect(ctx.errors).toHaveLength(1)
  })
})

test("real HTTP validation refuses corrupted audio, foreign routes and job identities before publication", async () => {
  for (const mode of [
    "stereo",
    "truncated",
    "hash",
    "foreign",
    "redirect",
    "identity",
    "order",
    "failed",
    "invalid-create",
    "unauthorized",
  ]) {
    await fixture(mode, async (ctx) => {
      await ctx.client.speak(ctx.input, ctx.sink)
      expect(ctx.chunks).toHaveLength(0)
      expect(ctx.results).toHaveLength(0)
      expect(ctx.errors).toHaveLength(1)
      expect(ctx.errors.join()).not.toContain(ctx.input.key)
      expect(ctx.state.deletes).toBe(1)
      expect(ctx.diagnostics.some((row) => row.phase === "error")).toBe(true)
      if (mode === "unauthorized") expect(ctx.diagnostics.some((row) => row.http === 401)).toBe(true)
    })
  }
})

test("a voice change after first audio is refused without another chunk or success", async () => {
  await fixture("late-fallback", async (ctx) => {
    await ctx.client.speak({ ...ctx.input, allowFallback: true }, ctx.sink)
    expect(ctx.chunks).toHaveLength(1)
    expect(ctx.selected).toHaveLength(1)
    expect(ctx.errors).toEqual(["Local speech changed voice after publication."])
    expect(ctx.results).toHaveLength(0)
  })
})

test("cancel joins owned DELETE, fences late audio, and dispose refuses new intake", async () => {
  await fixture("cancel", async (ctx) => {
    const pending = ctx.client.speak(ctx.input, ctx.sink)
    await until(() => !!ctx.state.id)
    await ctx.client.cancel(ctx.input.id)
    await pending
    expect(ctx.state.deletes).toBe(1)
    expect(ctx.chunks).toHaveLength(0)
    expect(ctx.results).toHaveLength(0)
    expect(ctx.errors).toHaveLength(0)
    await ctx.client.dispose()
    const count = ctx.calls.length
    await ctx.client.speak(ctx.input, ctx.sink)
    expect(ctx.calls).toHaveLength(count)
    expect(ctx.errors).toEqual(["Local speech is closed."])
  })
})

test("finite deadline and unsuccessful DELETE do not produce false completion", async () => {
  await fixture("pending", async (ctx) => {
    await ctx.client.speak(ctx.input, ctx.sink)
    expect(ctx.errors).toEqual(["Local speech deadline exceeded."])
    expect(ctx.state.deletes).toBe(1)
    expect(ctx.results).toHaveLength(0)
  })
  await fixture("cleanup", async (ctx) => {
    await ctx.client.speak(ctx.input, ctx.sink)
    expect(ctx.errors).toEqual(["Local speech cleanup failed."])
    expect(ctx.results).toHaveLength(0)
  })
})

test("credential origins are rejected before any HTTP, including URL userinfo and paths", async () => {
  await fixture("two", async (ctx) => {
    for (const endpoint of [
      "https://127.0.0.1:8770",
      "http://localhost:8770",
      "http://127.0.0.1:8770/path",
      "http://key@127.0.0.1:8770",
      "http://example.com",
    ]) {
      await ctx.client.speak({ ...ctx.input, endpoint }, ctx.sink)
    }
    expect(ctx.calls).toHaveLength(0)
    expect(ctx.errors).toHaveLength(5)
  })
})

function descriptors(mode: string, id: string, bytes: Buffer) {
  if (["pending", "cancel", "cancel-cleanup", "replacement", "replacement-failure"].includes(mode)) return []
  return Array.from({ length: mode === "two" ? 2 : 1 }, (_, index) => ({
    index: mode === "order" ? index + 1 : index,
    url: mode === "foreign" ? "http://127.0.0.1:1/foreign" : "/v1/jobs/" + id + "/audio/" + index,
    seconds: 0.005,
    mime: "audio/wav",
    bytes: bytes.length,
    sha256: mode === "hash" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
  }))
}

test("interrupted immutable GET retries, while hash corruption remains terminal", async () => {
  await fixture("retry", async (ctx) => {
    await ctx.client.speak(ctx.input, ctx.sink)
    expect(ctx.state.downloads).toBe(2)
    expect(ctx.calls.filter((call) => call.method === "POST")).toHaveLength(1)
    expect(ctx.results).toHaveLength(1)
    expect(ctx.chunks).toHaveLength(1)
  })
  await fixture("hash", async (ctx) => {
    await ctx.client.speak(ctx.input, ctx.sink)
    expect(ctx.state.downloads).toBe(1)
    expect(ctx.errors).toHaveLength(1)
  })
})

test("cancellation from voice callback fences the immediately following chunk", async () => {
  await fixture("two", async (ctx) => {
    await ctx.client.speak(ctx.input, {
      ...ctx.sink,
      voice: () => {
        void ctx.client.cancel(ctx.input.id)
      },
    })
    expect(ctx.chunks).toHaveLength(0)
    expect(ctx.results).toHaveLength(0)
    expect(ctx.errors).toHaveLength(0)
    expect(ctx.state.deletes).toBe(1)
  })
})

function job(mode: string, state: { id: string; polls: number; body: Record<string, unknown> }, bytes: Buffer) {
  const fallback = mode === "fallback" || (mode === "late-fallback" && state.polls > 0)
  const pending =
    ["pending", "cancel", "cancel-cleanup", "replacement", "replacement-failure"].includes(mode) ||
    (mode === "late-fallback" && state.polls === 0)
  return {
    id: mode === "identity" ? "f".repeat(32) : state.id,
    model: fallback ? "kokoro" : state.body.model,
    voice: fallback || state.body.model === "kokoro" ? "am_onyx" : "freeman-reference-c-AI",
    fallback: fallback ? { from: "chatterbox-nano", reason: "primary_synthesis_failed" } : null,
    status: mode === "failed" ? "failed" : pending ? "running" : "completed",
    chunks: descriptors(mode, state.id, bytes),
  }
}

test("cancelled request retains failed cleanup qualification", async () => {
  await fixture("cancel-cleanup", async (ctx) => {
    const pending = ctx.client.speak(ctx.input, ctx.sink)
    await until(() => !!ctx.state.id)
    await expect(ctx.client.cancel(ctx.input.id)).rejects.toThrow("Local speech cleanup is unconfirmed.")
    await pending
    expect(ctx.errors).toEqual(["Local speech failed and cleanup is unconfirmed."])
    expect(ctx.results).toHaveLength(0)
    expect(ctx.state.deletes).toBe(1)
  })
})

test("replacement retires old generation and dispose joins both actual cleanup requests", async () => {
  await fixture("replacement", async (ctx) => {
    const first = ctx.client.speak(ctx.input, ctx.sink)
    await until(() => !!ctx.state.id)
    const second = ctx.client.speak(ctx.input, ctx.sink)
    await until(() => ctx.releases.length === 1)
    const status = { closed: false }
    const closed = ctx.client.dispose().then(() => {
      status.closed = true
    })
    await until(() => ctx.releases.length === 2)
    expect(status.closed).toBe(false)
    expect(ctx.chunks).toHaveLength(0)
    for (const release of ctx.releases) release()
    await Promise.all([first, second, closed])
    expect(status.closed).toBe(true)
    expect(ctx.state.deletes).toBe(2)
    expect(ctx.results).toHaveLength(0)
    expect(ctx.errors).toHaveLength(0)
  })
})

test("cancel during cleanup reports its sole cleanup failure and rejects oversized service input", async () => {
  await fixture("cleanup-delay", async (ctx) => {
    const pending = ctx.client.speak(ctx.input, ctx.sink)
    await until(() => ctx.releases.length === 1)
    const cancelled = refused(ctx.client.cancel(ctx.input.id))
    ctx.releases[0]()
    await Promise.all([pending, cancelled])
    expect(ctx.errors).toEqual(["Local speech cleanup failed."])
    expect(ctx.results).toHaveLength(0)
  })
  await fixture("two", async (ctx) => {
    await ctx.client.speak({ ...ctx.input, text: "a".repeat(4001) }, ctx.sink)
    expect(ctx.calls).toHaveLength(0)
    expect(ctx.errors).toHaveLength(1)
  })
})

async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() >= end) throw new Error("Synthetic HTTP fixture deadline exceeded.")
    await Bun.sleep(2)
  }
}

test("replacement disposal refuses unsuccessful joined DELETE and reports cleanup callback", async () => {
  await fixture("replacement-failure", async (ctx) => {
    const cleanup: boolean[] = []
    const sink = { ...ctx.sink, cleanup: (confirmed: boolean) => cleanup.push(confirmed) }
    const first = ctx.client.speak(ctx.input, sink)
    await until(() => !!ctx.state.id)
    const second = ctx.client.speak(ctx.input, sink)
    await until(() => ctx.releases.length === 1)
    const closed = refused(ctx.client.dispose())
    await until(() => ctx.releases.length === 2)
    for (const release of ctx.releases) release()
    await Promise.all([first, second, closed])
    expect(cleanup).toEqual([false, false])
    expect(ctx.results).toHaveLength(0)
    expect(ctx.chunks).toHaveLength(0)
  })
})

function refused(operation: Promise<void>) {
  return operation.then(
    () => {
      throw new Error("Expected cleanup refusal.")
    },
    (err: unknown) => {
      expect(err).toMatchObject({ message: "Local speech cleanup is unconfirmed." })
    },
  )
}
