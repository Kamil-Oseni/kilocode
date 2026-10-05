import { describe, expect, test } from "bun:test"
import { createServer, type ServerResponse } from "node:http"
import * as HttpHeaders from "effect/unstable/http/Headers"
import {
  createLocalScheduler,
  localConfig,
  localFetch,
  LocalInferenceError,
} from "../../../src/kilocode/provider/local-scheduler"

function fixture() {
  const starts: string[] = []
  const stops: string[] = []
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
  const requests: { path: string; body: string; header: string | null }[] = []
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const text = await request.text()
      starts.push(path)
      requests.push({ path, body: text, header: request.headers.get("x-value") })
      if (path === "/empty") return new Response(null, { status: 204 })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.set(path, controller)
          controller.enqueue(encoder.encode("data: ready\n\n"))
        },
        cancel() {
          streams.delete(path)
          stops.push(path)
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream", "x-fixture": path } })
    },
  })
  return {
    starts,
    stops,
    requests,
    url(path: string) {
      return new URL(path, server.url).href
    },
    end(path: string) {
      const controller = streams.get(path)
      if (!controller) throw new Error(`No fixture stream ${path}`)
      controller.close()
      streams.delete(path)
    },
    async close() {
      await server.stop(true)
    },
  }
}

async function until(check: () => boolean) {
  const end = Date.now() + 2_000
  while (!check()) {
    if (Date.now() >= end) throw new Error("Fixture condition timed out")
    await Bun.sleep(5)
  }
}

describe("local inference scheduler with real HTTP streams", () => {
  test("interactive requests overtake background work with a three-request fairness limit", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      const worker = queue.fetch(fetch, host.url("/worker"), undefined, "background")
      const jobs = [1, 2, 3, 4].map((id) => queue.fetch(fetch, host.url(`/chat${id}`), undefined, "interactive"))
      host.end("/first")
      await first.text()
      for (const [path, pending] of [
        ["/chat1", jobs[0]],
        ["/chat2", jobs[1]],
        ["/chat3", jobs[2]],
        ["/worker", worker],
        ["/chat4", jobs[3]],
      ] as const) {
        const response = await pending
        expect(host.starts.at(-1)).toBe(path)
        expect(queue.snapshot().active).toBe(1)
        host.end(path)
        await response.text()
      }
      expect(host.starts).toEqual(["/first", "/chat1", "/chat2", "/chat3", "/worker", "/chat4"])
      expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
    } finally {
      await host.close()
    }
  })

  test("one cached local transport classifies each call and strips its internal priority tag", async () => {
    const host = fixture()
    const tags: (string | null)[] = []
    const transport: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        tags.push(new Headers(init?.headers).get("x-raya-inference-lane"))
        return fetch(input, init)
      },
      { preconnect: fetch.preconnect },
    )
    const request = localFetch({ localInference: true }, transport)
    try {
      const first = await request(host.url("/first"))
      const worker = request(host.url("/worker"), {
        headers: { "x-raya-inference-lane": "background", "x-value": "worker" },
      })
      const chat = request(host.url("/chat"), {
        headers: new Headers({ "x-raya-inference-lane": "interactive", "x-value": "chat" }),
      })
      host.end("/first")
      await first.text()
      const reply = await chat
      expect(host.starts).toEqual(["/first", "/chat"])
      host.end("/chat")
      await reply.text()
      const background = await worker
      host.end("/worker")
      await background.text()
      expect(tags).toEqual([null, null, null])
      expect(host.requests.map((item) => item.header)).toEqual([null, "chat", "worker"])
    } finally {
      await host.close()
    }
  })

  test("headers do not release a slot; EOF admits the next request", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      expect(first.headers.get("x-fixture")).toBe("/first")
      const second = queue.fetch(fetch, host.url("/second"))
      await Bun.sleep(30)
      expect(host.starts).toEqual(["/first"])
      expect(queue.snapshot()).toEqual({ active: 1, queued: 1, bytes: 256 + Buffer.byteLength(host.url("/second")) })
      host.end("/first")
      expect(await first.text()).toBe("data: ready\n\n")
      const response = await second
      expect(host.starts).toEqual(["/first", "/second"])
      host.end("/second")
      await response.text()
      expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
    } finally {
      await host.close()
    }
  })

  test("queued abort removes retained bytes without dispatch", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      const abort = new AbortController()
      const reason = new Error("cancel queued inference")
      const result = queue
        .fetch(fetch, host.url("/cancelled"), { method: "POST", body: "violin", signal: abort.signal })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      // Body key (4), method key/value (6+4), and six UTF-8 body bytes.
      expect(queue.snapshot().bytes).toBe(256 + Buffer.byteLength(host.url("/cancelled")) + 4 + 6 + 4 + 6)
      abort.abort(reason)
      expect(await result).toBe(reason)
      expect(queue.snapshot()).toEqual({ active: 1, queued: 0, bytes: 0 })
      host.end("/first")
      await first.text()
      expect(host.starts).toEqual(["/first"])
    } finally {
      await host.close()
    }
  })

  test("active external abort errors its body and releases the slot", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    try {
      const abort = new AbortController()
      const first = await queue.fetch(fetch, host.url("/first"), { signal: abort.signal })
      const body = first.text().then(
        () => undefined,
        (error: unknown) => error,
      )
      const second = queue.fetch(fetch, host.url("/second"))
      const reason = new Error("cancel active inference")
      abort.abort(reason)
      expect(await body).toBe(reason)
      const response = await second
      await until(() => host.stops.includes("/first"))
      expect(host.starts).toEqual(["/first", "/second"])
      host.end("/second")
      await response.text()
      expect(queue.snapshot().active).toBe(0)
    } finally {
      await host.close()
    }
  })

  test("consumer cancellation and empty responses release slots", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      const second = queue.fetch(fetch, host.url("/second"))
      await first.body!.cancel("consumer finished")
      const response = await second
      host.end("/second")
      await response.text()
      expect(queue.snapshot().active).toBe(0)
      const empty = await queue.fetch(fetch, host.url("/empty"))
      expect(empty.status).toBe(204)
      expect(queue.snapshot().active).toBe(0)
    } finally {
      await host.close()
    }
  })

  test("queue count, encoded bytes, unknown bodies and age reject without HTTP dispatch", async () => {
    const host = fixture()
    const budget = 256 + Buffer.byteLength(host.url("/waiting")) + 4 + 6 + 4 + 4
    const queue = createLocalScheduler({ count: 1, bytes: budget, age: 80 })
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      const over = await queue.fetch(fetch, host.url("/large"), { method: "POST", body: "é".repeat(500) }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(over).toBeInstanceOf(LocalInferenceError)
      expect(over).toMatchObject({ code: "queue-full", isRetryable: false })
      const opaque = await queue.fetch(fetch, new Request(host.url("/opaque"), { method: "POST", body: "a" })).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(opaque).toMatchObject({ code: "body-unknown" })
      const sliced = new Blob(["large retained backing store"]).slice(0, 1)
      const blob = await queue.fetch(fetch, host.url("/blob"), { method: "POST", body: sliced }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(blob).toMatchObject({ code: "body-unknown" })
      const waiting = queue.fetch(fetch, host.url("/waiting"), { method: "POST", body: "abcd" }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(queue.snapshot()).toEqual({ active: 1, queued: 1, bytes: budget })
      const full = await queue.fetch(fetch, host.url("/full")).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(full).toMatchObject({ code: "queue-full" })
      expect(await waiting).toMatchObject({ code: "queue-timeout" })
      expect(queue.snapshot()).toEqual({ active: 1, queued: 0, bytes: 0 })
      host.end("/first")
      await first.text()
      expect(host.starts).toEqual(["/first"])
    } finally {
      await host.close()
    }
  })

  test("real HTTP socket failure releases the streaming slot", async () => {
    let response: ServerResponse | undefined
    const server = createServer((_request, output) => {
      response = output
      output.writeHead(200, { "content-type": "text/event-stream", "content-length": "1000" })
      output.write("data: ready\n\n")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture address")
    const queue = createLocalScheduler()
    try {
      const first = await queue.fetch(fetch, `http://127.0.0.1:${address.port}`)
      const result = first.text().then(
        () => false,
        () => true,
      )
      response!.destroy()
      expect(await result).toBe(true)
      expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    }
  })

  test("queued URL, headers and mutable bytes are snapshotted; headers cannot bypass the byte budget", async () => {
    const host = fixture()
    const queue = createLocalScheduler({ bytes: 1024 })
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      const url = new URL(host.url("/saved"))
      const headers = new Headers({ "x-value": "original" })
      const body = new TextEncoder().encode("old")
      const opts = { method: "POST", headers, body }
      const waiting = queue.fetch(fetch, url, opts)
      url.pathname = "/mutated"
      headers.set("x-value", "mutated".repeat(1000))
      body.fill(120)
      opts.method = "PUT"
      const large = await queue.fetch(fetch, host.url("/large"), { headers: { "x-value": "x".repeat(1024) } }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(large).toMatchObject({ code: "queue-full" })
      expect(queue.snapshot().bytes).toBeLessThan(1024)
      host.end("/first")
      await first.text()
      const response = await waiting
      expect(host.requests[1]).toEqual({ path: "/saved", body: "old", header: "original" })
      host.end("/saved")
      await response.text()
      expect(host.starts).toEqual(["/first", "/saved"])
    } finally {
      await host.close()
    }
  })

  test("wrappers share a group regardless of directory, while cloud fetch is unchanged", async () => {
    const host = fixture()
    const main = localFetch({ localInference: true, directory: "/main" })
    const worker = localFetch({ localInference: true, directory: "/worker" })
    try {
      expect(localFetch({})).toBe(fetch)
      expect(localConfig({ localInference: "true" })).toEqual({ enabled: false })
      const first = await main(host.url("/main"))
      const second = worker(host.url("/worker"))
      const cloud = await localFetch({})(host.url("/cloud"))
      expect(host.starts).toEqual(["/main", "/cloud"])
      host.end("/cloud")
      await cloud.text()
      host.end("/main")
      await first.text()
      const response = await second
      host.end("/worker")
      await response.text()
      expect(host.starts).toEqual(["/main", "/cloud", "/worker"])
    } finally {
      await host.close()
    }
  })

  test("large scalar transport options cannot bypass the queued payload budget", async () => {
    const host = fixture()
    const queue = createLocalScheduler({ bytes: 1024 })
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      for (const key of ["referrer", "integrity", "proxy", "unix", "method"]) {
        const result = await queue.fetch(fetch, host.url("/oversized"), { [key]: "x".repeat(1024) }).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(result).toMatchObject({ code: "queue-full", isRetryable: false })
      }
      expect(queue.snapshot()).toEqual({ active: 1, queued: 0, bytes: 0 })
      host.end("/first")
      await first.text()
      expect(host.starts).toEqual(["/first"])
    } finally {
      await host.close()
    }
  })

  test("nested, unknown, accessor and invalid queued options fail without dispatch or sensitive diagnostics", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    try {
      const first = await queue.fetch(fetch, host.url("/first"))
      const inputs = [
        { tls: { ca: Buffer.alloc(1024), passphrase: "private-fixture-secret" } },
        { proxy: { url: "http://private-fixture-secret", headers: { "x-private": "private-fixture-secret" } } },
        { dispatcher: { retained: Buffer.alloc(1024) } },
        { cache: "private-fixture-secret" },
        { s3: { accessKeyId: "private-fixture-secret" } },
        {
          get integrity() {
            throw new Error("Queue must not invoke a caller accessor")
          },
        },
      ]
      for (const opts of inputs) {
        const input: NonNullable<Parameters<typeof fetch>[1]> = { method: "GET" }
        Object.defineProperties(input, Object.getOwnPropertyDescriptors(opts))
        const result = await queue.fetch(fetch, host.url("/unsupported"), input).then(
          () => undefined,
          (error: unknown) => error,
        )
        expect(result).toBeInstanceOf(LocalInferenceError)
        expect(result).toMatchObject({ code: "init-unknown", isRetryable: false })
        if (!(result instanceof LocalInferenceError)) throw new Error("Expected terminal local scheduler rejection")
        expect(result.message).not.toContain("private-fixture-secret")
      }
      const opaque = await queue.fetch(fetch, new Request(host.url("/request"))).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(opaque).toMatchObject({ code: "init-unknown" })
      expect(queue.snapshot()).toEqual({ active: 1, queued: 0, bytes: 0 })
      host.end("/first")
      await first.text()
      expect(host.starts).toEqual(["/first"])
    } finally {
      await host.close()
    }
  })

  test("supported scalar options are owned and retain their transport behavior after caller mutation", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    const seen: NonNullable<Parameters<typeof fetch>[1]>[] = []
    const transport = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(init ?? {})
      return fetch(input, init)
    }
    try {
      const first = await queue.fetch(transport, host.url("/first"))
      const opts: RequestInit & { duplex: "half"; verbose: boolean; decompress: boolean; timeout: false } = {
        method: "POST",
        body: "saved",
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        redirect: "manual",
        referrer: host.url("/origin"),
        referrerPolicy: "same-origin",
        integrity: "",
        priority: "high",
        keepalive: false,
        window: null,
        duplex: "half",
        verbose: false,
        decompress: false,
        timeout: false,
      }
      const waiting = queue.fetch(transport, host.url("/saved"), opts)
      opts.referrer = "x".repeat(10_000)
      opts.integrity = "x".repeat(10_000)
      opts.cache = "reload"
      opts.method = "PUT"
      host.end("/first")
      await first.text()
      const response = await waiting
      expect(seen[1]).toMatchObject({
        method: "POST",
        body: "saved",
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        redirect: "manual",
        referrer: host.url("/origin"),
        referrerPolicy: "same-origin",
        integrity: "",
        priority: "high",
        keepalive: false,
        window: null,
        duplex: "half",
        verbose: false,
        decompress: false,
        timeout: false,
      })
      expect(host.requests[1]).toEqual({ path: "/saved", body: "saved", header: null })
      host.end("/saved")
      await response.text()
      expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
    } finally {
      await host.close()
    }
  })

  test("immediate requests retain unknown transport objects and cloud bypass keeps identity", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    const marker = { retained: "caller-owned" }
    const opts = { method: "GET", fixture: marker }
    const seen: Parameters<typeof fetch>[1][] = []
    const transport = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(init)
      return fetch(input, init)
    }
    try {
      expect(localFetch({}, transport)).toBe(transport)
      const response = await queue.fetch(transport, host.url("/immediate"), opts)
      expect(seen[0]).toMatchObject({ fixture: marker })
      expect(Reflect.get(seen[0]!, "fixture")).toBe(marker)
      host.end("/immediate")
      await response.text()
      expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
    } finally {
      await host.close()
    }
  })

  test("real Effect header maps queue as copied own strings without retaining their branded prototype", async () => {
    const host = fixture()
    const queue = createLocalScheduler()
    const seen: NonNullable<Parameters<typeof fetch>[1]>[] = []
    const transport = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      seen.push(init ?? {})
      return fetch(input, init)
    }
    try {
      const first = await queue.fetch(transport, host.url("/first"))
      const headers = HttpHeaders.fromInput({ "content-type": "application/json", "x-value": "native-owned" })
      expect(Object.getPrototypeOf(headers)).not.toBe(Object.prototype)
      expect(HttpHeaders.isHeaders(headers)).toBe(true)
      const waiting = queue.fetch(transport, host.url("/native"), {
        method: "POST",
        headers,
        body: new TextEncoder().encode('{"model":"native-fixture"}'),
      })
      expect(queue.snapshot().queued).toBe(1)
      expect(host.starts).toEqual(["/first"])
      host.end("/first")
      await first.text()
      const response = await waiting
      expect(seen[1].headers).toBeInstanceOf(Headers)
      expect(seen[1].headers).not.toBe(headers)
      expect(HttpHeaders.isHeaders(seen[1].headers)).toBe(false)
      expect(host.requests[1]).toEqual({ path: "/native", body: '{"model":"native-fixture"}', header: "native-owned" })
      host.end("/native")
      await response.text()
      expect(queue.snapshot()).toEqual({ active: 0, queued: 0, bytes: 0 })
    } finally {
      await host.close()
    }
  })
})
