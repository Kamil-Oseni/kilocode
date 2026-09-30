import { createHash } from "node:crypto"
import type { ComputerUseLease } from "../services/computer-use/lease-store"
import type { DesktopCaptureMetrics } from "../services/computer-use/desktop-capture-metrics"

type Timing = ReturnType<DesktopCaptureMetrics["snapshot"]>
type Trial = {
  lease(): ComputerUseLease | undefined
  ready(): boolean
  connected(): boolean
  manual(): boolean
  concurrent: { path: "native" | "powershell_fallback" | "stopped"; pid: number | null }
  onLease(listener: () => void): () => void
  onConnection(listener: () => void): () => void
  onState(listener: () => void): () => void
  load(signal: AbortSignal): Promise<{ path: string; sha256: string }>
  open(
    lease: ComputerUseLease,
    failed: () => void,
    valid: () => boolean,
  ): {
    timing(signal: AbortSignal, windowMs: number): Promise<Timing>
    pid(): number | undefined
    stop(): void
  }
  signal?: AbortSignal
}

function eligible(lease: ComputerUseLease | undefined) {
  if (!lease || lease.state !== "active" || lease.level !== "observe" || lease.lifetime.kind !== "session") return false
  if (lease.expiry.kind === "expires_at" && lease.expiry.expiresAt <= Date.now()) return false
  if (lease.applications.kind !== "selected" || lease.applications.values.length !== 1 || lease.monitors.kind !== "all")
    return false
  const window = lease.applications.values[0]!
  const identity = lease.applications.identities[window] ?? lease.applications.identity
  return (
    /^0x[0-9A-F]{1,16}$/.test(window) &&
    BigInt(window) !== 0n &&
    /^[0-9A-F]{64}$/.test(identity ?? "") &&
    lease.surfaces.includes("desktop") &&
    lease.actions.includes("observe")
  )
}

function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const abort = () => reject(new Error("Native capture trial stopped"))
  let reject!: (error: Error) => void
  return new Promise<T>((resolve, failure) => {
    reject = failure
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    work.then(resolve, failure)
  }).finally(() => signal.removeEventListener("abort", abort))
}

function evidence(lease: ComputerUseLease, binary: { path: string; sha256: string }, pid?: number) {
  const window = lease.applications.kind === "selected" ? lease.applications.values[0] : undefined
  return {
    path: "native_selected_window",
    binary: binary.path,
    sha256: binary.sha256,
    pid: pid ?? null,
    grantHash: createHash("sha256").update(lease.id).digest("hex"),
    windowID: window,
    identity:
      lease.applications.kind === "selected" && window
        ? (lease.applications.identities[window] ?? lease.applications.identity)
        : undefined,
    stop: "requested",
  }
}

function available(input: Trial, lease: ComputerUseLease | undefined) {
  return eligible(lease) && input.ready() && input.connected() && !input.manual()
}

function valid(input: Trial, snapshot: string, signal: AbortSignal) {
  const lease = input.lease()
  return !signal.aborted && available(input, lease) && JSON.stringify(lease) === snapshot
}

function result(timing: Timing, identity: ReturnType<typeof evidence>, reason: string | undefined, allowed: boolean) {
  if (!allowed) return { status: "cancelled", reason: reason ?? "authority_changed", source: identity }
  if (!timing) return { status: "unavailable", reason: reason ?? "no_timing", source: identity }
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid! <= 0 ||
    !timing.eventCount ||
    timing.failures ||
    timing.invalidSamples ||
    timing.restarts
  )
    return { status: "unavailable", reason: "unproven_timing", source: identity, timing }
  return { status: "complete", source: identity, timing }
}

/** A host-local capture trial uses a pre-existing grant and never authorizes input. */
export async function nativeCaptureTrial(input: Trial, duration = 60_000) {
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 60_000)
    throw new Error("Native capture trial duration is invalid")
  const base = {
    format: "raya.native-capture-trial",
    version: 1,
    releaseGateEligible: false,
    windowMs: duration,
    concurrentCapture: input.concurrent,
  }
  const started = performance.now()
  const lease = input.lease()
  if (!available(input, lease))
    return { ...base, status: "unavailable", reason: "active_selected_observe_session_required" }
  const controller = new AbortController()
  const snapshot = JSON.stringify(lease)
  let reason: string | undefined
  let source: ReturnType<Trial["open"]> | undefined
  let identity: ReturnType<typeof evidence> | undefined
  const allowed = () => valid(input, snapshot, controller.signal)
  const stop = (code: string) => {
    reason ??= code
    controller.abort()
    source?.stop()
  }
  const check = () => {
    if (!allowed()) stop("authority_changed")
  }
  const off = [input.onLease(check), input.onConnection(check), input.onState(check)]
  const abort = () => stop("cancelled")
  input.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => stop("deadline"), duration)
  const expiry =
    lease!.expiry.kind === "expires_at"
      ? setTimeout(() => stop("authority_expired"), Math.max(0, lease!.expiry.expiresAt - Date.now()))
      : undefined
  try {
    if (input.signal?.aborted) abort()
    check()
    if (!allowed()) return { ...base, status: "cancelled", reason }
    const binary = await wait(input.load(controller.signal), controller.signal)
    if (!allowed()) return { ...base, status: "cancelled", reason: reason ?? "authority_changed" }
    source = input.open(lease!, () => stop("capture_failed"), allowed)
    const pid = source.pid()
    identity = evidence(lease!, binary, pid)
    const window = Math.max(1, duration - (performance.now() - started) - Math.min(50, duration / 4))
    const timing = await wait(source.timing(controller.signal, window), controller.signal)
    identity = evidence(lease!, binary, source.pid())
    const outcome = result(timing, identity, reason, allowed())
    source.stop()
    return { ...base, ...outcome }
  } catch {
    return {
      ...base,
      status: "unavailable",
      reason: reason ?? "capture_unavailable",
      ...(identity ? { source: identity } : {}),
    }
  } finally {
    controller.abort()
    source?.stop()
    clearTimeout(timer)
    if (expiry) clearTimeout(expiry)
    for (const dispose of off) dispose()
    input.signal?.removeEventListener("abort", abort)
  }
}
