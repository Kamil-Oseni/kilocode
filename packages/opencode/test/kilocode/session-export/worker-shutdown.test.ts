import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmRequestStarted } from "@/kilocode/session-export/events"
import type { FromWorker } from "@/kilocode/session-export/worker/ipc"
import { Storage } from "@/kilocode/session-export/worker/storage"
import { parseMessage } from "@/kilocode/session-export/worker/validate"

test("shutdown requires a correlated request identity", () => {
  expect(parseMessage({ kind: "shutdown", timeoutMs: 1000 })).toBeUndefined()
  expect(parseMessage({ kind: "shutdown", timeoutMs: 1000, requestID: "" })).toBeUndefined()
  expect(parseMessage({ kind: "shutdown", timeoutMs: 1000, requestID: "stop-1" })).toEqual({
    kind: "shutdown",
    timeoutMs: 1000,
    requestID: "stop-1",
  })
})

test("real worker joins event persistence before confirmed shutdown and fences late intake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "raya-export-shutdown-"))
  const file = join(dir, "session-export.db")
  const server = Bun.serve({ port: 0, fetch: () => new Response("later", { status: 503 }) })
  const worker = new Worker(new URL("../../../src/kilocode/session-export/worker.ts", import.meta.url))
  const messages: FromWorker[] = []
  worker.onmessage = (event: MessageEvent<FromWorker>) => messages.push(event.data)
  try {
    worker.postMessage({
      kind: "init",
      dbPath: file,
      endpoint: `http://127.0.0.1:${server.port}`,
      allowCustomEndpoint: true,
      agentVersion: "test",
      surface: "test",
    })
    await until(() => messages.some((message) => message.kind === "ready"))
    for (const seq of Array.from({ length: 80 }, (_, index) => index)) {
      worker.postMessage({ kind: "event", envelope: started(seq), approxBytes: 512 })
    }
    worker.postMessage({ kind: "shutdown", timeoutMs: 10_000, requestID: "shutdown-1" })
    worker.postMessage({ kind: "event", envelope: started(80), approxBytes: 512 })
    await until(() =>
      messages.some((message) => message.kind === "shutdown_done" || message.kind === "shutdown_refused"),
    )
    expect(messages.find((message) => message.kind === "shutdown_done" || message.kind === "shutdown_refused")).toEqual(
      {
        kind: "shutdown_done",
        requestID: "shutdown-1",
        status: "confirmed",
      },
    )
    const storage = new Storage(file)
    try {
      const rows = storage.pendingEvents({ now: 1_000_000_000_000_000, limitBytes: 10_000_000 })
      expect(rows).toHaveLength(80)
      expect(rows.map((row) => row.id).sort()).toEqual(
        Array.from({ length: 80 }, (_, index) => `export-${index}`).sort(),
      )
    } finally {
      storage.close()
    }
  } finally {
    await worker.terminate()
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

function started(seq: number): LlmRequestStarted {
  return {
    id: `export-${seq}`,
    schemaVersion: 1,
    type: "llm_request_started",
    sessionId: "s1",
    rootSessionId: "s1",
    seq,
    ts: 100 + seq,
    agentVersion: "test",
    requestId: `r-${seq}`,
    userMessageId: `u-${seq}`,
    agent: "build",
    modeId: "build",
    model: { providerId: "kilo", modelId: "free-1", isFree: true },
    input: { system: [], messages: [], tools: {}, permissions: [], params: {} },
    time: { created: 0 },
  }
}

async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 15_000) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for worker acknowledgement")
}
