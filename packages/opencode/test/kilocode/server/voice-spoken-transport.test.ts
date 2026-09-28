import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer, type Socket } from "node:net"
import { Schema } from "effect"
import { OpenAIBinding } from "@/kilocode/voice/openai-protocol"
import * as Spoken from "@/kilocode/voice/openai-spoken"
import { SessionID } from "@/session/schema"

const fixture = fileURLToPath(new URL("../fixtures/voice-spoken-server.ts", import.meta.url))
const auth = `Basic ${Buffer.from("spoken-transport:synthetic-password").toString("base64")}`
const key = "a".repeat(64)
const fresh = "b".repeat(64)
const base = "/kilocode/voice/openai/session"

async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new Error("Expected bounded response stream")
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  const state = { bytes: 0 }
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return Buffer.concat(chunks).toString("utf8")
      state.bytes += chunk.value.byteLength
      if (state.bytes > limit) {
        await reader.cancel()
        throw new Error("Spoken transport stream exceeded its bound")
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function deadline<T>(work: Promise<T>, timeout = 30000) {
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer.id = setTimeout(() => reject(new Error("Spoken HTTP fixture exceeded its deadline")), timeout)
      }),
    ])
  } finally {
    if (timer.id) clearTimeout(timer.id)
  }
}

async function server(root: string) {
  const child = Bun.spawn([process.execPath, "--conditions=browser", fixture, root], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      KILO_TEST_HOME: path.join(root, "home"),
      KILO_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
      KILO_DB: path.join(root, "voice.sqlite"),
      RAYA_DB: path.join(root, "voice.sqlite"),
      KILO_DISABLE_MODELS_FETCH: "true",
      KILO_DISABLE_AUTOUPDATE: "true",
      KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      KILO_SERVER_USERNAME: "spoken-transport",
      KILO_SERVER_PASSWORD: "synthetic-password",
      RAYA_SERVER_USERNAME: "spoken-transport",
      RAYA_SERVER_PASSWORD: "synthetic-password",
    },
  })
  const reader = child.stdout.getReader()
  const failure = bounded(child.stderr, 65536).catch((err: unknown) => String(err))
  const state = { output: "" }
  const next = async (prefix: string) => {
    while (true) {
      const boundary = state.output.indexOf("\n")
      if (boundary >= 0) {
        const line = state.output.slice(0, boundary).trim()
        state.output = state.output.slice(boundary + 1)
        if (line.startsWith(prefix)) return JSON.parse(line.slice(prefix.length)) as unknown
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Spoken server stopped before ${prefix}: ${await failure}`)
      state.output += new TextDecoder().decode(chunk.value)
      if (state.output.length > 65536) throw new Error("Spoken server output exceeded its bound")
    }
  }
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
    reader.releaseLock()
  }
  const value = await deadline(next("SPOKEN_READY "), 45000)
    .then((ready) =>
      Schema.decodeUnknownSync(
        Schema.Struct({
          url: Schema.String,
          pid: Schema.Number,
          database: Schema.Array(Schema.Struct({ name: Schema.String, file: Schema.String })),
        }),
      )(ready),
    )
    .then((value) => {
      const url = new URL(value.url)
      if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || value.pid !== child.pid)
        throw new Error("Spoken server returned an unexpected identity or destination")
      return { ...value, url }
    })
    .catch(async (err: unknown) => {
      await stop()
      throw err
    })
  return {
    url: value.url,
    database: value.database,
    stop,
    inspect: async () => {
      child.stdin.write("inspect\n")
      await child.stdin.flush()
      return Schema.decodeUnknownSync(
        Schema.Struct({
          messages: Schema.Number,
          bindings: Schema.Array(
            Schema.Struct({ id: Schema.String, calls: Schema.Record(Schema.String, Schema.Unknown) }),
          ),
        }),
      )(await deadline(next("SPOKEN_INSPECT ")))
    },
  }
}

function request(url: URL, root: string, method: string, route: string, body?: unknown, secret = key) {
  return fetch(new URL(route, url), {
    method,
    signal: AbortSignal.timeout(20000),
    redirect: "error",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      "x-kilo-directory": root,
      "x-raya-voice-key": secret,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function admit(url: URL, root: string, parent: string, secret: string, call: string) {
  const input = { parentSessionID: parent, providerCallID: call, requestID: `${call}_request` }
  const reserved = await request(
    url,
    root,
    "POST",
    "/kilocode/voice/openai/reservation",
    { parentSessionID: parent, requestID: input.requestID, model: "gpt-realtime-2.1" },
    secret,
  )
  expect(reserved.status).toBe(200)
  const started = await request(url, root, "POST", base, input, secret)
  expect(started.status).toBe(200)
  return Schema.decodeUnknownSync(OpenAIBinding)(await started.json())
}

async function proxy(url: URL, root: string, route: string) {
  const committed = Promise.withResolvers<typeof Spoken.Receipt.Type>()
  const state = { requests: 0, bytes: 0, response: 0, connections: 0 }
  const sockets = new Set<Socket>()
  const listener = createServer((socket) => {
    if (++state.connections !== 1) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.once("error", (err) => committed.reject(err))
    socket.setTimeout(20000, () => socket.destroy(new Error("Spoken proxy socket exceeded its deadline")))
    const input = { bytes: Buffer.alloc(0), forwarded: false }
    const forward = async (body: Buffer) => {
      const upstream = await fetch(new URL(route, url), {
        method: "POST",
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(20000),
        redirect: "error",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "x-kilo-directory": root,
          "x-raya-voice-key": key,
        },
      })
      if (upstream.status !== 200) throw new Error(`Upstream spoken publication refused: ${upstream.status}`)
      const receipt = await bounded(upstream.body, 4096)
      committed.resolve(Schema.decodeUnknownSync(Spoken.Receipt)(JSON.parse(receipt)))
      // Raw TCP closes without writing a single HTTP response byte after the upstream commit.
      state.response = socket.bytesWritten
      socket.destroy()
    }
    socket.on("data", (chunk) => {
      try {
        if (input.forwarded) throw new Error("Unexpected pipelined proxy request")
        input.bytes = Buffer.concat([input.bytes, chunk])
        if (input.bytes.length > 40960) throw new Error("Spoken proxy request exceeded its bound")
        const boundary = input.bytes.indexOf("\r\n\r\n")
        if (boundary < 0) {
          if (input.bytes.length > 8192) throw new Error("Spoken proxy headers exceeded their bound")
          return
        }
        if (boundary > 8192) throw new Error("Spoken proxy headers exceeded their bound")
        const head = input.bytes.subarray(0, boundary).toString("ascii").split("\r\n")
        if (head[0] !== `POST ${route} HTTP/1.1`) throw new Error("Unexpected proxy request")
        const lengths = head.filter((line) => /^content-length:/i.test(line))
        if (lengths.length !== 1 || head.some((line) => /^transfer-encoding:/i.test(line)))
          throw new Error("Expected one fixed-length proxy request")
        const length = Number(lengths[0].slice(lengths[0].indexOf(":") + 1).trim())
        if (!Number.isSafeInteger(length) || length < 1 || length > 32768)
          throw new Error("Spoken proxy body exceeded its bound")
        const body = input.bytes.subarray(boundary + 4)
        if (body.length < length) return
        if (body.length !== length || ++state.requests !== 1) throw new Error("Unexpected proxy body or retry")
        state.bytes = body.length
        input.forwarded = true
        void forward(body).catch((err: unknown) => {
          committed.reject(err)
          socket.destroy(err instanceof Error ? err : new Error("Spoken proxy failed"))
        })
      } catch (err) {
        committed.reject(err)
        socket.destroy(err instanceof Error ? err : new Error("Spoken proxy failed"))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", resolve)
  })
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Spoken proxy returned no loopback port")
  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    committed: committed.promise,
    state,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        if (!listener.listening) return resolve()
        listener.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

async function remove(root: string) {
  const target = path.resolve(root)
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("raya-spoken-http-"))
    throw new Error("Spoken HTTP cleanup escaped its exact disposable root")
  await rm(target, { recursive: true, force: true })
}

async function teardown(stopped: Array<() => Promise<void>>, root: string, original?: unknown) {
  const results = await Promise.allSettled(stopped.map((stop) => stop()))
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason)
  if (failures.length)
    throw new AggregateError([original, ...failures], "Spoken transport teardown could not confirm exit")
  await remove(root)
}

test("lost spoken HTTP acknowledgement is idempotent before an actual server restart and recovers without work replay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "raya-spoken-http-"))
  const stopped: Array<() => Promise<void>> = []
  const failure: { error?: unknown } = {}
  try {
    await mkdir(path.join(root, "workspace"))
    const dir = path.join(root, "workspace")
    await writeFile(
      path.join(dir, "opencode.json"),
      JSON.stringify({ formatter: false, lsp: false, share: "disabled", autoupdate: false }),
    )
    const first = await server(root)
    stopped.push(first.stop)
    expect(first.database.find((entry) => entry.name === "main")?.file).toBe(path.join(root, "voice.sqlite"))
    const created = await request(first.url, dir, "POST", "/session", {})
    expect(created.status).toBe(200)
    const parent = Schema.decodeUnknownSync(Schema.Struct({ id: SessionID }))(await created.json())
    const old = await admit(first.url, dir, parent.id, key, "spoken_http_before")
    const route = `${base}/${old.id}/spoken`
    const snapshot = {
      version: 1,
      revision: 1,
      generation: old.generation,
      providerCallID: old.providerCallID,
      items: [
        { id: "answer", previous: "interrupted", role: "user", state: "final", text: "Practice daily" },
        { id: "question", previous: null, role: "user", state: "final", text: "Learn violin" },
        { id: "interrupted", previous: "question", role: "assistant", state: "omitted" },
      ],
    }
    const broken = await proxy(first.url, dir, route)
    stopped.push(broken.stop)
    const missing = request(broken.url, dir, "POST", route, snapshot).then(
      () => false,
      () => true,
    )
    const receipt = await deadline(broken.committed)
    expect(await missing).toBe(true)
    expect(broken.state.requests).toBe(1)
    expect(broken.state.response).toBe(0)
    const retried = await request(first.url, dir, "POST", route, snapshot)
    expect(retried.status).toBe(200)
    expect(Schema.decodeUnknownSync(Spoken.Receipt)(await retried.json())).toEqual(receipt)
    expect(
      (
        await request(first.url, dir, "POST", route, {
          ...snapshot,
          items: snapshot.items.map((item) => (item.id === "question" ? { ...item, text: "Conflicting text" } : item)),
        })
      ).status,
    ).toBe(409)
    const before = await first.inspect()
    expect(before.messages).toBe(0)
    expect(before.bindings.every((binding) => Object.keys(binding.calls).length === 0)).toBe(true)
    await first.stop()
    stopped.splice(stopped.indexOf(first.stop), 1)
    const second = await server(root)
    stopped.push(second.stop)
    expect(second.database.find((entry) => entry.name === "main")?.file).toBe(path.join(root, "voice.sqlite"))
    expect((await request(second.url, dir, "POST", route, snapshot)).status).toBe(409)
    const binding = await admit(second.url, dir, parent.id, fresh, "spoken_http_after")
    const context = `${base}/${binding.id}/context?generation=${binding.generation}`
    expect((await request(second.url, dir, "GET", context)).status).toBe(401)
    expect(
      (await request(second.url, dir, "GET", `${base}/${binding.id}/context?generation=stale`, undefined, fresh))
        .status,
    ).toBe(409)
    const recovered = await request(second.url, dir, "GET", context, undefined, fresh)
    expect(recovered.status).toBe(200)
    const history = Schema.decodeUnknownSync(Spoken.Context)(await recovered.json())
    expect(history.items.map((item) => item.text)).toEqual(["Learn violin", "Practice daily"])
    expect(history.items.every((item) => item.bindingID === old.id)).toBe(true)
    const messages = await request(second.url, dir, "GET", `/session/${parent.id}/message`)
    expect(messages.status).toBe(200)
    expect(await messages.json()).toEqual([])
    const after = await second.inspect()
    expect(after.messages).toBe(0)
    expect(after.bindings.every((binding) => Object.keys(binding.calls).length === 0)).toBe(true)
  } catch (err) {
    failure.error = err
    throw err
  } finally {
    await teardown(stopped, root, failure.error)
  }
}, 120000)
