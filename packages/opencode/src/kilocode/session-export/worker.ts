import { Config } from "./config"
import { Chunker } from "./worker/chunks"
import { handleBatch } from "./worker/handlers"
import { Inbox } from "./worker/inbox"
import type { FromWorker } from "./worker/ipc"
import { Scrubber } from "./worker/scrub"
import { Storage } from "./worker/storage"
import { Uploader } from "./worker/uploader"
import { checkBufferCap } from "./worker/buffer-cap"
import { resolveEndpoint } from "./worker/endpoint"
import { parseMessage } from "./worker/validate"
import path from "node:path"

type Scope = {
  onmessage: (event: MessageEvent<unknown>) => void
  postMessage: (message: FromWorker | { kind: "test_event_count"; count: number }) => void
}

type ShutdownReply = Extract<FromWorker, { kind: "shutdown_done" | "shutdown_refused" }>

const scope = self as unknown as Scope

let storage: Storage | undefined
let chunker: Chunker | undefined
let scrubber: Scrubber | undefined
let inbox: Inbox | undefined
let uploader: Uploader | undefined
let active: Promise<void> | undefined
let tripped = false
let stopping = false
let failed = false
let shutdown: Promise<ShutdownReply> | undefined

function drain(): Promise<void> {
  if (active) return active
  if (failed) return Promise.resolve()
  const task = (async () => {
    while (inbox && storage && chunker && scrubber) {
      const batch = inbox.take(64, Config.flushSizeBytes)
      if (batch.length === 0) break
      try {
        await handleBatch(
          batch.map((item) => item.envelope),
          {
            storage,
            chunker,
            scrubber,
            inlineThresholdBytes: Config.inlineThresholdBytes,
            maxPayloadBytes: Config.maxPayloadBytes,
            batchBytes: Config.ringBufferBytes,
          },
        )
        inbox.commit(batch)
        uploader?.scheduleFlush("event_persisted")
      } catch (err) {
        inbox.restore(batch)
        failed = true
        scope.postMessage({
          kind: "telemetry",
          name: "session_export.handler_error",
          props: { message: String(err), retainedEvents: batch.length, queuedBytes: inbox.usedBytes() },
        })
        return
      }
    }
  })()
    .catch((err) => {
      failed = true
      scope.postMessage({ kind: "telemetry", name: "session_export.drain_error", props: { message: String(err) } })
    })
    .finally(() => {
      if (active === task) active = undefined
    })
  active = task
  return task
}

async function stop(requestID: string): Promise<ShutdownReply> {
  stopping = true
  try {
    uploader?.dispose()
    await drain()
    if (failed) return { kind: "shutdown_refused", requestID, reason: "event-persistence-failed" }
    await uploader?.flush("shutdown")
    uploader?.dispose()
    storage?.close()
    clearInterval(cap)
    storage = undefined
    chunker = undefined
    scrubber = undefined
    inbox = undefined
    uploader = undefined
    return { kind: "shutdown_done", requestID, status: "confirmed" }
  } catch (err) {
    scope.postMessage({ kind: "telemetry", name: "session_export.shutdown_error", props: { message: String(err) } })
    return { kind: "shutdown_refused", requestID, reason: "shutdown-failed" }
  }
}

scope.onmessage = (event) => {
  const msg = parseMessage(event.data)
  if (!msg) {
    scope.postMessage({ kind: "telemetry", name: "session_export.invalid_worker_message" })
    return
  }
  switch (msg.kind) {
    case "init":
      if (stopping) return
      storage = new Storage(msg.dbPath)
      storage.migrate()
      chunker = new Chunker(storage, { chunkBytes: Config.chunkBytes })
      scrubber = new Scrubber()
      inbox = new Inbox({ capacityBytes: Config.ringBufferBytes })
      uploader = new Uploader({
        storage,
        endpoint: resolveEndpoint({
          endpoint: msg.endpoint,
          env: process.env.KILO_SESSION_EXPORT_INGEST,
          allowCustom: msg.allowCustomEndpoint || process.env.KILO_SESSION_EXPORT_ALLOW_CUSTOM_INGEST === "1",
        }),
        fetch: globalThis.fetch,
        reportTelemetry: (item) => scope.postMessage(item),
        agentVersion: msg.agentVersion ?? "unknown",
        surface: msg.surface ?? "unknown",
        anonId: msg.anonId,
        anonIdPath: path.join(path.dirname(msg.dbPath), "telemetry-id"),
      })
      tripped = false
      scope.postMessage({ kind: "ready" })
      return
    case "event": {
      if (tripped || stopping || failed) return
      if (!inbox) return
      const result = inbox.enqueue(msg.envelope.sessionId, msg.approxBytes, msg.envelope)
      if (!result.accepted && result.sessionFirstOverflow) {
        scope.postMessage({ kind: "pressure", sessionId: msg.envelope.sessionId })
      }
      void drain()
      return
    }
    case "test_event_count":
      void (async () => {
        await drain()
        const count = storage?.pendingEvents({ now: Date.now() + 1, limitBytes: 100_000_000 }).length ?? 0
        scope.postMessage({ kind: "test_event_count", count })
      })()
      return
    case "shutdown":
      stopping = true
      shutdown ??= stop(msg.requestID)
      void shutdown.then((reply) => scope.postMessage(reply))
      return
    case "network_reconnect":
      if (stopping) return
      uploader?.scheduleFlush("network_reconnect")
      return
  }
}

const cap = setInterval(() => {
  if (!storage || tripped || stopping) return
  const result = checkBufferCap(storage, { capacityBytes: Config.bufferCapBytes })
  if (!result.tripped) return
  tripped = true
  scope.postMessage({ kind: "telemetry", name: "session_export.buffer_overflow", props: { dbSize: result.dbSize } })
  scope.postMessage({ kind: "kill_switch", reason: "buffer_cap_50gb" })
}, 60_000)
cap.unref?.()
