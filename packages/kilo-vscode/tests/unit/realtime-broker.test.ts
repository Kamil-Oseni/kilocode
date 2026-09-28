import { expect, test } from "bun:test"
import { RealtimeBroker } from "../../src/speech/realtime-broker"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"
import { local } from "../../src/speech/local"

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function fixture(handle?: (request: Request) => Promise<Response | undefined>) {
  const calls: Array<{ method: string; path: string; auth: string | null; mediaKey: string | null; body: string }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        auth: request.headers.get("Authorization"),
        mediaKey: request.headers.get("X-Raya-Media-Key"),
        body: await request.clone().text(),
      })
      const response = await handle?.(request)
      if (response) return response
      if (request.method === "POST" && new URL(request.url).pathname === "/kilocode/voice/session")
        return Response.json({
          id: "rvs_test",
          room: "synthetic",
          livekitURL: "ws://127.0.0.1:7880",
          clientToken: "client-secret",
          mediaToken: "media-secret",
          controlToken: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
          engine: JSON.parse(await request.clone().text()).engine ?? "qwen-realtime",
          acceptsTruncation: false,
          maximumSeconds: 60,
        })
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/sessions")
        return Response.json({
          id: "rvs_test",
          descriptor: {
            id: "openai-live",
            inputRate: 24000,
            outputRate: 24000,
            acceptsTruncation: false,
            nativeBargeIn: true,
            nativeEndpointing: true,
            requiresContinuousInput: true,
          },
        })
      return Response.json({ ok: true })
    },
  })
  const config = {
    sessionID: "ses_test",
    directory: "workspace with spaces",
    backendURL: server.url.origin,
    auth: "Basic synthetic-secret",
    key: "engine-secret",
    mediaKey: "A".repeat(43),
    settings: {
      ...DEFAULT_SPEECH_SETTINGS,
      voiceEngine: "qwen-realtime" as const,
      mediaFrontendURL: server.url.origin,
    },
  }
  return { calls, config, close: () => server.stop(true) }
}

test("managed voice control accepts only numeric loopback HTTP origins", () => {
  expect(local("http://127.0.0.1:7890/")).toBe("http://127.0.0.1:7890")
  expect(local("http://127.1:80")).toBe("http://127.0.0.1")
  expect(local("http://[::1]:7890")).toBe("http://[::1]:7890")
  for (const value of [
    "https://127.0.0.1:7890",
    "http://localhost:7890",
    "http://127.evil.example:7890",
    "http://192.168.1.2:7890",
    "http://user:secret@127.0.0.1:7890",
    "http://127.0.0.1:7890/path",
    "http://127.0.0.1:7890?next=remote",
    "not a URL",
  ])
    expect(local(value)).toBeUndefined()
})

test("broker rejects unsafe initial destinations and service keys before sending credentials", async () => {
  for (const target of ["backend", "media", "key"] as const) {
    const site = fixture()
    const broker = new RealtimeBroker()
    const config = {
      ...site.config,
      ...(target === "backend" ? { backendURL: "http://backend.example" } : {}),
      ...(target === "key" ? { mediaKey: "invalid" } : {}),
      settings: {
        ...site.config.settings,
        ...(target === "media" ? { mediaFrontendURL: "http://media.example" } : {}),
      },
    }
    try {
      expect(
        await broker.start(
          async () => config,
          () => {},
        ),
      ).toEqual({
        ok: false,
        code: "configuration",
        error:
          "Voice backend and media frontend require numeric loopback HTTP addresses and a valid media service key.",
      })
      expect(site.calls).toEqual([])
      expect(broker.active).toBe(false)
    } finally {
      site.close()
    }
  }
})

test("broker authenticates media admission and cleanup with the CLI capability", async () => {
  const site = fixture()
  const broker = new RealtimeBroker()
  try {
    expect(
      await broker.start(
        async () => site.config,
        () => {},
      ),
    ).toMatchObject({ ok: true })
    const backend = site.calls.find((call) => call.path === "/kilocode/voice/session" && call.method === "POST")
    if (!backend) throw new Error("backend admission was not sent")
    expect(backend.mediaKey).toBe("A".repeat(43))
    expect(backend.body).not.toContain("A".repeat(43))
    const media = site.calls.find((call) => call.path === "/v1/sessions" && call.method === "POST")
    expect(media?.auth).toBe("Bearer MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY")
    expect(media?.mediaKey).toBe("A".repeat(43))
    expect(media?.body).not.toContain("A".repeat(43))
    expect(await broker.stop()).toBeUndefined()
    expect(site.calls.find((call) => call.path === "/v1/sessions/rvs_test" && call.method === "DELETE")?.auth).toBe(
      "Bearer MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    )
    expect(site.calls.find((call) => call.path === "/v1/sessions/rvs_test" && call.method === "DELETE")?.mediaKey).toBe(
      "A".repeat(43),
    )
  } finally {
    site.close()
  }
})

for (const status of [301, 302, 303, 307, 308]) {
  for (const remote of [false, true]) {
    for (const stage of ["backend", "media", "backend-cleanup", "media-cleanup"]) {
      test(`broker refuses ${status} ${remote ? "other-port" : "same-origin"} redirect during ${stage}`, async () => {
        const target = fixture()
        const path = stage.startsWith("backend") ? "/kilocode/voice/session" : "/v1/sessions"
        const cleanup = stage.endsWith("cleanup")
        const expected = cleanup ? `${path}/rvs_test` : path
        const site = fixture(async (request) => {
          if (request.method !== (cleanup ? "DELETE" : "POST") || new URL(request.url).pathname !== expected)
            return undefined
          return new Response(null, {
            status,
            headers: { Location: `${remote ? target.config.backendURL : new URL(request.url).origin}/redirected` },
          })
        })
        const broker = new RealtimeBroker()
        const ready: string[] = []
        try {
          const result = await broker.start(
            async () => site.config,
            (info) => ready.push(info.id),
          )
          if (cleanup) {
            expect(result).toMatchObject({ ok: true })
            expect(await broker.stop()).toMatchObject({ code: "cleanup_failed" })
            expect(broker.active).toBe(true)
            const count = site.calls.length
            expect(await broker.stop()).toMatchObject({ code: "cleanup_failed" })
            expect(site.calls).toHaveLength(count)
          }
          if (!cleanup) {
            expect(result).toMatchObject({
              ok: false,
              code: stage === "backend" ? "admission_unknown" : "setup_failed",
            })
            expect(ready).toEqual([])
            expect(broker.active).toBe(stage === "backend")
          }
          expect(target.calls).toHaveLength(0)
          expect(site.calls.filter((call) => call.path === "/redirected")).toHaveLength(0)
          const requests = site.calls.filter(
            (call) => call.path === expected && call.method === (cleanup ? "DELETE" : "POST"),
          )
          expect(requests).toHaveLength(1)
          if (stage.startsWith("backend")) expect(requests[0]?.auth).toBe("Basic synthetic-secret")
          if (stage === "media") {
            expect(JSON.parse(requests[0]!.body)).toMatchObject({
              backendAuthorization: "Basic synthetic-secret",
              livekitToken: "media-secret",
              engine: { key: "engine-secret" },
            })
          }
        } finally {
          site.close()
          target.close()
        }
      })
    }
  }
}

test("broker claims before settings lookup and stop waits for pending media admission without publishing ready", async () => {
  const entered = gate()
  const resume = gate()
  const site = fixture(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/sessions") {
      entered.release()
      await resume.wait
    }
    return undefined
  })
  const broker = new RealtimeBroker()
  const ready: string[] = []
  try {
    const first = broker.start(
      async () => site.config,
      (info) => ready.push(info.id),
    )
    const duplicate = await broker.start(
      async () => {
        throw new Error("duplicate must not load")
      },
      () => {},
    )
    expect(duplicate).toMatchObject({ ok: false, code: "busy" })
    await entered.wait
    const stopping = broker.stop()
    expect(ready).toEqual([])
    resume.release()
    expect(await first).toMatchObject({ ok: false, code: "cancelled" })
    expect(await stopping).toBeUndefined()
    expect(site.calls.filter((call) => call.method === "POST")).toHaveLength(2)
    expect(site.calls.filter((call) => call.method === "DELETE")).toHaveLength(2)
    expect(site.calls.find((call) => call.path === "/kilocode/voice/session/rvs_test")?.auth).toBe(
      "Basic synthetic-secret",
    )
    expect(ready).toEqual([])
    expect(
      await broker.start(
        async () => site.config,
        (info) => ready.push(info.id),
      ),
    ).toMatchObject({ ok: true })
    expect(ready).toEqual(["rvs_test"])
    await broker.stop()
  } finally {
    resume.release()
    site.close()
  }
})

test("partial setup failure closes both known resources and exposes no provider secrets", async () => {
  const site = fixture(async (request) =>
    request.method === "POST" && new URL(request.url).pathname === "/v1/sessions"
      ? new Response("engine-secret media-secret", { status: 503 })
      : undefined,
  )
  try {
    const broker = new RealtimeBroker()
    const result = await broker.start(
      async () => site.config,
      () => {
        throw new Error("must not become ready")
      },
    )
    expect(result).toMatchObject({ ok: false, code: "setup_failed" })
    expect(JSON.stringify(result)).not.toContain("secret")
    expect(site.calls.filter((call) => call.method === "DELETE")).toHaveLength(2)
    expect(await broker.stop()).toBeUndefined()
  } finally {
    site.close()
  }
})

test("failed cleanup retains ownership and concurrent stop returns the same failure without replay", async () => {
  const site = fixture(async (request) =>
    request.method === "DELETE" ? new Response("private provider body", { status: 500 }) : undefined,
  )
  try {
    const broker = new RealtimeBroker()
    expect(
      await broker.start(
        async () => site.config,
        () => {},
      ),
    ).toMatchObject({ ok: true })
    const [first, second] = await Promise.all([broker.stop(), broker.stop()])
    expect(first).toMatchObject({ ok: false, code: "cleanup_failed" })
    expect(second).toEqual(first)
    expect(JSON.stringify(first)).not.toContain("private")
    expect(
      await broker.start(
        async () => site.config,
        () => {},
      ),
    ).toMatchObject({ ok: false, code: "busy" })
    expect(await broker.stop()).toEqual(first)
    expect(site.calls.filter((call) => call.method === "DELETE")).toHaveLength(1)
    expect(site.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/kilocode/"))).toBe(false)
  } finally {
    site.close()
  }
})

test("lost backend admission acknowledgement retains uncertainty and does not repeat admission", async () => {
  const resume = gate()
  const site = fixture(async (request) => {
    if (request.method === "POST") await resume.wait
    return undefined
  })
  try {
    const broker = new RealtimeBroker(50)
    const result = await broker.start(
      async () => site.config,
      () => {},
    )
    expect(result).toMatchObject({ ok: false, code: "admission_unknown" })
    expect(
      await broker.start(
        async () => site.config,
        () => {},
      ),
    ).toMatchObject({ ok: false, code: "busy" })
    expect(await broker.stop()).toEqual(result)
    expect(site.calls).toHaveLength(1)
  } finally {
    resume.release()
    site.close()
  }
})

test("lost media acknowledgement keeps backend open when media deletion cannot confirm absent pending work", async () => {
  const resume = gate()
  const site = fixture(async (request) => {
    if (new URL(request.url).pathname.startsWith("/v1/sessions")) {
      if (request.method === "POST") await resume.wait
      if (request.method === "DELETE") return new Response("", { status: 404 })
    }
    return undefined
  })
  try {
    const broker = new RealtimeBroker(50)
    const result = await broker.start(
      async () => site.config,
      () => {},
    )
    expect(result).toMatchObject({ ok: false, code: "admission_unknown" })
    expect(site.calls.filter((call) => call.method === "DELETE")).toHaveLength(1)
    expect(site.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/kilocode/"))).toBe(false)
    expect(
      await broker.start(
        async () => site.config,
        () => {},
      ),
    ).toMatchObject({ ok: false, code: "busy" })
  } finally {
    resume.release()
    site.close()
  }
})

test("dispose during settings lookup suppresses setup and permanently closes the broker", async () => {
  const resume = gate()
  const site = fixture()
  const broker = new RealtimeBroker()
  try {
    const start = broker.start(
      async () => {
        await resume.wait
        return site.config
      },
      () => {
        throw new Error("must not publish")
      },
    )
    const stopped = broker.dispose()
    resume.release()
    expect(await start).toMatchObject({ ok: false, code: "cancelled" })
    expect(await stopped).toBeUndefined()
    expect(site.calls).toHaveLength(0)
    expect(
      await broker.start(
        async () => site.config,
        () => {},
      ),
    ).toMatchObject({ ok: false, code: "cancelled" })
  } finally {
    resume.release()
    site.close()
  }
})

test("Live media uses explicit v2 provider and verified native 24k descriptor", async () => {
  const site = fixture()
  const broker = new RealtimeBroker()
  const ready: string[] = []
  try {
    const result = await broker.start(
      async () => ({
        ...site.config,
        context: "Saved synthetic conversation",
        settings: {
          ...site.config.settings,
          voiceEngine: "openai-live",
          openaiVoice: "marin",
        },
      }),
      (info) => ready.push(info.engine),
    )
    expect(result).toMatchObject({ ok: true, info: { engine: "openai-live", acceptsTruncation: false } })
    expect(ready).toEqual(["openai-live"])
    expect(JSON.parse(site.calls[0]!.body)).toMatchObject({
      version: 2,
      engine: "openai-live",
      parentSessionID: "ses_test",
    })
    const body = JSON.parse(site.calls[1]!.body)
    expect(body).toMatchObject({
      version: 2,
      engine: {
        provider: "openai-live",
        endpoint: "wss://api.openai.com/v1/live/sessions",
        model: "gpt-live-1",
        voice: "marin",
        delegation: "client",
        maximumSeconds: 60,
        mode: "hands-free",
        key: "engine-secret",
      },
    })
    expect(site.calls[1]!.body).not.toContain("dashscope")
    expect(body.engine.instructions).toContain("historical conversation, not a new request")
    expect(body.engine.instructions).toContain("Saved synthetic conversation")
    expect(await broker.stop()).toBeUndefined()
    expect(site.calls.slice(-2).map((call) => call.path)).toEqual([
      "/v1/sessions/rvs_test",
      "/kilocode/voice/session/rvs_test",
    ])
  } finally {
    site.close()
  }
})

test("oversized saved Live context refuses before sending credentials", async () => {
  const site = fixture()
  const broker = new RealtimeBroker()
  try {
    expect(
      await broker.start(
        async () => ({
          ...site.config,
          context: "é".repeat(8193),
          settings: {
            ...site.config.settings,
            voiceEngine: "openai-live",
          },
        }),
        () => {},
      ),
    ).toMatchObject({ ok: false, code: "configuration" })
    expect(site.calls).toEqual([])
    expect(broker.active).toBe(false)
  } finally {
    site.close()
  }
})

test("Live media refuses mismatched descriptors before publishing ready", async () => {
  for (const change of [
    { id: "qwen-realtime" },
    { inputRate: 16000 },
    { outputRate: 48000 },
    { acceptsTruncation: true },
    { requiresContinuousInput: false },
    { nativeBargeIn: false },
    { nativeEndpointing: false },
  ]) {
    const site = fixture(async (request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/sessions")
        return Response.json({
          id: "rvs_test",
          descriptor: {
            id: "openai-live",
            inputRate: 24000,
            outputRate: 24000,
            acceptsTruncation: false,
            requiresContinuousInput: true,
            nativeBargeIn: true,
            nativeEndpointing: true,
            ...change,
          },
        })
      return undefined
    })
    const broker = new RealtimeBroker()
    const ready: string[] = []
    try {
      expect(
        await broker.start(
          async () => ({ ...site.config, settings: { ...site.config.settings, voiceEngine: "openai-live" } }),
          (info) => ready.push(info.id),
        ),
      ).toMatchObject({ ok: false, code: "setup_failed" })
      expect(ready).toEqual([])
      expect(site.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
        "/v1/sessions/rvs_test",
        "/kilocode/voice/session/rvs_test",
      ])
    } finally {
      site.close()
    }
  }
})

test("Live media refuses a backend provider mismatch without sending provider credentials", async () => {
  const site = fixture(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/kilocode/voice/session")
      return Response.json({
        id: "rvs_test",
        room: "synthetic",
        livekitURL: "ws://127.0.0.1:7880",
        clientToken: "client-secret",
        mediaToken: "media-secret",
        controlToken: "A".repeat(43),
        engine: "qwen-realtime",
        acceptsTruncation: false,
      })
    return undefined
  })
  const broker = new RealtimeBroker()
  try {
    expect(
      await broker.start(
        async () => ({ ...site.config, settings: { ...site.config.settings, voiceEngine: "openai-live" } }),
        () => {},
      ),
    ).toMatchObject({ ok: false, code: "admission_unknown" })
    expect(site.calls).toHaveLength(1)
    expect(broker.active).toBe(true)
  } finally {
    site.close()
  }
})

test("Live reserved duration is required before any media or provider admission", async () => {
  for (const maximum of [undefined, null, "60", -1, 0, 1.4, 86400.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const site = fixture(async (request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/kilocode/voice/session")
        return Response.json({
          id: "rvs_test",
          room: "synthetic",
          livekitURL: "ws://127.0.0.1:7880",
          clientToken: "client-secret",
          mediaToken: "media-secret",
          controlToken: "A".repeat(43),
          engine: "openai-live",
          acceptsTruncation: false,
          ...(maximum === undefined ? {} : { maximumSeconds: maximum }),
        })
      return undefined
    })
    const broker = new RealtimeBroker()
    try {
      expect(
        await broker.start(
          async () => ({ ...site.config, settings: { ...site.config.settings, voiceEngine: "openai-live" } }),
          () => {
            throw new Error("budget refusal must not publish ready")
          },
        ),
      ).toMatchObject({ ok: false, code: "admission_unknown" })
      expect(site.calls).toHaveLength(1)
      expect(site.calls.some((call) => call.path === "/v1/sessions")).toBe(false)
      expect(broker.active).toBe(true)
    } finally {
      site.close()
    }
  }
})

test("broker retains backend until media finalization completes", async () => {
  const entered = gate()
  const resume = gate()
  const site = fixture(async (request) => {
    if (request.method === "DELETE" && new URL(request.url).pathname === "/v1/sessions/rvs_test") {
      entered.release()
      await resume.wait
    }
    return undefined
  })
  const broker = new RealtimeBroker()
  try {
    expect(
      await broker.start(
        async () => site.config,
        () => {},
      ),
    ).toMatchObject({ ok: true })
    const stop = broker.stop()
    await entered.wait
    expect(site.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/kilocode/"))).toBe(false)
    resume.release()
    expect(await stop).toBeUndefined()
    expect(site.calls.slice(-2).map((call) => call.path)).toEqual([
      "/v1/sessions/rvs_test",
      "/kilocode/voice/session/rvs_test",
    ])
  } finally {
    resume.release()
    site.close()
  }
})

test("stale ownership after MF admission closes captured resources and suppresses ready", async () => {
  let current = true
  const site = fixture(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/sessions") current = false
    return undefined
  })
  const broker = new RealtimeBroker()
  const ready: string[] = []
  try {
    expect(
      await broker.start(
        async () => ({ ...site.config, current: () => current }),
        (info) => ready.push(info.id),
      ),
    ).toMatchObject({ ok: false, code: "setup_failed" })
    expect(ready).toEqual([])
    expect(site.calls.slice(-2).map((call) => call.path)).toEqual([
      "/v1/sessions/rvs_test",
      "/kilocode/voice/session/rvs_test",
    ])
    expect(site.calls.at(-1)?.auth).toBe(site.config.auth)
    expect(broker.active).toBe(false)
  } finally {
    site.close()
  }
})
