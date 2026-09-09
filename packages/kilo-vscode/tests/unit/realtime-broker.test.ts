import { expect, test } from "bun:test"
import { RealtimeBroker } from "../../src/speech/realtime-broker"
import { DEFAULT_SPEECH_SETTINGS } from "../../src/shared/speech"

function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function fixture(handle?: (request: Request) => Promise<Response | undefined>) {
  const calls: Array<{ method: string; path: string; auth: string | null; body: string }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push({
        method: request.method,
        path: new URL(request.url).pathname,
        auth: request.headers.get("Authorization"),
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
          engine: "qwen-realtime",
          acceptsTruncation: false,
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
    settings: { ...DEFAULT_SPEECH_SETTINGS, mediaFrontendURL: server.url.origin },
  }
  return { calls, config, close: () => server.stop(true) }
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
    expect(site.calls.filter((call) => call.method === "DELETE")).toHaveLength(2)
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

test("lost media acknowledgement cleans known backend but a not-found deletion cannot prove absent pending work", async () => {
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
    expect(site.calls.filter((call) => call.method === "DELETE")).toHaveLength(2)
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
