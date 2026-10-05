import type { Agent } from "@/agent/agent"
import { Capture, type CaptureDeps } from "./capture"
import { Config } from "./config"
import { setKillSwitch } from "./eligibility"
import { createSequencer } from "./sequence"
import { SyncSubscriber } from "./sync-subscriber"
import { closeExportOwners, exportFailure } from "./cleanup"
import { stopExportWorker } from "./worker-stop"
import * as Identity from "./worker-identity"
import type { WorkerIdentity, ShutdownReply } from "./worker/ipc"

declare global {
  const KILO_SESSION_EXPORT_WORKER_PATH: string
}

type WorkerTarget = string | URL
type Opts = {
  agentVersion: string
  dbPath: string
  endpoint?: string
  surface: string
  anonId?: string
  workspaceKey: string
  snapshotProvider?: CaptureDeps["snapshotProvider"]
  syncSeq: (sessionId: string) => number
  subscribeAll: (cb: (event: unknown) => void) => () => void
  createWorker: (url: WorkerTarget) => Worker
  sequencer?: ReturnType<typeof createSequencer>
}
type Instance = { options: Opts; capture: Capture; subscriber: SyncSubscriber; unsubscribe: () => void }

let worker: Worker | undefined
let attempts = 0
let shared: Opts | undefined
let closing: Promise<void> | undefined
let stopping = false
let refused = false
const instances = new Map<string, Instance>()
const sequences = new Map<string, ReturnType<typeof createSequencer>>()
const identities = new WeakMap<Worker, WorkerIdentity>()
const historical = new Map<string, ShutdownReply>()
const run = process.env.KILO_RUN_ID ?? crypto.randomUUID()

const maxRespawns = 3

export const enabled = false

/** Loaded confirmed children only; this never starts a worker or initializes a profile. */
export const receipts = () => Object.freeze([...historical.values()])

export const init = (opts: {
  agentVersion: string
  dbPath: string
  endpoint?: string
  surface?: string
  anonId?: string
  snapshotProvider?: CaptureDeps["snapshotProvider"]
  workspaceKey?: string
  syncSeq?: (sessionId: string) => number
  subscribeAll: (cb: (event: unknown) => void) => () => void
  createWorker?: (url: WorkerTarget) => Worker
}): void => {
  if (stopping || refused) throw new Error("Session export shutdown is not confirmed")
  closing = undefined
  if (shared && shared.dbPath !== opts.dbPath) throw new Error("Session export database identity changed")
  const key = opts.workspaceKey ?? "default"
  if (instances.get(key)?.capture.busy()) throw new Error("Session export workspace capture is still active")
  const url = target()
  try {
    const previous = instances.get(key)
    forget(previous)
    const sequencer = opts.syncSeq ? undefined : createSequencer(opts.dbPath)
    if (sequencer) sequences.set(`${key}:${crypto.randomUUID()}`, sequencer)
    const syncSeq = opts.syncSeq ?? ((sessionId: string) => sequencer!.next(sessionId))
    const next: Opts = {
      agentVersion: opts.agentVersion,
      dbPath: opts.dbPath,
      endpoint: opts.endpoint,
      surface: opts.surface ?? currentSurface(),
      anonId: opts.anonId,
      workspaceKey: key,
      snapshotProvider: opts.snapshotProvider,
      syncSeq,
      subscribeAll: opts.subscribeAll,
      createWorker: opts.createWorker ?? ((file) => new Worker(file)),
      sequencer,
    }
    shared = shared ?? next
    if (worker) {
      configure(next)
      return
    }
    shared = next
    spawn(url)
  } catch (err) {
    fail(err)
  }
}

export const beforeRequest = (...args: Parameters<Capture["beforeRequest"]>): void => {
  captureFor(args[0].requestMeta.workspaceKey)?.beforeRequest(...args)
}

export const afterRequest = (...args: Parameters<Capture["afterRequest"]>): void => {
  captureFor(args[0].workspaceKey)?.afterRequest(...args)
}

export const compaction = (args: Parameters<Capture["compaction"]>[0]): void => {
  captureFor(args.workspaceKey)?.compaction(args)
}

export const agentInfo = (info: Agent.Info): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    name: info.name,
    mode: info.mode,
  }
  if (info.displayName !== undefined) out.displayName = info.displayName
  if (info.description !== undefined) out.description = info.description
  if (info.deprecated !== undefined) out.deprecated = info.deprecated
  if (info.native !== undefined) out.native = info.native
  if (info.hidden !== undefined) out.hidden = info.hidden
  if (info.topP !== undefined) out.topP = info.topP
  if (info.temperature !== undefined) out.temperature = info.temperature
  if (info.color !== undefined) out.color = info.color
  if (info.model !== undefined) out.model = info.model
  if (info.variant !== undefined) out.variant = info.variant
  if (info.steps !== undefined) out.steps = info.steps
  return out
}

export const onSessionClose = async (sessionId: string, workspaceKey?: string): Promise<void> => {
  await captureFor(workspaceKey)?.onSessionClose(sessionId)
}

export const shutdown = (): Promise<void> => {
  if (closing) return closing
  if (refused) return Promise.reject(new Error("Session export shutdown is not confirmed"))
  if (!worker && sequences.size === 0 && instances.size === 0) return Promise.resolve()
  const current = worker
  stopping = true
  const captures = [...instances.values()].map((item) => item.capture)
  const owner = current ? identities.get(current) : undefined
  const request = owner ? Identity.request(owner) : undefined
  const task = Promise.resolve().then(async () => {
    const errors: unknown[] = []
    let drained = false
    let exited = false
    try {
      for (const item of instances.values()) {
        try {
          item.unsubscribe()
        } catch (err) {
          errors.push(err)
        }
      }
      const deadline = Date.now() + Config.shutdownFlushTimeoutMs + 500
      const bounded = <T>(work: Promise<T>, phase: string): Promise<T> => {
        const timer: { value?: ReturnType<typeof setTimeout> } = {}
        return Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer.value = setTimeout(
              () => reject(new Error(`Session export shutdown timed out during ${phase}`)),
              Math.max(0, deadline - Date.now()),
            )
          }),
        ]).finally(() => clearTimeout(timer.value))
      }
      const settled = await bounded(Promise.allSettled(captures.map((capture) => capture.settle())), "capture drain")
      drained = true
      const failed = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      errors.push(...failed)
      if (current) {
        const remaining = Math.floor(deadline - Date.now())
        if (remaining <= 0) throw new Error("Session export shutdown timed out before worker shutdown")
        if (!request) throw new Error("Session export worker identity is unavailable")
        const reply = await stopExportWorker(current, request, remaining)
        historical.set(reply.generation, reply)
      }
      exited = true
    } catch (err) {
      errors.push(err)
      for (const capture of captures) {
        try {
          capture.abort()
        } catch (err) {
          errors.push(err)
        }
      }
    } finally {
      try {
        if (!exited) current?.terminate()
        if (worker === current) worker = undefined
      } catch (err) {
        errors.push(err)
      }
      if (drained) errors.push(...closeExportOwners(sequences))
      if (!drained && sequences.size)
        errors.push(new Error("Session export sequencers retained because capture bodies have not settled"))
      if (errors.length) {
        refused = true
        setKillSwitch(true, "session_export_shutdown_unconfirmed")
      }
      if (errors.length === 0) {
        instances.clear()
        shared = undefined
        attempts = 0
      }
      stopping = false
    }
    if (errors.length) throw exportFailure(errors)
  })
  closing = task
  return closing
}

function forget(previous: Instance | undefined): void {
  if (!previous) return
  previous.unsubscribe()
  previous.options.sequencer?.close()
  for (const [id, owner] of sequences) if (owner === previous.options.sequencer) sequences.delete(id)
}

function fail(err: unknown): never {
  const errors: unknown[] = [err]
  try {
    worker?.terminate()
    worker = undefined
  } catch (err) {
    errors.push(err)
  }
  for (const item of instances.values()) {
    try {
      item.unsubscribe()
    } catch (err) {
      errors.push(err)
    }
    try {
      item.capture.abort()
    } catch (err) {
      errors.push(err)
    }
  }
  if ([...instances.values()].some((item) => item.capture.busy()))
    errors.push(new Error("Session export sequencers retained because capture bodies have not settled"))
  else errors.push(...closeExportOwners(sequences))
  if (errors.length > 1) {
    refused = true
    setKillSwitch(true, "session_export_shutdown_unconfirmed")
    throw exportFailure(errors)
  }
  instances.clear()
  shared = undefined
  throw err
}

function target(): WorkerTarget {
  if (typeof KILO_SESSION_EXPORT_WORKER_PATH !== "undefined") return KILO_SESSION_EXPORT_WORKER_PATH
  return new URL("./worker.ts", import.meta.url)
}

function spawn(url = target()): void {
  if (!shared) return
  worker = shared.createWorker(url)
  const identity = Identity.spawn(run)
  identities.set(worker, identity)
  worker.postMessage({
    kind: "init",
    dbPath: shared.dbPath,
    agentVersion: shared.agentVersion,
    endpoint: shared.endpoint,
    surface: shared.surface,
    anonId: shared.anonId,
    identity,
  })
  for (const item of [...instances.values()]) configure(item.options)
  if (instances.size === 0) configure(shared)
}

function configure(options: Opts): void {
  if (!worker || stopping || refused) return
  instances.get(options.workspaceKey)?.unsubscribe()
  const capture = new Capture({
    worker,
    agentVersion: options.agentVersion,
    nowMs: () => Date.now(),
    syncSeq: options.syncSeq,
    onPostError: respawn,
    snapshotProvider: options.snapshotProvider,
  })
  const subscriber = new SyncSubscriber({
    isEligibleSession: (sessionId) => capture.hasEligibleSession(sessionId),
    dispatch: (event) => capture.dispatchRaw(event),
    agentVersion: options.agentVersion,
    now: () => Date.now(),
    syncSeq: options.syncSeq,
    getTurnId: (sessionId) => capture.turnId(sessionId),
    getRootSessionId: (sessionId) => capture.rootSessionId(sessionId),
  })
  const unsubscribe = options.subscribeAll((event) => subscriber.onSyncEvent(event as never))
  instances.set(options.workspaceKey, { options, capture, subscriber, unsubscribe })
  worker.onmessage = (event: MessageEvent) => {
    const msg = event.data as { kind?: string; sessionId?: string; reason?: string; name?: string }
    if (msg.kind === "pressure" && msg.sessionId) {
      for (const item of instances.values()) item.capture.markDegraded(msg.sessionId!)
    }
    if (msg.kind === "kill_switch") setKillSwitch(true, msg.reason ?? "worker")
  }
  worker.onerror = (event: ErrorEvent) => {
    console.warn("[session-export] worker error", event.message)
    respawn(event.error ?? event.message)
  }
}

function currentSurface(): string {
  return process.env.KILOCODE_FEATURE?.trim() || "unknown"
}

function respawn(err: unknown): void {
  if (stopping || refused) return
  console.warn("[session-export] worker respawn", err)
  worker?.terminate()
  worker = undefined
  attempts++
  if (attempts > maxRespawns) {
    setKillSwitch(true, "worker_respawn_failed")
    return
  }
  spawn()
}

function captureFor(key: string | undefined): Capture | undefined {
  if (stopping || refused) return undefined
  if (key) return instances.get(key)?.capture
  return instances.get("default")?.capture ?? instances.values().next().value?.capture
}
