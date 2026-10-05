import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { ClientV2 } from "../../src/second-brain/client-v2"
import { object } from "../../src/second-brain/control/frames"

type Case = {
  name: string
  selected: { request: string; epoch: string; release: string; kind: "search" | "sync"; digest: string }
  downstream: { request: string; epoch: string; release: string; digest: string }[]
  body: { query?: string; top?: number; expected_policy_sha256?: string }
  pending: string
  terminal: string
  response: string | null
}
const source = process.env.RAYA_MEMORY_OPERATION_SOURCE
const python = process.env.RAYA_MEMORY_OPERATION_PYTHON
const genuine = source && python ? test : test.skip
const bytes = (value: string) => Buffer.from(value, "base64")
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex")
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const fixture: () => Promise<{ cases: Case[]; source_sha256: { [key: string]: string } }> = (() => {
  let memo: Promise<{ cases: Case[]; source_sha256: { [key: string]: string } }> | undefined
  return () =>
    (memo ??= (async () => {
      if (!python || !source) throw new Error("Pinned pure producer dependencies required")
      expect(digest(await readFile(python))).toBe("b7a12c3af0b4db44191eec14ea095eba731b7328917f570806183093d19ddca2")
      const child = Bun.spawn(
        [python, "-I", "-S", "-B", path.join(import.meta.dir, "fixtures/memory-client-v2-producer.py"), source],
        {
          windowsHide: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          },
        },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(0)
      expect(err).toBe("")
      expect(Buffer.byteLength(out)).toBeLessThan(65536)
      const value = JSON.parse(out)
      expect(value.sourceReviewSHA).toBe("f99cc7a0819bb7c2216c727e03620ca56ac3b1e8fc94ef0207ad3e7ccda7d037")
      return value
    })())
})()

async function server(
  item: Case,
  change: {
    health?: object
    response?: Uint8Array
    status?: number
    terminal?: Uint8Array
    acknowledgement?: object
  } = {},
) {
  const data = await fixture()
  const calls: { method: string; path: string; epoch: string | null; id: string | null; body: string }[] = []
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const body = await request.text()
      calls.push({
        method: request.method,
        path: pathname,
        epoch: request.headers.get("X-Raya-Memory-Owner-Epoch"),
        id: request.headers.get("X-Raya-Memory-Request-ID"),
        body,
      })
      if (pathname === "/health")
        return Response.json({
          ready: true,
          namespace_valid: true,
          draining: false,
          retirement_pending: false,
          retirement_unconfirmed: false,
          active: 0,
          capture_enabled: false,
          admission_required: true,
          root: "C:\\Synthetic",
          source_sha256: data.source_sha256,
          owner_epoch: item.selected.epoch,
          selected_release_sha256: item.selected.release,
          operation_protocol: "raya.memory.operation.v1",
          ...change.health,
        })
      if (request.method === "DELETE")
        return Response.json({
          request: item.selected.request,
          owner_epoch: item.selected.epoch,
          retirement_acknowledged: false,
          ...change.acknowledgement,
        })
      if (request.method === "GET")
        return new Response(Buffer.from(change.terminal ?? bytes(item.terminal)), {
          headers: { "Content-Type": "application/json" },
        })
      expect(JSON.parse(body)).toEqual(item.body)
      return new Response(Buffer.from(change.response ?? (item.response ? bytes(item.response) : Buffer.from("{}"))), {
        status: change.status ?? 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  const client = new ClientV2("synthetic-only", {
    format: "raya.memory.setup",
    version: 2,
    protocol: "raya.memory.operation.v1",
    root: "C:\\Synthetic",
    origin: `http://127.0.0.1:${host.port}`,
    source_sha256: data.source_sha256,
  })
  return { host, client, calls }
}

genuine("original durable write precedes one POST and raw Python result tokens remain intact", async () => {
  for (const item of (await fixture()).cases.filter((value) =>
    ["search-completed", "sync-completed"].includes(value.name),
  )) {
    const { host, client, calls } = await server(item)
    const barrier = deferred()
    const entered = deferred()
    let saved: unknown
    const opts = {
      id: item.selected.request,
      downstream: item.downstream,
      async before(request: unknown) {
        saved = request
        entered.resolve()
        await barrier.promise
      },
    }
    const job =
      item.selected.kind === "search"
        ? client.search(item.body.query!, opts)
        : client.sync(item.body.expected_policy_sha256!, opts)
    try {
      await entered.promise
      expect(calls.map((value) => value.method)).toEqual(["GET"])
      expect(saved).toMatchObject({
        id: item.selected.request,
        root: "C:\\Synthetic",
        owner_epoch: item.selected.epoch,
        selected_release_sha256: item.selected.release,
        bodySHA: item.selected.digest,
      })
      opts.id = "f".repeat(32)
      barrier.resolve()
      const result = await job
      expect(result).toBeDefined()
      expect(calls.map((value) => value.method)).toEqual(["GET", "POST"])
      expect(calls[1].epoch).toBe(item.selected.epoch)
      expect(calls[1].id).toBe(item.selected.request)
      expect(object((await client.observe(item.selected.request)).operation).operation_outcome).toBe("completed")
      opts.id = item.selected.request
      await expect(client.search("different", opts)).rejects.toThrow("fresh")
      expect(calls.filter((value) => value.method === "POST")).toHaveLength(1)
    } finally {
      barrier.resolve()
      await job.catch(() => undefined)
      await host.stop(true)
    }
  }
})

genuine("identity, durable-write failure and cancellation prevent POST before original write settlement", async () => {
  const item = (await fixture()).cases[0]
  for (const health of [
    { owner_epoch: "A".repeat(32) },
    { selected_release_sha256: "0".repeat(64) },
    { operation_protocol: "paged" },
    { source_sha256: {} },
  ]) {
    const { host, client, calls } = await server(item, { health })
    try {
      await expect(
        client.search(item.body.query!, {
          id: item.selected.request,
          before: async () => {
            throw new Error("must not run")
          },
        }),
      ).rejects.toThrow()
      expect(calls).toHaveLength(1)
    } finally {
      await host.stop(true)
    }
  }
  const { host, client, calls } = await server(item)
  const barrier = deferred()
  const entered = deferred()
  const abort = new AbortController()
  let settled = false
  const job = client
    .search(item.body.query!, {
      id: item.selected.request,
      signal: abort.signal,
      before: async () => {
        entered.resolve()
        await barrier.promise
      },
    })
    .finally(() => {
      settled = true
    })
  try {
    await entered.promise
    abort.abort(new Error("original cancellation"))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(calls).toHaveLength(1)
    barrier.resolve()
    await expect(job).rejects.toThrow("original cancellation")
    expect(calls.filter((value) => value.method === "POST")).toHaveLength(0)
    await expect(client.observe(item.selected.request)).rejects.toThrow("attempted")
  } finally {
    barrier.resolve()
    await job.catch(() => undefined)
    await host.stop(true)
  }
})

genuine(
  "failed POST is never replayed and DELETE is not terminal authority; original epoch remains selected",
  async () => {
    const item = (await fixture()).cases.find((value) => value.name === "search-cancelled")!
    const { host, client, calls } = await server(item, { status: 499 })
    try {
      await expect(
        client.search(item.body.query!, { id: item.selected.request, before: async () => undefined }),
      ).rejects.toThrow("do not resubmit")
      expect(await client.cancel(item.selected.request)).toEqual({ retirement_acknowledged: false })
      const value = await client.observe(item.selected.request)
      expect(object(value.operation).operation_outcome).toBe("cancelled")
      expect(calls.map((value) => value.method)).toEqual(["GET", "POST", "DELETE", "GET"])
      expect(
        calls.slice(1).every((value) => value.epoch === item.selected.epoch && value.id === item.selected.request),
      ).toBe(true)
      await expect(client.observe("f".repeat(32))).rejects.toThrow("original")
    } finally {
      await host.stop(true)
    }
  },
)

genuine("raw response corruption and scalar provenance refusal cannot mint a valid result", async () => {
  const item = (await fixture()).cases[0]
  const original = bytes(item.response!).toString("utf8")
  for (const response of [
    Buffer.from(original.replace('"embedding_similarity":1.0', '"embedding_similarity":1')),
    Buffer.from([255]),
    Buffer.from(original.replace('"version":1', '"version":1,"version":1')),
  ]) {
    const { host, client, calls } = await server(item, { response })
    try {
      await expect(
        client.search(item.body.query!, { id: item.selected.request, before: async () => undefined }),
      ).rejects.toThrow()
      expect(calls.filter((value) => value.method === "POST")).toHaveLength(1)
    } finally {
      await host.stop(true)
    }
  }
})

genuine(
  "genuine correlated responses still refuse escaped paths, coordinates, scores and inconsistent counts",
  async () => {
    for (const item of (await fixture()).cases.filter((value) => /-(escape|score|line|counts)$/.test(value.name))) {
      const { host, client, calls } = await server(item)
      try {
        const opts = { id: item.selected.request, before: async () => undefined }
        const job =
          item.selected.kind === "sync"
            ? client.sync(item.body.expected_policy_sha256!, opts)
            : client.search(item.body.query!, opts)
        await expect(job).rejects.toThrow()
        expect(calls.filter((value) => value.method === "POST")).toHaveLength(1)
      } finally {
        await host.stop(true)
      }
    }
  },
)

genuine("original write failure is exact and failed POST inspection never adopts a replacement owner", async () => {
  const item = (await fixture()).cases[0]
  const first = await server(item)
  const error = new Error("original journal failure")
  try {
    await expect(
      first.client.search(item.body.query!, {
        id: item.selected.request,
        before: async () => {
          throw error
        },
      }),
    ).rejects.toBe(error)
    expect(first.calls.map((value) => value.method)).toEqual(["GET"])
  } finally {
    await first.host.stop(true)
  }
  const change = { status: 499, terminal: bytes(item.terminal) }
  const next = await server(item, change)
  try {
    await expect(
      next.client.search(item.body.query!, { id: item.selected.request, before: async () => undefined }),
    ).rejects.toThrow()
    change.terminal = Buffer.from(bytes(item.terminal).toString("utf8").replace(item.selected.epoch, "f".repeat(32)))
    await expect(next.client.observe(item.selected.request)).rejects.toThrow("selection differs")
    expect(next.calls.map((value) => value.method)).toEqual(["GET", "POST", "GET"])
    expect(next.calls[2].epoch).toBe(item.selected.epoch)
  } finally {
    await next.host.stop(true)
  }
})

genuine(
  "original pending operation stays pending and cancellation success cannot be mistaken for retirement",
  async () => {
    const item = (await fixture()).cases[0]
    const change = { status: 499, terminal: bytes(item.pending), acknowledgement: { retirement_acknowledged: true } }
    const { host, client, calls } = await server(item, change)
    try {
      await expect(
        client.search(item.body.query!, { id: item.selected.request, before: async () => undefined }),
      ).rejects.toThrow()
      expect(object((await client.observe(item.selected.request)).operation).status).toBe("pending")
      await expect(client.cancel(item.selected.request)).rejects.toThrow("acknowledgement differs")
      expect(calls.map((value) => value.method)).toEqual(["GET", "POST", "GET", "DELETE"])
      expect(calls.slice(1).every((value) => value.epoch === item.selected.epoch)).toBe(true)
    } finally {
      await host.stop(true)
    }
  },
)
