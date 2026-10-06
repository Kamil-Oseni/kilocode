import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import { createKiloClient, type SecondBrainRequest } from "@kilocode/sdk/v2/client"
import { BrainBridge } from "../../src/second-brain/bridge"
import { BrainSettings } from "../../src/second-brain/settings"
import { BrainService } from "../../src/second-brain/service"
import type { SSEPayload } from "../../src/services/cli-backend/sdk-sse-adapter"

class State {
  constructor(private readonly file: string) {}
  get<T>(key: string): T | undefined
  get<T>(key: string, fallback: T): T
  get<T>(key: string, fallback?: T) {
    return (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, T>)[key] ?? fallback
  }
  async update(key: string, value: unknown) {
    const rows: Record<string, unknown> = JSON.parse(readFileSync(this.file, "utf8"))
    rows[key] = value
    await Bun.write(this.file, JSON.stringify(rows))
  }
}

function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  let buffer = ""
  return {
    async next() {
      while (true) {
        while (!buffer.includes("\n")) {
          const value = await reader.read()
          if (value.done) throw new Error("Original fixture ended before expected result")
          buffer += new TextDecoder().decode(value.value)
        }
        const end = buffer.indexOf("\n")
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.startsWith("RAYA_FIXTURE ")) return JSON.parse(line.slice(13))
      }
    },
    async join() {
      while (!(await reader.read()).done) {
        /* Observe original EOF, never cancel it. */
      }
      reader.releaseLock()
    },
  }
}

test("real Tool to SDK bridge, BrainService and disposable FastAPI Store creates only pending proposal", async () => {
  const python = Bun.spawn(
    [
      "D:/Raya/Services/Packaging/Environments/PrimarySnapshot/Scripts/python.exe",
      "-B",
      path.resolve("script/memory/proposals_transport_fixture.py"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const errors = new Response(python.stderr).text()
  const output = lines(python.stdout)
  const cleanup: (() => Promise<void>)[] = []
  cleanup.push(async () => {
    try {
      python.stdin.write("STOP\n")
      await python.stdin.end()
    } finally {
      const [terminal, err] = await Promise.all([python.exited, errors, output.join()])
      expect(terminal).toBe(0)
      expect(err).toBe("")
    }
  })
  try {
    const info = (await output.next()) as { project: string; notes: string; key: string; setup: unknown }
    const settings = path.join(info.project, "settings.fixture.json")
    const secrets = path.join(info.project, "secrets.fixture.json")
    await Bun.write(settings, "{}")
    await Bun.write(secrets, "{}")
    const store = new State(secrets)
    const saved = new BrainSettings(new State(settings), {
      get: async (key) => store.get<string>(key),
      store: async (key, value) => store.update(key, value),
      delete: async (key) => store.update(key, undefined),
    })
    await saved.save(info.setup, info.key)
    const service = new BrainService(saved)
    cleanup.push(() => service.dispose())
    await Bun.write(path.join(info.project, "source.txt"), "Disposable source revision")
    const cli = Bun.spawn(
      [process.execPath, "run", "./test/kilocode/fixtures/second-brain-store-transport.ts", info.project],
      {
        cwd: path.resolve("../opencode"),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const logs = new Response(cli.stderr).text()
    const responses = lines(cli.stdout)
    cleanup.push(async () => {
      try {
        cli.stdin.write(JSON.stringify({ action: "stop" }) + "\n")
        await cli.stdin.end()
      } finally {
        const [code, log] = await Promise.all([cli.exited, logs, responses.join()])
        await Bun.write(path.join(info.project, "cli.stderr.private"), log)
        expect(code).toBe(0)
      }
    })
    const ready = (await responses.next()) as { origin: string }
    const arrival = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const client = createKiloClient({
      baseUrl: ready.origin,
      directory: info.project,
      async fetch(request, options) {
        const url = new URL(request instanceof Request ? request.url : String(request))
        if (url.pathname === "/event") {
          arrival.resolve()
          await gate.promise
        }
        return fetch(request, options)
      },
    })
    const callbacks = new Set<(event: SSEPayload, directory?: string) => void>()
    // Deliberately file-backed host adapter: no fabricated native workspace trust or user confirmation.
    const bridge = new BrainBridge(
      {
        getClient: () => client,
        getKnownDirectories: () => [info.project],
        onEvent: (callback) => {
          callbacks.add(callback)
          return () => {
            callbacks.delete(callback)
          }
        },
        onStateChange: () => () => undefined,
      },
      {
        async model(request, directory, signal) {
          if (request.project !== info.project || directory !== info.project) throw new Error("Foreign fixture project")
          const command = request.command as SecondBrainRequest["command"]
          const body =
            command.action === "propose"
              ? {
                  ...command,
                  request: {
                    sources: command.request.sources.map((row) => ({ ...row })),
                    changes: command.request.changes.map((row) => ({ ...row })),
                  },
                }
              : command
          const value = await service.proposal({ ...body, project: directory }, signal)
          const proposals = "proposals" in value ? value.proposals : [value]
          return {
            action: command.action,
            project: directory,
            proposals: proposals.map((row) => ({
              ...row,
              sources: [...row.sources],
              changes: [...row.changes],
            })),
          }
        },
      },
    )
    cleanup.push(() => bridge.close())
    const listener = new AbortController()
    const stream = await client.event.subscribe(
      { directory: info.project },
      { sseMaxRetryAttempts: 0, signal: listener.signal },
    )
    const connected = Promise.withResolvers<void>()
    const events = (async () => {
      for await (const event of stream.stream) {
        if (event.type === "server.connected") connected.resolve()
        for (const callback of callbacks) callback(event as SSEPayload, info.project)
      }
    })()
    const listening = Promise.race([
      connected.promise,
      events.then(() => {
        throw new Error("Original fixture event stream ended before connecting")
      }),
    ])
    cleanup.push(async () => {
      gate.resolve()
      await listening
      const ended = await fetch(new URL("/fixture/end-events", ready.origin), { method: "POST" })
      if (!ended.ok) throw new Error("Original fixture event producer did not close")
      const observed = await events.then(
        () => undefined,
        (error: unknown) => error,
      )
      listener.abort()
      if (observed !== undefined) throw observed
    })
    await arrival.promise
    const pending = await client.kilocode.secondBrain.list({ directory: info.project })
    expect(pending.error).toBeUndefined()
    expect(pending.data).toEqual([])
    gate.resolve()
    await listening
    const id = crypto.randomUUID()
    cli.stdin.write(JSON.stringify({ action: "propose", id }) + "\n")
    const result = await responses.next()
    expect(result.metadata.status).toBe("pending")
    expect(result.metadata.applied).toBe(false)
    expect(result.asks).toEqual(["read", "second_brain_proposal"])
    const ledger = await Bun.file(path.join(info.notes, "System/Proposals", id + ".json")).json()
    expect(ledger).toEqual(result.result.proposals[0])
    expect(ledger.project).toBe(info.project)
    expect(ledger.status).toBe("pending")
    expect(ledger.capture_enabled).toBe(false)
    expect(ledger.changes[0].before).toBeNull()
    expect(await Bun.file(path.join(info.notes, "Projects/review.md")).exists()).toBe(false)
    expect(await readdir(path.join(info.notes, "System/Changes"))).toEqual([])
  } finally {
    const faults: unknown[] = []
    for (const close of cleanup.reverse()) {
      await close().catch((error: unknown) => {
        faults.push(error)
      })
    }
    if (faults.length) throw new AggregateError(faults, "Original fixture cleanup failed")
  }
}, 30000)
